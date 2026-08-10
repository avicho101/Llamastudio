//! Windows Job Object wrapper.
//!
//! Prevents orphaned child processes: when the LlamaStudio app process exits
//! (even via crash or force-kill), the OS terminates every process assigned to
//! the job. This stops llama-server.exe from surviving the app and holding
//! VRAM / ports (the "CUDA out of memory" zombie problem).
//!
//! On non-Windows platforms this is a no-op (returns success) so the code
//! still compiles on Linux/macOS.

#[cfg(target_os = "windows")]
pub mod imp {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct JobObject(HANDLE);

    // SAFETY: the handle is used only to (a) assign a child once at startup and
    // (b) be closed on drop. Tauri requires managed state to be Send + Sync;
    // a raw handle is not, so we assert it — our usage never races.
    unsafe impl Send for JobObject {}
    unsafe impl Sync for JobObject {}

    impl JobObject {
        /// Create a job with KILL_ON_JOB_CLOSE. Returns None on failure
        /// (rare — caller treats it as best-effort).
        pub fn new() -> Option<JobObject> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    CloseHandle(handle);
                    return None;
                }
                Some(JobObject(handle))
            }
        }

        /// Assign a child process to this job so it dies with the app.
        pub fn assign(&self, child: &std::process::Child) -> bool {
            unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) != 0 }
        }
    }

    impl Drop for JobObject {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub mod imp {
    pub struct JobObject;

    impl JobObject {
        pub fn new() -> Option<JobObject> {
            None
        }
        pub fn assign(&self, _child: &std::process::Child) -> bool {
            true // no-op on non-Windows
        }
    }
}

pub use imp::JobObject;
