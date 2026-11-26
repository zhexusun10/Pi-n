//! Read-only image previews for conversation workspaces and local filesystem paths.
//! All files are validated as regular files (<= 20 MiB) and verified by content
//! header/structure rather than trusting model-supplied extensions.
use super::{argument, open_file_context, open_file_roots, resolve_open_file_target, Service};
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_ATTACHMENT_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

fn system_temp_image_roots() -> Vec<PathBuf> {
    #[cfg(unix)]
    {
        vec![PathBuf::from("/tmp")]
    }
    #[cfg(windows)]
    {
        vec![std::env::temp_dir()]
    }
}

fn user_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn has_forbidden_segment(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(part) => {
            let text = part.to_string_lossy();
            text.eq_ignore_ascii_case(".git") || text.eq_ignore_ascii_case(".pi-n")
        }
        _ => false,
    })
}

fn validate_segments(path: &str, allow_parent: bool) -> Result<String, String> {
    if path.is_empty() || path.contains(':') || path.chars().any(char::is_control) {
        return Err("Invalid workspace image path".into());
    }
    let mut has_non_parent = false;
    for part in path.split('/') {
        if part.is_empty()
            || part == "."
            || part.eq_ignore_ascii_case(".git")
            || part.eq_ignore_ascii_case(".pi-n")
        {
            return Err("Invalid workspace image path".into());
        }
        if part == ".." {
            if !allow_parent {
                return Err("Invalid workspace image path".into());
            }
        } else {
            has_non_parent = true;
        }
    }
    if !has_non_parent {
        return Err("Invalid workspace image path".into());
    }
    Ok(path.to_string())
}

fn is_windows_drive_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
}

fn canonicalize_allowed_path(candidate: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(candidate).map_err(|error| error.to_string())?;
    if has_forbidden_segment(&canonical) {
        return Err("Invalid workspace image path".into());
    }
    Ok(canonical)
}

fn resolve_from_roots_allowing_outside(roots: &[PathBuf], relative: &str) -> Result<PathBuf, String> {
    let mut last_error: Option<String> = None;
    for root in roots {
        let candidate = root.join(relative);
        match canonicalize_allowed_path(&candidate) {
            Ok(canonical) => return Ok(canonical),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| "Workspace image not found".into()))
}

fn resolve_image_target(
    workspace_roots: &[PathBuf],
    temp_roots: &[PathBuf],
    raw_path: &str,
) -> Result<PathBuf, String> {
    if raw_path.is_empty() || raw_path.starts_with('\\') || raw_path.chars().any(char::is_control) {
        return Err("Invalid workspace image path".into());
    }
    let normalized = raw_path.replace('\\', "/");

    // 1. /tmp and /private/tmp paths resolve against temp_roots first (for deterministic
    //    cross-platform temp handling and test isolation).
    if let Some(rest) = normalized
        .strip_prefix("/tmp/")
        .or_else(|| normalized.strip_prefix("/private/tmp/"))
    {
        let relative = validate_segments(rest, false)?;
        return resolve_open_file_target(temp_roots, &relative)
            .or_else(|_| resolve_from_roots_allowing_outside(temp_roots, &relative));
    }

    // 2. Home-relative paths: ~/Desktop/screenshot.png
    if let Some(rest) = normalized.strip_prefix("~/") {
        let relative = validate_segments(rest, false)?;
        let home = user_home_dir().ok_or_else(|| "Home directory unavailable".to_string())?;
        return canonicalize_allowed_path(&home.join(relative));
    }

    // 3. Windows absolute drive path: C:/Users/name/screenshot.png
    if is_windows_drive_path(&normalized) {
        let rest = validate_segments(&normalized[3..], false)?;
        #[cfg(windows)]
        {
            let full = format!("{}:/{}", &normalized[0..1], rest);
            return canonicalize_allowed_path(Path::new(&full));
        }
        #[cfg(not(windows))]
        {
            let _ = rest;
            return Err("Invalid workspace image path".into());
        }
    }

    // 4. Unix absolute path outside workspace (e.g. /Users/name/Desktop/shot.png)
    if let Some(rest) = normalized.strip_prefix('/') {
        if rest.eq_ignore_ascii_case("api")
            || rest
                .get(..4)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("api/"))
        {
            return Err("Invalid workspace image path".into());
        }
        let validated = validate_segments(rest, false)?;
        let full = format!("/{validated}");
        return canonicalize_allowed_path(Path::new(&full));
    }

    // 5. Relative path (workspace-relative or parent-relative like ../other/shot.png)
    let mut relative = normalized.as_str();
    while let Some(stripped) = relative.strip_prefix("./") {
        relative = stripped;
    }
    let validated = validate_segments(relative, true)?;
    let has_parent = validated.split('/').any(|part| part == "..");
    if !has_parent {
        if let Ok(scoped) = resolve_open_file_target(workspace_roots, &validated) {
            return Ok(scoped);
        }
    }
    resolve_from_roots_allowing_outside(workspace_roots, &validated)
}

