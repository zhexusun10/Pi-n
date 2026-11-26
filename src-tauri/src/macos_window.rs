//! Native macOS `NSWindow` chrome adjustments, system-locale detection, and
//! native save-panel helpers.
//!
//! Enlarges classic pre-Liquid-Glass `12×12pt` traffic light controls (shown on
//! macOS 12–15 and on macOS 26/27 when `UIDesignRequiresCompatibility` is set)
//! to `14×14pt` centered inside the `32px` transparent overlay titlebar, while
//! preserving all native AppKit hover glyphs, green-button tiling menus, and
//! fullscreen transitions.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::{Path, PathBuf};

extern "C" {
    fn pi_n_macos_configure_traffic_lights(ns_window_ptr: *mut c_void);
    fn pi_n_macos_preferred_menu_language() -> c_int;
    fn pi_n_macos_choose_save_image_path(
        default_name: *const c_char,
        default_dir: *const c_char,
    ) -> *mut c_char;
    fn pi_n_macos_free_c_string(ptr: *mut c_char);
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

/// Attaches the native traffic-light layout controller to the main macOS window.
pub fn configure_main_window<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let Ok(ns_window) = window.ns_window() else {
        eprintln!(
            "[Pi^n-desktop] Warning: failed to get macOS NSWindow handle for traffic-light sizing"
        );
        return;
    };
    unsafe {
        pi_n_macos_configure_traffic_lights(ns_window);
    }
}

/// Opens macOS's native `NSSavePanel` on the main thread so the user can pick a
/// destination path for saving an image. Returns `None` if cancelled.
pub fn choose_save_image_path(default_name: &str, default_dir: Option<&Path>) -> Option<PathBuf> {
    let name_c = CString::new(default_name).ok();
    let dir_c = default_dir
        .and_then(|dir| dir.to_str())
        .and_then(|dir| CString::new(dir).ok());
    let ptr = unsafe {
        pi_n_macos_choose_save_image_path(
            name_c.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
            dir_c.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
        )
    };
    if ptr.is_null() {
        return None;
    }
    let result = unsafe { CStr::from_ptr(ptr) }
        .to_str()
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    unsafe {
        pi_n_macos_free_c_string(ptr);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configure_traffic_lights_ignores_null_window_handle() {
        unsafe {
            pi_n_macos_configure_traffic_lights(std::ptr::null_mut());
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
}
