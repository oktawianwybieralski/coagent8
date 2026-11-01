//! Test program: asks the system to start a command outside the current job and prints
//! `denied <win32 code>` or `started`. A started command is ended at once.

use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::ptr::null;

use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::System::Threading::{
    CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW, CREATE_SUSPENDED, CreateProcessW, PROCESS_INFORMATION, STARTUPINFOW, TerminateProcess,
};

fn main() {
    let program = std::env::args_os().nth(1).expect("usage: breakaway <program>");
    let mut command: Vec<u16> = program.encode_wide().chain(Some(0)).collect();
    unsafe {
        let mut startup: STARTUPINFOW = zeroed();
        startup.cb = size_of::<STARTUPINFOW>() as u32;
        let mut process: PROCESS_INFORMATION = zeroed();
        let created = CreateProcessW(
            null(),
            command.as_mut_ptr(),
            null(),
            null(),
            0,
            CREATE_BREAKAWAY_FROM_JOB | CREATE_SUSPENDED | CREATE_NO_WINDOW,
            null(),
            null(),
            &startup,
            &mut process,
        );
        if created == 0 {
            println!("denied {}", GetLastError());
        } else {
            TerminateProcess(process.hProcess, 0);
            println!("started");
        }
    }
}
