//! Cross-platform exclusive ownership of the Pi^n runtime directory.
use std::{fs, path::Path, sync::Arc};

#[cfg(windows)]
use std::{
    collections::{hash_map::DefaultHasher, HashSet},
    hash::{Hash, Hasher},
    os::windows::io::AsRawHandle,
    sync::{Mutex, OnceLock},
};

#[cfg(unix)]
use std::os::fd::AsRawFd;

pub struct RuntimeLock {
    _marker: fs::File,
    _parent: Option<Arc<RuntimeLock>>,
    #[cfg(windows)]
    key: String,
}

#[cfg(windows)]
static PROCESS_LOCKS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

impl RuntimeLock {
    pub(crate) fn retain_parent(mut self, parent: Arc<RuntimeLock>) -> Self {
        self._parent = Some(parent);
        self
    }
}

pub fn acquire(root: &Path) -> Result<RuntimeLock, String> {
    let marker = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join("runtime.lock"))
        .map_err(|error| error.to_string())?;

    #[cfg(unix)]
    {
        let result = unsafe { libc::flock(marker.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if result != 0 {
            return Err("Another Pi^n instance owns this runtime. Close it before opening this data directory again.".into());
        }
        return Ok(RuntimeLock {
            _marker: marker,
            _parent: None,
        });
    }

    #[cfg(windows)]
    {
        // Use handle-bound `LockFileEx` instead of thread-affine Win32 named
        // mutexes so `Arc<RuntimeLock>` can be safely dropped from any thread.
        let canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        let mut hasher = DefaultHasher::new();
        canonical.to_string_lossy().hash(&mut hasher);
        let key = format!("Local\\PiNRuntime-{:016x}", hasher.finish());
        let locks = PROCESS_LOCKS.get_or_init(|| Mutex::new(HashSet::new()));
        {
            let mut owned = locks.lock().map_err(|error| error.to_string())?;
            if !owned.insert(key.clone()) {
                return Err("Another Pi^n instance owns this runtime. Close it before opening this data directory again.".into());
            }
        }
        let mut overlapped: Overlapped = unsafe { std::mem::zeroed() };
        let locked = unsafe {
            LockFileEx(
                marker.as_raw_handle(),
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                0,
                1,
                0,
                &mut overlapped,
            )
        };
        if locked == 0 {
            let _ = locks.lock().map(|mut owned| owned.remove(&key));
            return Err("Another Pi^n instance owns this runtime. Close it before opening this data directory again.".into());
        }
        Ok(RuntimeLock {
            _marker: marker,
            _parent: None,
            key,
        })
    }

    #[cfg(not(any(unix, windows)))]
    Ok(RuntimeLock {
        _marker: marker,
        _parent: None,
    })
}

impl Drop for RuntimeLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            let _ = libc::flock(self._marker.as_raw_fd(), libc::LOCK_UN);
        }

        #[cfg(windows)]
        {
            let mut overlapped: Overlapped = unsafe { std::mem::zeroed() };
            unsafe {
                let _ = UnlockFileEx(self._marker.as_raw_handle(), 0, 1, 0, &mut overlapped);
            }
            if let Some(locks) = PROCESS_LOCKS.get() {
                let _ = locks.lock().map(|mut owned| owned.remove(&self.key));
            }
        }
    }
}

#[cfg(windows)]
type RawHandle = *mut std::ffi::c_void;

#[cfg(windows)]
const LOCKFILE_FAIL_IMMEDIATELY: u32 = 0x0000_0001;
#[cfg(windows)]
const LOCKFILE_EXCLUSIVE_LOCK: u32 = 0x0000_0002;

#[cfg(windows)]
#[repr(C)]
struct Overlapped {
    internal: usize,
    internal_high: usize,
    offset: u32,
    offset_high: u32,
    event: RawHandle,
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn LockFileEx(
        file: RawHandle,
        flags: u32,
        reserved: u32,
        bytes_low: u32,
        bytes_high: u32,
        overlapped: *mut Overlapped,
    ) -> i32;
    fn UnlockFileEx(
        file: RawHandle,
        reserved: u32,
        bytes_low: u32,
        bytes_high: u32,
        overlapped: *mut Overlapped,
    ) -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_rejects_competing_owner_and_releases_on_drop() {
        let temp = tempfile::tempdir().unwrap();
        let first = acquire(temp.path()).unwrap();
        assert!(acquire(temp.path()).is_err());
        drop(first);
        let second = acquire(temp.path()).unwrap();
        drop(second);
    }
}