fn open_regular_file_limited(target: &Path, max_bytes: u64, limit_error: &str) -> Result<fs::File, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(target).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("Workspace image must be a regular file".into());
    }
    if metadata.len() > max_bytes {
        return Err(limit_error.into());
    }
    Ok(file)
}

fn open_regular_image_file(target: &Path) -> Result<fs::File, String> {
    open_regular_file_limited(target, MAX_IMAGE_BYTES, "Workspace image exceeds 20 MiB")
}

fn is_avif(bytes: &[u8]) -> bool {
    if bytes.len() < 12 || &bytes[4..8] != b"ftyp" {
        return false;
    }
    let major = &bytes[8..12];
    if major == b"avif" || major == b"avis" {
        return true;
    }
    let declared_size = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let box_end = if declared_size == 0 {
        bytes.len()
    } else {
        declared_size.min(bytes.len())
    };
    if box_end < 20 {
        return false;
    }
    bytes[16..box_end]
        .chunks_exact(4)
        .any(|brand| brand == b"avif" || brand == b"avis")
}

fn is_ico(bytes: &[u8]) -> bool {
    bytes.len() >= 6
        && bytes[0..4] == [0x00, 0x00, 0x01, 0x00]
        && u16::from_le_bytes([bytes[4], bytes[5]]) > 0
}

fn has_svg_event_handler(lower: &str) -> bool {
    let bytes = lower.as_bytes();
    let mut i = 0;
    while i + 4 < bytes.len() {
        if (bytes[i].is_ascii_whitespace() || bytes[i] == b'/')
            && bytes[i + 1] == b'o'
            && bytes[i + 2] == b'n'
            && bytes[i + 3].is_ascii_alphabetic()
        {
            let mut j = i + 4;
            while j < bytes.len() && bytes[j].is_ascii_alphabetic() {
                j += 1;
            }
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'=' {
                return true;
            }
        }
        i += 1;
    }
    false
}

fn has_external_svg_href(lower: &str) -> bool {
    let bytes = lower.as_bytes();
    let mut i = 0;
    while i + 5 < bytes.len() {
        if bytes[i..].starts_with(b"href") {
            let preceded_ok = i == 0
                || bytes[i - 1].is_ascii_whitespace()
                || bytes[i - 1] == b':'
                || bytes[i - 1] == b'/';
            if preceded_ok {
                let mut j = i + 4;
                while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                if j < bytes.len() && bytes[j] == b'=' {
                    j += 1;
                    while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                        j += 1;
                    }
                    if j < bytes.len() && (bytes[j] == b'"' || bytes[j] == b'\'') {
                        j += 1;
                        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                            j += 1;
                        }
                    }
                    // Only internal fragment references (#id) are allowed in static SVG previews.
                    if j < bytes.len() && bytes[j] != b'#' {
                        return true;
                    }
                }
            }
        }
        i += 1;
    }
    false
}

