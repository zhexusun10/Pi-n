//! Window-centered dialog geometry helper and Windows native file/folder
//! picker centering.
//!
//! On Windows, `pick_folder` presents the modern Win32 `IFileOpenDialog`
//! (`FOS_PICKFOLDERS`) owned by the main Tauri `HWND` and centers it over the
//! main window before it becomes visible via a scoped thread-local `WH_CBT`
//! hook. For WebView2 `<input type="file">` pickers, a process-scoped
//! `EVENT_SYSTEM_DIALOGSTART` WinEvent hook (filtered to our own WebView2
//! browser PID and direct `GW_OWNER == main_hwnd`) centers `#32770` dialogs
//! over the main window as well.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// Computes the `(x, y)` origin that centers `dialog` inside `owner`, clamped
/// to `work_area` so the dialog never opens off-screen.
pub fn center_dialog_origin(
    owner: ScreenRect,
    dialog: ScreenRect,
    work_area: ScreenRect,
) -> (i32, i32) {
    let owner_left = owner.left as i64;
    let owner_top = owner.top as i64;
    let owner_w = (owner.right as i64 - owner_left).max(0);
    let owner_h = (owner.bottom as i64 - owner_top).max(0);
    let dialog_w = (dialog.right as i64 - dialog.left as i64).max(0);
    let dialog_h = (dialog.bottom as i64 - dialog.top as i64).max(0);
    let work_left = work_area.left as i64;
    let work_top = work_area.top as i64;
    let work_right = work_area.right as i64;
    let work_bottom = work_area.bottom as i64;

    let mut x = owner_left + (owner_w - dialog_w) / 2;
    let mut y = owner_top + (owner_h - dialog_h) / 2;

    let max_x = work_right - dialog_w;
    if max_x >= work_left {
        x = x.clamp(work_left, max_x);
    } else {
        x = work_left;
    }

    let max_y = work_bottom - dialog_h;
    if max_y >= work_top {
        y = y.clamp(work_top, max_y);
    } else {
        y = work_top;
    }

    (
        x.clamp(i32::MIN as i64, i32::MAX as i64) as i32,
        y.clamp(i32::MIN as i64, i32::MAX as i64) as i32,
    )
}

