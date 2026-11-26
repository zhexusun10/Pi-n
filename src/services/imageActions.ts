import { isMacosPlatform, isMacosTauriDesktop, isTauriDesktop } from "./apiBase";
import {
  getCachedOriginalImageUrl,
  getRegisteredImageBlob,
  loadOriginalImageUrl,
} from "./originalImagePreview";

type TauriInvoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

interface TauriRuntimeGlobal {
  __TAURI_INTERNALS__?: { invoke?: TauriInvoke };
  __TAURI__?: { core?: { invoke?: TauriInvoke } };
}

export interface ImageActionTarget {
  src: string;
  originalPath?: string;
  runId?: string;
  sessionOriginalKey?: string;
  workspacePath?: string;
  name?: string;
  alt?: string;
}

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/svg+xml": "svg",
};

const KNOWN_IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico", "svg",
]);

function getTauriInvoke(): TauriInvoke | null {
  if (typeof globalThis === "undefined") return null;
  const host = globalThis as unknown as TauriRuntimeGlobal;
  if (typeof host.__TAURI_INTERNALS__?.invoke === "function") {
    return host.__TAURI_INTERNALS__.invoke.bind(host.__TAURI_INTERNALS__);
  }
  if (typeof host.__TAURI__?.core?.invoke === "function") {
    return host.__TAURI__.core.invoke.bind(host.__TAURI__.core);
  }
  return null;
}

export { isMacosPlatform };

export function canSaveImageAs(): boolean {
  return isMacosTauriDesktop();
}

export function suggestImageFilename(options: {
  workspacePath?: string;
  name?: string;
  alt?: string;
  mimeType?: string;
}): string {
  const mime = (options.mimeType || "").split(";", 1)[0].trim().toLowerCase();
  const ext = MIME_TO_EXT[mime] || "png";
  const rawCandidate =
    options.name?.trim() ||
    options.workspacePath?.trim().split(/[\\/]/).pop()?.trim() ||
    options.alt?.trim() ||
    "";
  const sanitized = rawCandidate
    .replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, "")
    .replace(/^\.+|\.+$/g, "")
    .trim();
  if (!sanitized) {
    return `image.${ext}`;
  }
  const dot = sanitized.lastIndexOf(".");
  if (dot > 0) {
    const stem = sanitized.slice(0, dot).slice(0, 110);
    const existingExt = sanitized.slice(dot + 1).toLowerCase();
    if (
      existingExt === ext ||
      (ext === "jpg" && existingExt === "jpeg") ||
      (!options.mimeType && KNOWN_IMAGE_EXTS.has(existingExt))
    ) {
      return `${stem}.${existingExt}`;
    }
    if (KNOWN_IMAGE_EXTS.has(existingExt)) {
      return `${stem}.${ext}`;
    }
  }
  return `${sanitized.slice(0, 110)}.${ext}`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x4000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function decodeDataUrlToBlob(dataUrl: string): Blob | null {
  const trimmed = dataUrl.trim();
  if (!/^data:/i.test(trimmed)) return null;
  const comma = trimmed.indexOf(",");
  if (comma < 0) return null;
  const header = trimmed.slice(5, comma);
  const payload = trimmed.slice(comma + 1);
  const parts = header.split(";").map((part) => part.trim()).filter(Boolean);
  const isBase64 = parts.length > 0 && parts[parts.length - 1].toLowerCase() === "base64";
  const mime = (parts[0] && parts[0].toLowerCase() !== "base64" ? parts[0] : "application/octet-stream");
  if (isBase64) {
    const binary = atob(payload.replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(payload)], { type: mime });
}

async function resolveTargetSrc(target: ImageActionTarget): Promise<string> {
  if (target.originalPath || target.sessionOriginalKey) {
    const cached = getCachedOriginalImageUrl({
      originalPath: target.originalPath,
      runId: target.runId,
      sessionOriginalKey: target.sessionOriginalKey,
    });
    if (cached) return cached;
    const loaded = await loadOriginalImageUrl({
      originalPath: target.originalPath,
      runId: target.runId,
      sessionOriginalKey: target.sessionOriginalKey,
    }).catch(() => null);
    if (loaded) return loaded;
  }
  return target.src;
}

async function resolveImageBlob(src: string): Promise<Blob> {
  const registered = getRegisteredImageBlob(src);
  if (registered) {
    return registered;
  }
  const decodedData = decodeDataUrlToBlob(src);
  if (decodedData) {
    return decodedData;
  }
  const response = await fetch(src);
  if (!response.ok) {
    throw new Error(`Failed to read image (${response.status})`);
  }
  return response.blob();
}

async function resolveDesktopPayload(target: ImageActionTarget): Promise<{
  dataBase64: string;
  filename: string;
  blob: Blob;
}> {
  const effectiveSrc = await resolveTargetSrc(target);
  const blob = await resolveImageBlob(effectiveSrc);
  const dataBase64 = arrayBufferToBase64(await blob.arrayBuffer());
  const filename = suggestImageFilename({
    workspacePath: target.workspacePath,
    name: target.name,
    alt: target.alt,
    mimeType: blob.type || undefined,
  });
  return { dataBase64, filename, blob };
}

function triggerBrowserDownload(blob: Blob, filename: string): void {
  if (typeof document === "undefined" || typeof URL === "undefined") return;
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  }
}

export async function downloadImage(target: ImageActionTarget): Promise<string | null> {
  const { dataBase64, filename, blob } = await resolveDesktopPayload(target);
  if (isTauriDesktop()) {
    const invoke = getTauriInvoke();
    if (invoke) {
      return invoke<string | null>("save_desktop_image", {
        dataBase64,
        filename,
        prompt: false,
      });
    }
  }
  triggerBrowserDownload(blob, filename);
  return filename;
}

export async function saveImageAs(target: ImageActionTarget): Promise<string | null> {
  if (canSaveImageAs()) {
    const invoke = getTauriInvoke();
    if (invoke) {
      const { dataBase64, filename } = await resolveDesktopPayload(target);
      return invoke<string | null>("save_desktop_image", {
        dataBase64,
        filename,
        prompt: true,
      });
    }
  }
  return downloadImage(target);
}

export async function openImageInNewWindow(target: ImageActionTarget): Promise<void> {
  if (isTauriDesktop()) {
    const invoke = getTauriInvoke();
    if (invoke) {
      const { dataBase64, filename } = await resolveDesktopPayload(target);
      await invoke("open_desktop_image", { dataBase64, filename });
      return;
    }
  }
  if (typeof window === "undefined") return;
  const effectiveSrc = await resolveTargetSrc(target);
  const blob = await resolveImageBlob(effectiveSrc);
  const objectUrl = URL.createObjectURL(blob);
  const opened = window.open(objectUrl, "_blank", "noopener,noreferrer");
  if (!opened) {
    URL.revokeObjectURL(objectUrl);
    return;
  }
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

async function blobToPngBlob(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Failed to decode image for clipboard"));
      el.src = objectUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width || 1;
    canvas.height = img.naturalHeight || img.height || 1;
    try {
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas context unavailable");
      ctx.drawImage(img, 0, 0);
      const pngBlob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (!pngBlob) throw new Error("PNG conversion failed");
      return pngBlob;
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function copyImageToClipboard(target: ImageActionTarget): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    return false;
  }
  try {
    const effectiveSrc = await resolveTargetSrc(target);
    const blob = await resolveImageBlob(effectiveSrc);
    const pngBlob = await blobToPngBlob(blob);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
    return true;
  } catch (error) {
    console.warn("Copy image failed:", error);
    return false;
  }
}
