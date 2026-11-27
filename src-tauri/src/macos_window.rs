//! Native macOS `NSWindow` chrome adjustments, system-locale detection, and
//! window-modal native panel helpers (`NSOpenPanel` / `NSSavePanel`).
//!
//! Enlarges classic pre-Liquid-Glass `12×12pt` traffic light controls (shown on
//! macOS 12–15 and on macOS 26/27 when `UIDesignRequiresCompatibility` is set)
//! to `14×14pt` centered inside the `32px` transparent overlay titlebar, while
//! preserving all native AppKit hover glyphs, green-button tiling menus, and
//! fullscreen transitions. Also attaches WKWebView file-upload panels, folder
//! pickers, and image save panels as window-modal sheets centered on the main
//! `NSWindow`.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::mpsc;

type PathPanelCallback = unsafe extern "C" fn(*mut c_void, *const c_char);

extern "C" {
    fn pi_n_macos_configure_traffic_lights(ns_window_ptr: *mut c_void);
    fn pi_n_macos_configure_webview_open_panel(wk_webview_ptr: *mut c_void);
    fn pi_n_macos_is_main_thread() -> bool;
    fn pi_n_macos_preferred_menu_language() -> c_int;
    fn pi_n_macos_begin_save_image_panel(
        ns_window_ptr: *mut c_void,
        default_name: *const c_char,
        default_dir: *const c_char,
        context: *mut c_void,
        callback: PathPanelCallback,
    );
    fn pi_n_macos_begin_pick_folder_panel(
        ns_window_ptr: *mut c_void,
        prompt: *const c_char,
        context: *mut c_void,
        callback: PathPanelCallback,
    );
}

unsafe extern "C" fn path_panel_complete(context: *mut c_void, path_utf8: *const c_char) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if context.is_null() {
            return;
        }
        let tx = Box::from_raw(context as *mut mpsc::SyncSender<Option<PathBuf>>);
        let path = if path_utf8.is_null() {
            None
        } else {
            CStr::from_ptr(path_utf8)
                .to_str()
                .ok()
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
        };
        let _ = tx.send(path);
    }));
}

fn cstring_stripped_nul(raw: &str) -> Option<CString> {
    let clean = raw.replace('\0', "");
    let trimmed = clean.trim();
    if trimmed.is_empty() {
        return None;
    }
    CString::new(trimmed).ok()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacosMenuLanguage {
    English,
    SimplifiedChinese,
    TraditionalChinese,
}

/// Maps the native Objective-C preferred-language code to `MacosMenuLanguage`.
pub fn preferred_menu_language() -> MacosMenuLanguage {
    match unsafe { pi_n_macos_preferred_menu_language() } {
        1 => MacosMenuLanguage::SimplifiedChinese,
        2 => MacosMenuLanguage::TraditionalChinese,
        _ => MacosMenuLanguage::English,
    }
}

/// Attaches the native traffic-light layout controller and window-modal
/// file-upload sheet handler to the main macOS window.
pub fn configure_main_window<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    if let Ok(ns_window) = window.ns_window() {
        unsafe {
            pi_n_macos_configure_traffic_lights(ns_window);
        }
    } else {
        eprintln!(
            "[Pi^n-desktop] Warning: failed to get macOS NSWindow handle for traffic-light sizing"
        );
    }

    if let Err(error) = window.with_webview(|webview| unsafe {
        pi_n_macos_configure_webview_open_panel(webview.inner());
    }) {
        eprintln!(
            "[Pi^n-desktop] Warning: failed to configure macOS WebView open-panel sheet: {error}"
        );
    }
}

/// Opens macOS's native `NSSavePanel` as a window-modal sheet centered on
/// `window` so the user can pick a destination path for saving an image.
/// Must be called from a background thread (never the main thread).
/// Returns `None` if cancelled.
pub fn choose_save_image_path<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    default_name: &str,
    default_dir: Option<&Path>,
) -> Option<PathBuf> {
    if unsafe { pi_n_macos_is_main_thread() } {
        eprintln!(
            "[Pi^n-desktop] Refusing to block the macOS main thread waiting on NSSavePanel"
        );
        return None;
    }
    let (tx, rx) = mpsc::sync_channel::<Option<PathBuf>>(1);
    let name_c = cstring_stripped_nul(default_name);
    let dir_c = default_dir
        .and_then(|dir| dir.to_str())
        .and_then(|dir| CString::new(dir).ok());
    let win = window.clone();
    if window
        .run_on_main_thread(move || {
            let ns_window = win.ns_window().unwrap_or(std::ptr::null_mut());
            let ctx = Box::into_raw(Box::new(tx)) as *mut c_void;
            unsafe {
                pi_n_macos_begin_save_image_panel(
                    ns_window,
                    name_c.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
                    dir_c.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
                    ctx,
                    path_panel_complete,
                );
            }
        })
        .is_err()
    {
        return None;
    }
    rx.recv().ok().flatten()
}

/// Opens macOS's native `NSOpenPanel` (directories only) as a window-modal
/// sheet centered on `window`. Must be called from a background thread (never
/// the main thread). Returns `None` if cancelled.
pub fn pick_folder<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    prompt: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    if unsafe { pi_n_macos_is_main_thread() } {
        return Err("macOS folder picker must not be invoked on the main thread".to_string());
    }
    let (tx, rx) = mpsc::sync_channel::<Option<PathBuf>>(1);
    let prompt_c = prompt.and_then(cstring_stripped_nul);
    let win = window.clone();
    window
        .run_on_main_thread(move || {
            let ns_window = win.ns_window().unwrap_or(std::ptr::null_mut());
            let ctx = Box::into_raw(Box::new(tx)) as *mut c_void;
            unsafe {
                pi_n_macos_begin_pick_folder_panel(
                    ns_window,
                    prompt_c.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
                    ctx,
                    path_panel_complete,
                );
            }
        })
        .map_err(|error| format!("macOS folder picker is unavailable: {error}"))?;
    Ok(rx.recv().ok().flatten())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configure_handles_ignore_null_pointers() {
        unsafe {
            pi_n_macos_configure_traffic_lights(std::ptr::null_mut());
            pi_n_macos_configure_webview_open_panel(std::ptr::null_mut());
        }
    }

    #[test]
    fn preferred_menu_language_returns_valid_variant() {
        let lang = preferred_menu_language();
        assert!(matches!(
            lang,
            MacosMenuLanguage::English
                | MacosMenuLanguage::SimplifiedChinese
                | MacosMenuLanguage::TraditionalChinese
        ));
    }

    #[test]
    fn panel_helpers_strip_nul_and_handle_null_callback_context() {
        assert_eq!(
            cstring_stripped_nul("  Pick\0 folder  ").unwrap().to_str().unwrap(),
            "Pick folder"
        );
        assert!(cstring_stripped_nul("  \0  ").is_none());

        unsafe {
            path_panel_complete(std::ptr::null_mut(), std::ptr::null());
        }

        let (tx, rx) = mpsc::sync_channel::<Option<PathBuf>>(1);
        let ctx = Box::into_raw(Box::new(tx)) as *mut c_void;
        let path_c = CString::new("/tmp/pi-n-folder").unwrap();
        unsafe {
            path_panel_complete(ctx, path_c.as_ptr());
        }
        assert_eq!(rx.recv().unwrap(), Some(PathBuf::from("/tmp/pi-n-folder")));

        let on_worker = std::thread::spawn(|| unsafe { pi_n_macos_is_main_thread() })
            .join()
            .unwrap();
        assert!(!on_worker);
    }
}
