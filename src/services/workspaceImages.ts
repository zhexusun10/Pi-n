const SAFE_INLINE_IMAGE_DATA_URL_RE =
  /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp|avif|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/=\s]+$/i;

const WINDOWS_DRIVE_RE = /^[a-zA-Z]:(?:[\\/]|%5c|%2f)/i;
const URI_SCHEME_RE = /^[a-z][a-z\d+.-]*:/i;

export function isSafeInlineImageDataUrl(source: string): boolean {
  return SAFE_INLINE_IMAGE_DATA_URL_RE.test(source.trim());
}

function validateSegments(parts: string[], allowParent: boolean): boolean {
  if (parts.length === 0) return false;
  let hasNonParent = false;
  for (const part of parts) {
    if (!part || part === "." || /^(?:\.git|\.pi-n)$/i.test(part)) return false;
    if (part === "..") {
      if (!allowParent) return false;
    } else {
      hasNonParent = true;
    }
  }
  return hasNonParent;
}

/** A model's local image target can be a workspace-relative path (including `.tmp/`
 * and `../` outside the workspace), a home-relative `~/...` path, a `/tmp/` path,
 * or a local absolute filesystem path (Unix or Windows, optionally via `file://`).
 * App API routes, protocol-relative URLs, remote `file://` hosts, and unsafe
 * schemes are always rejected. */
export function workspaceImagePath(source: string): string | undefined {
  if (!source) return;
  const clean = source.split(/[?#]/, 1)[0];
  if (!clean || clean.startsWith("//") || clean.startsWith("\\")) return;

  let candidate = clean;
  if (/^file:\/\//i.test(candidate)) {
    let afterScheme = candidate.slice("file://".length);
    if (/^localhost\//i.test(afterScheme)) {
      afterScheme = afterScheme.slice("localhost".length);
    } else if (!afterScheme.startsWith("/")) {
      // Reject remote hosts such as file://evil.test/tmp/a.png.
      return;
    }
    // Windows file URI: file:///C:/Users/foo.png -> C:/Users/foo.png
    if (/^\/[a-zA-Z]:[\\/]/.test(afterScheme)) {
      afterScheme = afterScheme.slice(1);
    }
    candidate = afterScheme;
  } else if (URI_SCHEME_RE.test(candidate) && !WINDOWS_DRIVE_RE.test(candidate)) {
    return;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(candidate).replace(/\\/g, "/");
  } catch {
    return;
  }
  if (!decoded || /[\x00-\x1f\x7f]/.test(decoded)) return;

  // Windows absolute path: C:/Users/name/image.png
  if (/^[a-zA-Z]:\//.test(decoded)) {
    const drive = decoded[0].toUpperCase();
    const rest = decoded.slice(3);
    if (!rest || rest.includes(":")) return;
    const parts = rest.split("/");
    if (!validateSegments(parts, false)) return;
    return `${drive}:/${rest}`;
  }

  // Home-relative path: ~/Desktop/image.png
  if (decoded === "~") return;
  if (decoded.startsWith("~/")) {
    const rest = decoded.slice(2);
    if (!rest || rest.includes(":")) return;
    const parts = rest.split("/");
    if (!validateSegments(parts, false)) return;
    return `~/${rest}`;
  }

  // Unix absolute path: /tmp/..., /private/tmp/..., /Users/.../image.png
  if (decoded.startsWith("/")) {
    if (/^\/api(?:\/|$)/i.test(decoded)) return;
    if (decoded.includes(":")) return;
    const normalized = decoded.startsWith("/private/tmp/")
      ? `/tmp/${decoded.slice("/private/tmp/".length)}`
      : decoded;
    const rest = normalized.slice(1);
    if (!rest) return;
    const parts = rest.split("/");
    if (!validateSegments(parts, false)) return;
    return `/${rest}`;
  }

  // Relative path (workspace-relative or parent-relative like ../other/img.png)
  if (decoded.includes(":")) return;
  let relative = decoded;
  while (relative.startsWith("./")) relative = relative.slice(2);
  if (!relative) return;
  const parts = relative.split("/");
  if (!validateSegments(parts, true)) return;
  return relative;
}