fn is_safe_svg(target: &Path, bytes: &[u8]) -> bool {
    let is_svg_ext = target
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("svg"));
    if !is_svg_ext {
        return false;
    }
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let mut rest = text.trim_start_matches('\u{feff}').trim_start();
    // Skip leading XML prolog, comments, and DOCTYPE declarations.
    loop {
        if let Some(after) = rest.strip_prefix("<?") {
            let Some(end) = after.find("?>") else {
                return false;
            };
            rest = after[end + 2..].trim_start();
        } else if let Some(after) = rest.strip_prefix("<!--") {
            let Some(end) = after.find("-->") else {
                return false;
            };
            rest = after[end + 3..].trim_start();
        } else if rest.len() >= 9 && rest[..9].eq_ignore_ascii_case("<!doctype") {
            let Some(end) = rest.find('>') else {
                return false;
            };
            rest = rest[end + 1..].trim_start();
        } else {
            break;
        }
    }
    if !(rest.len() >= 4
        && rest[..4].eq_ignore_ascii_case("<svg")
        && rest
            .as_bytes()
            .get(4)
            .is_some_and(|b| b.is_ascii_whitespace() || *b == b'>' || *b == b'/'))
    {
        return false;
    }
    let lower = rest.to_ascii_lowercase();
    for forbidden in [
        "<script",
        "</script",
        "<foreignobject",
        "<iframe",
        "<object",
        "<embed",
        "<applet",
        "<meta",
        "<link",
        "javascript:",
        "vbscript:",
        "data:text/html",
        "data:image/svg",
    ] {
        if lower.contains(forbidden) {
            return false;
        }
    }
    !has_svg_event_handler(&lower) && !has_external_svg_href(&lower)
}

fn detect_image_mime(target: &Path, bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else if is_avif(bytes) {
        Some("image/avif")
    } else if is_ico(bytes) {
        Some("image/x-icon")
    } else if is_safe_svg(target, bytes) {
        Some("image/svg+xml")
    } else {
        None
    }
}

fn read_image(
    workspace_roots: &[PathBuf],
    temp_roots: &[PathBuf],
    path: &str,
) -> Result<(Vec<u8>, &'static str), String> {
    let target = resolve_image_target(workspace_roots, temp_roots, path)?;
    let file = open_regular_image_file(&target)?;
    let mut bytes = Vec::new();
    file.take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("Workspace image exceeds 20 MiB".into());
    }
    let mime = detect_image_mime(&target, &bytes)
        .ok_or_else(|| "Unsupported workspace image format".to_string())?;
    Ok((bytes, mime))
}

fn detect_raster_attachment_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}