#[cfg(target_os = "windows")]
mod native {
    use super::{center_dialog_origin, ScreenRect};
    use std::cell::Cell;
    use std::ffi::{c_void, OsString};
    use std::os::windows::ffi::OsStringExt;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicIsize, Ordering};
    use windows::core::{HRESULT, PCWSTR};
    use windows::Win32::Foundation::{ERROR_CANCELLED, HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
    use windows::Win32::UI::Shell::{
        FileOpenDialog, IFileOpenDialog, FOS_FORCEFILESYSTEM, FOS_NOCHANGEDIR, FOS_PATHMUSTEXIST,
        FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetClassNameW, GetWindow, GetWindowRect, IsIconic, IsWindow,
        IsWindowVisible, SetWindowPos, SetWindowsHookExW, UnhookWindowsHookEx, CHILDID_SELF,
        EVENT_SYSTEM_DIALOGEND, EVENT_SYSTEM_DIALOGSTART, GW_OWNER, HCBT_ACTIVATE, HHOOK,
        OBJID_WINDOW, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, WH_CBT, WINEVENT_OUTOFCONTEXT,
    };

    #[derive(Clone, Copy)]
    struct CbtCenterState {
        owner_hwnd: isize,
        centered: bool,
    }

    thread_local! {
        static CBT_CENTER_STATE: Cell<Option<CbtCenterState>> = const { Cell::new(None) };
    }

    static WEBVIEW_MAIN_HWND: AtomicIsize = AtomicIsize::new(0);
    static WEBVIEW_EVENT_HOOK: AtomicIsize = AtomicIsize::new(0);
    static LAST_CENTERED_DIALOG_HWND: AtomicIsize = AtomicIsize::new(0);

    fn rect_to_screen(rect: RECT) -> ScreenRect {
        ScreenRect {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        }
    }

    unsafe fn center_hwnd_on_owner(dialog_hwnd: HWND, owner_hwnd: HWND) -> bool {
        if dialog_hwnd.0.is_null()
            || owner_hwnd.0.is_null()
            || !IsWindow(Some(dialog_hwnd)).as_bool()
            || !IsWindow(Some(owner_hwnd)).as_bool()
            || !IsWindowVisible(owner_hwnd).as_bool()
            || IsIconic(owner_hwnd).as_bool()
        {
            return false;
        }
        let mut owner_rect = RECT::default();
        let mut dialog_rect = RECT::default();
        if GetWindowRect(owner_hwnd, &mut owner_rect).is_err()
            || GetWindowRect(dialog_hwnd, &mut dialog_rect).is_err()
        {
            return false;
        }
        let dialog_w = dialog_rect.right - dialog_rect.left;
        let dialog_h = dialog_rect.bottom - dialog_rect.top;
        if dialog_w <= 0 || dialog_h <= 0 {
            return false;
        }
        let monitor = MonitorFromWindow(owner_hwnd, MONITOR_DEFAULTTONEAREST);
        let mut monitor_info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        let work_area = if GetMonitorInfoW(monitor, &mut monitor_info).as_bool() {
            rect_to_screen(monitor_info.rcWork)
        } else {
            rect_to_screen(owner_rect)
        };
        let (x, y) = center_dialog_origin(
            rect_to_screen(owner_rect),
            rect_to_screen(dialog_rect),
            work_area,
        );
        SetWindowPos(
            dialog_hwnd,
            None,
            x,
            y,
            0,
            0,
            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        )
        .is_ok()
    }

    unsafe extern "system" fn cbt_center_proc(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            if code == HCBT_ACTIVATE as i32 {
                if let Some(mut state) = CBT_CENTER_STATE.get() {
                    if !state.centered {
                        let dialog_hwnd = HWND(wparam.0 as *mut c_void);
                        let owner_hwnd = HWND(state.owner_hwnd as *mut c_void);
                        if dialog_hwnd != owner_hwnd
                            && GetWindow(dialog_hwnd, GW_OWNER).ok() == Some(owner_hwnd)
                            && center_hwnd_on_owner(dialog_hwnd, owner_hwnd)
                        {
                            state.centered = true;
                            CBT_CENTER_STATE.set(Some(state));
                        }
                    }
                }
            }
        }));
        CallNextHookEx(None, code, wparam, lparam)
    }

    struct CoTaskMemGuard(*const c_void);

    impl Drop for CoTaskMemGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    CoTaskMemFree(Some(self.0));
                }
            }
        }
    }

    struct CbtHookGuard {
        hook: HHOOK,
    }

    impl Drop for CbtHookGuard {
        fn drop(&mut self) {
            CBT_CENTER_STATE.set(None);
            if !self.hook.0.is_null() {
                unsafe {
                    let _ = UnhookWindowsHookEx(self.hook);
                }
            }
        }
    }

    struct ComInitGuard {
        initialized: bool,
    }

    impl Drop for ComInitGuard {
        fn drop(&mut self) {
            if self.initialized {
                unsafe {
                    CoUninitialize();
                }
            }
        }
    }

    pub fn pick_folder(
        owner_hwnd: isize,
        prompt: Option<String>,
    ) -> Result<Option<PathBuf>, String> {
        let handle = std::thread::Builder::new()
            .name("pi-n-win-folder-picker".to_string())
            .spawn(move || pick_folder_on_sta_thread(owner_hwnd, prompt))
            .map_err(|error| format!("Windows folder picker is unavailable: {error}"))?;
        handle
            .join()
            .map_err(|_| "Windows folder picker failed unexpectedly".to_string())?
    }

    fn pick_folder_on_sta_thread(
        owner_hwnd: isize,
        prompt: Option<String>,
    ) -> Result<Option<PathBuf>, String> {
        unsafe {
            let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
            let _com_guard = ComInitGuard {
                initialized: hr.is_ok(),
            };
            if hr.is_err() {
                return Err(format!("Windows folder picker COM init failed: {hr:?}"));
            }

            let dialog: IFileOpenDialog =
                CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
                    .map_err(|error| format!("Windows folder picker is unavailable: {error}"))?;
            let options = dialog
                .GetOptions()
                .map_err(|error| format!("Windows folder picker failed: {error}"))?;
            dialog
                .SetOptions(
                    options
                        | FOS_PICKFOLDERS
                        | FOS_FORCEFILESYSTEM
                        | FOS_PATHMUSTEXIST
                        | FOS_NOCHANGEDIR,
                )
                .map_err(|error| format!("Windows folder picker failed: {error}"))?;

            if let Some(title) = prompt
                .as_deref()
                .map(|s| s.replace('\0', ""))
            {
                let trimmed = title.trim();
                if !trimmed.is_empty() {
                    let wide: Vec<u16> = trimmed.encode_utf16().chain(std::iter::once(0)).collect();
                    let _ = dialog.SetTitle(PCWSTR(wide.as_ptr()));
                }
            }

            let owner = if owner_hwnd != 0 {
                let candidate = HWND(owner_hwnd as *mut c_void);
                if IsWindow(Some(candidate)).as_bool() {
                    Some(candidate)
                } else {
                    None
                }
            } else {
                None
            };

            let _cbt_guard = owner.and_then(|hwnd| {
                CBT_CENTER_STATE.set(Some(CbtCenterState {
                    owner_hwnd: hwnd.0 as isize,
                    centered: false,
                }));
                match SetWindowsHookExW(
                    WH_CBT,
                    Some(cbt_center_proc),
                    None,
                    GetCurrentThreadId(),
                ) {
                    Ok(hook) => Some(CbtHookGuard { hook }),
                    Err(_) => {
                        CBT_CENTER_STATE.set(None);
                        None
                    }
                }
            });

            match dialog.Show(owner) {
                Ok(()) => {}
                Err(error) if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) => {
                    return Ok(None);
                }
                Err(error) => {
                    return Err(format!("Windows folder picker failed: {error}"));
                }
            }

            let item = dialog
                .GetResult()
                .map_err(|error| format!("Windows folder picker failed: {error}"))?;
            let path_pwstr = item
                .GetDisplayName(SIGDN_FILESYSPATH)
                .map_err(|error| format!("Windows folder picker failed: {error}"))?;
            let _pwstr_guard = CoTaskMemGuard(path_pwstr.0 as *const c_void);
            if path_pwstr.is_null() {
                return Ok(None);
            }
            let path_os = OsString::from_wide(path_pwstr.as_wide());
            if path_os.to_string_lossy().trim().is_empty() {
                Ok(None)
            } else {
                Ok(Some(PathBuf::from(path_os)))
            }
        }
    }

    const STANDARD_DIALOG_CLASS: [u16; 6] = [
        b'#' as u16,
        b'3' as u16,
        b'2' as u16,
        b'7' as u16,
        b'7' as u16,
        b'0' as u16,
    ];

    unsafe extern "system" fn webview_dialog_win_event_proc(
        _hook: HWINEVENTHOOK,
        event: u32,
        hwnd: HWND,
        id_object: i32,
        id_child: i32,
        _id_event_thread: u32,
        _dwms_event_time: u32,
    ) {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            if id_object != OBJID_WINDOW.0 || id_child != CHILDID_SELF as i32 || hwnd.0.is_null() {
                return;
            }
            let dialog_raw = hwnd.0 as isize;
            if event == EVENT_SYSTEM_DIALOGEND {
                let _ = LAST_CENTERED_DIALOG_HWND.compare_exchange(
                    dialog_raw,
                    0,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                );
                return;
            }
            if event != EVENT_SYSTEM_DIALOGSTART {
                return;
            }
            let main_raw = WEBVIEW_MAIN_HWND.load(Ordering::Acquire);
            if main_raw == 0 {
                return;
            }
            let main_hwnd = HWND(main_raw as *mut c_void);
            if hwnd == main_hwnd {
                return;
            }
            if GetWindow(hwnd, GW_OWNER).ok() != Some(main_hwnd) {
                return;
            }
            let mut class_buf = [0u16; 32];
            let len = GetClassNameW(hwnd, &mut class_buf);
            if len <= 0 || (len as usize) > class_buf.len() {
                return;
            }
            if class_buf[..len as usize] != STANDARD_DIALOG_CLASS {
                return;
            }
            if LAST_CENTERED_DIALOG_HWND.load(Ordering::Acquire) == dialog_raw {
                return;
            }
            if center_hwnd_on_owner(hwnd, main_hwnd) {
                LAST_CENTERED_DIALOG_HWND.store(dialog_raw, Ordering::Release);
            }
        }));
    }

    pub fn install_webview_dialog_centering(window: &tauri::WebviewWindow) {
        let Ok(raw_hwnd) = window.hwnd() else {
            return;
        };
        let main_raw = raw_hwnd.0 as isize;
        WEBVIEW_MAIN_HWND.store(main_raw, Ordering::Release);
        LAST_CENTERED_DIALOG_HWND.store(0, Ordering::Release);

        let _ = window.with_webview(move |webview| unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else {
                return;
            };
            let mut browser_pid: u32 = 0;
            if core.BrowserProcessId(&mut browser_pid).is_err() || browser_pid == 0 {
                return;
            }
            let prev = WEBVIEW_EVENT_HOOK.swap(0, Ordering::AcqRel);
            if prev != 0 {
                let _ = UnhookWinEvent(HWINEVENTHOOK(prev as *mut c_void));
            }
            let hook = SetWinEventHook(
                EVENT_SYSTEM_DIALOGSTART,
                EVENT_SYSTEM_DIALOGEND,
                None,
                Some(webview_dialog_win_event_proc),
                browser_pid,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            if !hook.0.is_null() {
                WEBVIEW_EVENT_HOOK.store(hook.0 as isize, Ordering::Release);
            }
        });
    }

    pub fn uninstall_webview_dialog_centering() {
        let prev = WEBVIEW_EVENT_HOOK.swap(0, Ordering::AcqRel);
        WEBVIEW_MAIN_HWND.store(0, Ordering::Release);
        LAST_CENTERED_DIALOG_HWND.store(0, Ordering::Release);
        if prev != 0 {
            unsafe {
                let _ = UnhookWinEvent(HWINEVENTHOOK(prev as *mut c_void));
            }
        }
    }
}

