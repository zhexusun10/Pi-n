//! Native macOS `NSWindow` chrome adjustments.
//!
//! Enlarges classic pre-Liquid-Glass `12×12pt` traffic light controls (shown on
//! macOS 12–15 and on macOS 26/27 when `UIDesignRequiresCompatibility` is set)
//! to `14×14pt` centered inside the `32px` transparent overlay titlebar, while
//! preserving all native AppKit hover glyphs, green-button tiling menus, and
//! fullscreen transitions.

use std::ffi::c_void;

extern "C" {
    fn pi_n_macos_configure_traffic_lights(ns_window_ptr: *mut c_void);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configure_traffic_lights_ignores_null_window_handle() {
        unsafe {
            pi_n_macos_configure_traffic_lights(std::ptr::null_mut());
        }
    }
}