pub(super) fn get_attachment_image(
    service: &Arc<Service>,
    body: &serde_json::Value,
) -> Result<(Vec<u8>, &'static str), String> {
    let path: String = argument(body, "path")?;
    let run_id: Option<String> = argument(body, "runId")?;
    let root = {
        let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
        if let Some(id) = run_id.as_deref().filter(|id| !id.is_empty()) {
            if runtime.state.run_id != id {
                return Err("Run does not match service".into());
            }
        }
        runtime.root.clone()
    };
    let target = crate::attachment_inputs::resolve_managed_path(
        &root,
        run_id.as_deref().filter(|id| !id.is_empty()),
        &path,
    )?;
    let file = open_regular_file_limited(
        &target,
        MAX_ATTACHMENT_IMAGE_BYTES,
        "Attachment image exceeds 32 MiB",
    )?;
    let mut bytes = Vec::new();
    file.take(MAX_ATTACHMENT_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_ATTACHMENT_IMAGE_BYTES {
        return Err("Attachment image exceeds 32 MiB".into());
    }
    let mime = detect_raster_attachment_mime(&bytes)
        .ok_or_else(|| "Unsupported attachment image format".to_string())?;
    Ok((bytes, mime))
}

pub(super) fn get_workspace_image(
    service: &Arc<Service>,
    body: &serde_json::Value,
) -> Result<(Vec<u8>, &'static str), String> {
    let run_id: String = argument(body, "runId")?;
    if run_id.is_empty() {
        return Err("A Run ID is required for workspace images".into());
    }
    let path: String = argument(body, "path")?;
    let execution_id: Option<String> = argument(body, "executionId")?;
    let context = {
        let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
        if runtime.state.run_id != run_id {
            return Err("Run does not match service".into());
        }
        open_file_context(&runtime.state)
    };
    let scope = execution_id.map(|id| vec![id]);
    let roots = open_file_roots(&context, scope.as_deref(), &["planner".into()])?;
    let temp_roots = system_temp_image_roots();
    read_image(&roots, &temp_roots, &path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_images_require_run_and_execution_scope_and_fall_back_to_source() {
        use crate::{model::*, runtime::Runtime};
        use std::sync::{atomic::AtomicBool, Condvar, Mutex};
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let first = temp.path().join("first");
        let other = temp.path().join("other");
        for (root, text) in [(&source, "source"), (&first, "first"), (&other, "other")] {
            fs::create_dir(root).unwrap();
            fs::write(
                root.join("image.png"),
                [b"\x89PNG\r\n\x1a\n".as_slice(), text.as_bytes()].concat(),
            )
            .unwrap();
        }
        let mut runtime = Runtime::open(&temp.path().join("data")).unwrap();
        runtime.state.run_id = "image-run".into();
        runtime.state.config = Some(
            serde_json::from_value(serde_json::json!({
                "repository": source, "model": "test", "maxParallel": 1
            }))
            .unwrap(),
        );
        runtime.state.executions = [(&first, "first"), (&other, "other")]
            .into_iter()
            .map(|(root, id)| Execution {
                id: id.into(),
                node: id.into(),
                revision: 1,
                attempt: 1,
                session_id: id.into(),
                worktree: root.to_string_lossy().into(),
                before: String::new(),
                workspace_lineage: vec![],
                after: None,
                input: None,
                result: None,
                status: "completed".into(),
                output: String::new(),
                output_bytes: 0,
                pid: None,
                started_at: 1,
                completed_at: Some(2),
                metrics: None,
            })
            .collect();
        let service = Arc::new(Service {
            runtime: Mutex::new(runtime),
            driving: AtomicBool::new(false),
            drive_signal: (Mutex::new(0), Condvar::new()),
            planning: AtomicBool::new(false),
            extension: PathBuf::new(),
        });
        let body =
            serde_json::json!({ "runId": "image-run", "executionId": "first", "path": "image.png" });
        assert!(get_workspace_image(&service, &body)
            .unwrap()
            .0
            .ends_with(b"first"));
        fs::remove_file(first.join("image.png")).unwrap();
        assert!(
            get_workspace_image(&service, &body)
                .unwrap()
                .0
                .ends_with(b"source"),
            "do not substitute another node's image"
        );
        for body in [
            serde_json::json!({ "path": "image.png" }),
            serde_json::json!({ "runId": "wrong", "path": "image.png" }),
            serde_json::json!({ "runId": "image-run", "executionId": "unknown", "path": "image.png" }),
        ] {
            assert!(get_workspace_image(&service, &body).is_err());
        }

        // Exercise the binary HTTP response and the same JSON-POST admission
        // used by the rest of the local API (an <img> GET must not read files).
        use std::{io::Write, net::TcpStream, thread, time::Duration};
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let address = server.server_addr().to_ip().unwrap();
        let web_root = temp.path().to_path_buf();
        let worker = thread::spawn(move || {
            for _ in 0..2 {
                let request = server.recv().unwrap();
                super::super::handle_http_request(request, &service, &web_root, address.port());
            }
        });
        for method in ["POST", "GET"] {
            let mut socket = TcpStream::connect(address).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let input = if method == "POST" {
                body.to_string()
            } else {
                String::new()
            };
            write!(socket, "{method} /api/get_workspace_image HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{input}", input.len()).unwrap();
            let mut response = Vec::new();
            socket.read_to_end(&mut response).unwrap();
            let boundary = response
                .windows(4)
                .position(|bytes| bytes == b"\r\n\r\n")
                .unwrap();
            let headers = String::from_utf8_lossy(&response[..boundary]).to_lowercase();
            if method == "POST" {
                assert!(headers.starts_with("http/1.1 200"), "{headers}");
                assert!(headers.contains("content-type: image/png"));
                assert!(headers.contains("cache-control: no-store"));
                assert!(headers.contains("x-content-type-options: nosniff"));
                assert_eq!(&response[boundary + 4..], b"\x89PNG\r\n\x1a\nsource");
            } else {
                assert!(headers.starts_with("http/1.1 415"), "{headers}");
            }
        }
        worker.join().unwrap();
    }

    #[test]
    fn workspace_images_support_formats_outside_paths_and_reject_unsafe_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        let temp_root = temp.path().join("system-tmp");
        // Keep the absolute "outside" directory out of /tmp: on Linux the default temp dir is
        // /tmp, and /tmp/... paths are intentionally resolved against `temp_roots` instead.
        let outside_holder = tempfile::Builder::new()
            .prefix("pi-n-outside-image-")
            .tempdir_in(env!("CARGO_MANIFEST_DIR"))
            .unwrap();
        let outside_abs_dir = outside_holder.path().to_path_buf();
        let outside = temp.path().join("outside");
        fs::create_dir_all(root.join("artifacts/中文 space")).unwrap();
        fs::create_dir_all(root.join(".tmp")).unwrap();
        fs::create_dir_all(temp_root.join("sub")).unwrap();
        fs::create_dir_all(&outside).unwrap();

        let png = b"\x89PNG\r\n\x1a\npreview";
        let tmp_png = b"\x89PNG\r\n\x1a\ntmp-preview";
        let avif = b"\x00\x00\x00\x1cftypavif\x00\x00\x00\x00avifmif1miaf";
        let avif_compat = b"\x00\x00\x00\x1cftypmif1\x00\x00\x00\x00mif1avifmiaf";
        let ico = b"\x00\x00\x01\x00\x01\x00\x10\x10\x00\x00";
        let clean_svg =
            br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"/></defs><rect fill="url(#g)" width="10" height="10"/></svg>"#;

        fs::write(root.join("artifacts/中文 space/截图.png"), png).unwrap();
        fs::write(root.join(".tmp/card-preview.png"), png).unwrap();
        fs::write(root.join("photo.avif"), avif).unwrap();
        fs::write(root.join("compat.avif"), avif_compat).unwrap();
        fs::write(root.join("favicon.ico"), ico).unwrap();
        fs::write(root.join("diagram.svg"), clean_svg).unwrap();
        fs::write(temp_root.join("compacted-card-preview.png"), tmp_png).unwrap();
        fs::write(temp_root.join("sub/preview.png"), tmp_png).unwrap();
        fs::write(outside.join("external.png"), png).unwrap();
        fs::write(outside_abs_dir.join("external.png"), png).unwrap();
        fs::write(outside.join("secret.txt"), b"not an image").unwrap();

        let roots = vec![root.clone()];
        let temp_roots = vec![temp_root.clone()];

        assert_eq!(
            read_image(&roots, &temp_roots, "./artifacts/中文 space/截图.png").unwrap(),
            (png.to_vec(), "image/png")
        );
        assert_eq!(
            read_image(&roots, &temp_roots, ".tmp/card-preview.png").unwrap(),
            (png.to_vec(), "image/png")
        );
        assert_eq!(
            read_image(&roots, &temp_roots, "photo.avif").unwrap(),
            (avif.to_vec(), "image/avif")
        );
        assert_eq!(
            read_image(&roots, &temp_roots, "compat.avif").unwrap(),
            (avif_compat.to_vec(), "image/avif")
        );
        assert_eq!(
            read_image(&roots, &temp_roots, "favicon.ico").unwrap(),
            (ico.to_vec(), "image/x-icon")
        );
        assert_eq!(
            read_image(&roots, &temp_roots, "diagram.svg").unwrap(),
            (clean_svg.to_vec(), "image/svg+xml")
        );
        assert_eq!(
            read_image(&roots, &temp_roots, "/tmp/compacted-card-preview.png").unwrap(),
            (tmp_png.to_vec(), "image/png")
        );
        assert_eq!(
            read_image(&roots, &temp_roots, "/private/tmp/sub/preview.png").unwrap(),
            (tmp_png.to_vec(), "image/png")
        );

        // Outside-workspace images via parent traversal, symlink, or absolute path are allowed
        // when they are valid image files.
        assert_eq!(
            read_image(&roots, &temp_roots, "../outside/external.png").unwrap(),
            (png.to_vec(), "image/png")
        );
        let outside_abs = outside_abs_dir.join("external.png");
        assert_eq!(
            read_image(&roots, &temp_roots, &outside_abs.to_string_lossy()).unwrap(),
            (png.to_vec(), "image/png")
        );
        crate::path_safety::directory_link(&outside, &root.join("linked"));
        assert_eq!(
            read_image(&roots, &temp_roots, "linked/external.png").unwrap(),
            (png.to_vec(), "image/png")
        );

        // Non-image files outside the workspace are still rejected by content inspection.
        assert!(read_image(&roots, &temp_roots, "../outside/secret.txt").is_err());
        assert!(read_image(
            &roots,
            &temp_roots,
            &outside.join("secret.txt").to_string_lossy()
        )
        .is_err());

        // Workspace relative paths do not fall back to /tmp, and /tmp paths do not read workspace files.
        assert!(read_image(&roots, &temp_roots, "compacted-card-preview.png").is_err());
        assert!(read_image(&roots, &temp_roots, "/tmp/artifacts/中文 space/截图.png").is_err());

        for path in [
            "/api/control",
            "/tmp",
            "/tmp/",
            "/tmp/../outside.png",
            "/tmp/sub/../../outside.png",
            "/tmp//compacted-card-preview.png",
            "/tmp/a\\..\\outside.png",
            "/tmp/.git/image.png",
            "/tmp/.pi-n/image.png",
            "/tmp/image.png:stream",
            "\\tmp\\compacted-card-preview.png",
            ".git/image.png",
            ".PI-N/image.png",
            "image.png:stream",
            "missing.png",
            "artifacts",
        ] {
            assert!(read_image(&roots, &temp_roots, path).is_err(), "{path}");
        }

        // Malicious or disguised SVGs are rejected.
        fs::write(root.join("fake.png"), b"<svg onload='evil()'></svg>").unwrap();
        assert!(read_image(&roots, &temp_roots, "fake.png").is_err());
        fs::write(root.join("xss.svg"), b"<svg onload='evil()'></svg>").unwrap();
        assert!(read_image(&roots, &temp_roots, "xss.svg").is_err());
        fs::write(
            root.join("script.svg"),
            b"<svg><script>alert(1)</script></svg>",
        )
        .unwrap();
        assert!(read_image(&roots, &temp_roots, "script.svg").is_err());
        fs::write(
            root.join("ext.svg"),
            br#"<svg><image href="https://evil.test/x.png"/></svg>"#,
        )
        .unwrap();
        assert!(read_image(&roots, &temp_roots, "ext.svg").is_err());

        let large = fs::File::create(root.join("large.png")).unwrap();
        large.set_len(MAX_IMAGE_BYTES + 1).unwrap();
        assert!(read_image(&roots, &temp_roots, "large.png")
            .unwrap_err()
            .contains("20 MiB"));

        #[cfg(unix)]
        {
            let real_tmp_dir = tempfile::Builder::new()
                .prefix("pi-n-workspace-image-")
                .tempdir_in("/tmp")
                .unwrap();
            let dir_name = real_tmp_dir.path().file_name().unwrap().to_str().unwrap();
            fs::write(real_tmp_dir.path().join("real.png"), tmp_png).unwrap();
            let real_temp_roots = system_temp_image_roots();
            assert_eq!(
                read_image(&roots, &real_temp_roots, &format!("/tmp/{dir_name}/real.png")).unwrap(),
                (tmp_png.to_vec(), "image/png")
            );
            // Non-regular files (such as FIFOs) must fail closed without blocking.
            let fifo = real_tmp_dir.path().join("pipe.png");
            let c_fifo = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(c_fifo.as_ptr(), 0o600) }, 0);
            assert!(open_regular_image_file(&fifo).is_err());
            assert!(read_image(&roots, &real_temp_roots, &format!("/tmp/{dir_name}/pipe.png")).is_err());
        }
    }

    #[test]
    fn attachment_images_serve_managed_originals_and_reject_unsafe_paths_and_formats() {
        use crate::runtime::Runtime;
        use std::sync::{atomic::AtomicBool, Condvar, Mutex};

        let temp = tempfile::tempdir().unwrap();
        let data_root = temp.path().join(".pi-n");
        let run_id = uuid::Uuid::new_v4().to_string();
        let other_run = uuid::Uuid::new_v4().to_string();
        let attachment_id = uuid::Uuid::new_v4().to_string();
        let pre_run_id = uuid::Uuid::new_v4().to_string();
        let svg_id = uuid::Uuid::new_v4().to_string();

        let png = b"\x89PNG\r\n\x1a\noriginal-full-res-png";
        let webp = b"RIFF\x18\x00\x00\x00WEBPoriginal-webp";
        let svg = b"<svg xmlns='http://www.w3.org/2000/svg'></svg>";

        let run_png = crate::attachment_inputs::store(
            &data_root,
            Some(&run_id),
            &attachment_id,
            "retina.png",
            png,
        )
        .unwrap();
        let pre_run_webp =
            crate::attachment_inputs::store(&data_root, None, &pre_run_id, "draft.webp", webp)
                .unwrap();
        let run_svg = crate::attachment_inputs::store(
            &data_root,
            Some(&run_id),
            &svg_id,
            "vector.svg",
            svg,
        )
        .unwrap();

        let mut runtime = Runtime::open(&data_root).unwrap();
        runtime.state.run_id = run_id.clone();
        let service = Arc::new(Service {
            runtime: Mutex::new(runtime),
            driving: AtomicBool::new(false),
            drive_signal: (Mutex::new(0), Condvar::new()),
            planning: AtomicBool::new(false),
            extension: PathBuf::new(),
        });

        // Works even when data_root contains `.pi-n`, both with and without runId.
        let run_png_str = crate::attachment_inputs::display_path(&run_png);
        assert_eq!(
            get_attachment_image(&service, &serde_json::json!({ "path": run_png_str, "runId": run_id })).unwrap(),
            (png.to_vec(), "image/png")
        );
        assert_eq!(
            get_attachment_image(&service, &serde_json::json!({ "path": run_png_str })).unwrap(),
            (png.to_vec(), "image/png")
        );

        // Pre-run unscoped original image loads cleanly too.
        let pre_run_str = crate::attachment_inputs::display_path(&pre_run_webp);
        assert_eq!(
            get_attachment_image(&service, &serde_json::json!({ "path": pre_run_str })).unwrap(),
            (webp.to_vec(), "image/webp")
        );

        // Mismatched runId is rejected.
        let other_png = crate::attachment_inputs::store(
            &data_root,
            Some(&other_run),
            &uuid::Uuid::new_v4().to_string(),
            "other.png",
            png,
        )
        .unwrap();
        assert!(get_attachment_image(
            &service,
            &serde_json::json!({
                "path": crate::attachment_inputs::display_path(&other_png),
                "runId": run_id
            })
        )
        .is_err());

        // Non-raster attachments (SVG, arbitrary files) and paths outside attachment-inputs are rejected.
        assert!(get_attachment_image(
            &service,
            &serde_json::json!({ "path": crate::attachment_inputs::display_path(&run_svg) })
        )
        .is_err());
        let outside = temp.path().join("outside.png");
        fs::write(&outside, png).unwrap();
        assert!(get_attachment_image(
            &service,
            &serde_json::json!({ "path": outside.to_string_lossy() })
        )
        .is_err());
    }
}
