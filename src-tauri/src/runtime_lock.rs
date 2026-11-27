//! Cross-platform exclusive runtime locks interoperable with `backend/src/runtime_lock.rs`.
use std::{fs, path::Path};

#[cfg(unix)]
use std::os::fd::AsRawFd;

#[cfg(windows)]
use std::{
    collections::{hash_map::DefaultHasher, HashSet},
    hash::{Hash, Hasher},
    os::windows::io::AsRawHandle,
    sync::{Mutex, OnceLock},
};

pub struct RuntimeLock {
    _marker: fs::File,
    #[cfg(windows)]
    key: String,
}

#[cfg(windows)]
static PROCESS_LOCKS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

/// Acquire the exact exclusive runtime lock used by the Pi^n backend
/// (`<root>/runtime.lock` via `flock` on Unix and `LockFileEx` on Windows).
pub fn acquire_runtime(root: &Path) -> Result<RuntimeLock, String> {
    let lock_path = root.join("runtime.lock");
    reject_symlink_lock_file(&lock_path)?;
    acquire_lock_file(
        root,
        &lock_path,
        "Local\\PiNRuntime",
        "Another Pi^n instance owns this runtime. Close it before migrating or opening this data directory.",
    )
}

/// Acquire an exclusive migration guard lock under the desktop `app_data_dir()`
/// so concurrent first launches cannot race while publishing `data`.
pub fn acquire_migration_guard(parent: &Path) -> Result<RuntimeLock, String> {
    let lock_path = parent.join(".pi-n-migration.lock");
    reject_symlink_lock_file(&lock_path)?;
    acquire_lock_file(
        parent,
        &lock_path,
        "Local\\PiNDesktopMigration",
        "Another Pi^n desktop launch is currently initializing this app-data directory.",
    )
}

fn reject_symlink_lock_file(lock_path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(lock_path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.file_type().is_file() {
                return Err(format!(
                    "Refusing to open unsafe lock file path: {}",
                    lock_path.display()
                ));
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
                if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                    return Err(format!(
                        "Refusing to open reparse-point lock file path: {}",
                        lock_path.display()
                    ));
                }
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Cannot inspect lock file {}: {error}",
            lock_path.display()
        )),
    }
}

fn acquire_lock_file(
    scope_dir: &Path,
    lock_path: &Path,
    #[allow(unused_variables)] windows_prefix: &str,
    busy_message: &str,
) -> Result<RuntimeLock, String> {
    let mut open_options = fs::OpenOptions::new();
    open_options
        .read(true)
        .write(true)
        .create(true)
        .truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open_options.custom_flags(libc::O_NOFOLLOW);
    }
    let marker = open_options
        .open(lock_path)
        .map_err(|error| format!("Cannot open lock file {}: {error}", lock_path.display()))?;

    #[cfg(unix)]
    {
        let _ = scope_dir;
        let result = unsafe { libc::flock(marker.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if result != 0 {
            return Err(busy_message.into());
        }
        Ok(RuntimeLock { _marker: marker })
    }

    #[cfg(windows)]
    {
        // Use handle-bound `LockFileEx` matching `backend/src/runtime_lock.rs`
        // so desktop migration locks interoperate with the backend on Windows.
        let canonical = scope_dir
            .canonicalize()
            .unwrap_or_else(|_| scope_dir.to_path_buf());
        let mut hasher = DefaultHasher::new();
        canonical.to_string_lossy().hash(&mut hasher);
        let key = format!("{windows_prefix}-{:016x}", hasher.finish());
        let locks = PROCESS_LOCKS.get_or_init(|| Mutex::new(HashSet::new()));
        {
            let mut owned = locks.lock().map_err(|error| error.to_string())?;
            if !owned.insert(key.clone()) {
                return Err(busy_message.into());
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
            let mut owned = locks.lock().unwrap_or_else(|e| e.into_inner());
            owned.remove(&key);
            return Err(busy_message.into());
        }
        Ok(RuntimeLock {
            _marker: marker,
            key,
        })
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = (scope_dir, busy_message);
        Ok(RuntimeLock { _marker: marker })
    }
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
                let mut owned = locks.lock().unwrap_or_else(|e| e.into_inner());
                owned.remove(&self.key);
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
    fn runtime_lock_rejects_competing_owner_and_releases_on_drop() {
        let temp = tempfile::tempdir().unwrap();
        let first = acquire_runtime(temp.path()).unwrap();
        assert!(acquire_runtime(temp.path()).is_err());
        drop(first);
        let second = acquire_runtime(temp.path()).unwrap();
        drop(second);
    }

    #[cfg(unix)]
    #[test]
    fn runtime_lock_rejects_symlink_lock_file() {
        let temp = tempfile::tempdir().unwrap();
        let outside = temp.path().join("outside.txt");
        fs::write(&outside, b"sensitive").unwrap();
        let store = temp.path().join("store");
        fs::create_dir_all(&store).unwrap();
        std::os::unix::fs::symlink(&outside, store.join("runtime.lock")).unwrap();
        let err = acquire_runtime(&store).err().unwrap();
        assert!(err.contains("unsafe lock file"), "{err}");
    }
}