#[cfg(target_os = "windows")]
pub use native::{install_webview_dialog_centering, pick_folder, uninstall_webview_dialog_centering};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn center_dialog_origin_centers_inside_owner_within_work_area() {
        let owner = ScreenRect {
            left: 200,
            top: 100,
            right: 1480,
            bottom: 940,
        };
        let dialog = ScreenRect {
            left: 0,
            top: 0,
            right: 800,
            bottom: 500,
        };
        let work_area = ScreenRect {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1040,
        };
        assert_eq!(center_dialog_origin(owner, dialog, work_area), (440, 270));
    }

    #[test]
    fn center_dialog_origin_clamps_to_secondary_monitor_work_area() {
        let owner = ScreenRect {
            left: -1900,
            top: 800,
            right: -620,
            bottom: 1640,
        };
        let dialog = ScreenRect {
            left: 0,
            top: 0,
            right: 800,
            bottom: 500,
        };
        let work_area = ScreenRect {
            left: -1920,
            top: 0,
            right: 0,
            bottom: 1040,
        };
        assert_eq!(center_dialog_origin(owner, dialog, work_area), (-1660, 540));
    }

    #[test]
    fn center_dialog_origin_keeps_top_left_visible_when_dialog_exceeds_work_area() {
        let owner = ScreenRect {
            left: 0,
            top: 0,
            right: 600,
            bottom: 400,
        };
        let dialog = ScreenRect {
            left: 0,
            top: 0,
            right: 1200,
            bottom: 900,
        };
        let work_area = ScreenRect {
            left: 40,
            top: 20,
            right: 840,
            bottom: 620,
        };
        assert_eq!(center_dialog_origin(owner, dialog, work_area), (40, 20));
    }

    #[test]
    fn center_dialog_origin_handles_extreme_and_inverted_rects_without_overflow() {
        let extreme_owner = ScreenRect {
            left: i32::MIN,
            top: i32::MIN,
            right: i32::MAX,
            bottom: i32::MAX,
        };
        let inverted_dialog = ScreenRect {
            left: 500,
            top: 400,
            right: 100,
            bottom: 50,
        };
        let work_area = ScreenRect {
            left: -1000,
            top: -500,
            right: 1000,
            bottom: 500,
        };
        assert_eq!(
            center_dialog_origin(extreme_owner, inverted_dialog, work_area),
            (-1, -1)
        );
    }
}
