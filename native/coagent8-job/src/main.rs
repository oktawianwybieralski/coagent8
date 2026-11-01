//! Runs one command in its own Job Object with `KILL_ON_JOB_CLOSE` (WINDOWS-001).
//!
//! The parent spawns `coagent8-job.exe <command> <args>` with standard streams and a status
//! pipe as descriptor 3. The command joins the job atomically while it is created, so no
//! moment exists in which it runs, or waits suspended, outside the job. This helper holds
//! the only job handle: when the helper ends for any reason, including termination by its
//! parent, the system closes the handle and ends every process in the job.
//!
//! Status protocol, one line on descriptor 3: `ready` once the command runs, or
//! `error <stage> <win32 code>` when it could not start. The exit code is the command's own,
//! so only the status line tells a failed start from a command that failed.
//!
//! Stop protocol: the parent closes its end of descriptor 3. The helper then ends the job.
//! When the command ended, by a stop or by itself, the helper ends what is left of the job and
//! exits only once the job is empty, so its exit confirms that the whole tree has ended.

#[cfg(not(windows))]
compile_error!("coagent8-job is a Windows helper; POSIX uses process groups.");

use std::ffi::c_void;
use std::mem::{size_of, size_of_val, zeroed};
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0};
use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE};
use windows_sys::Win32::System::Environment::GetCommandLineW;
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject,
};
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
    ExitProcess, GetExitCodeProcess, GetStartupInfoW, INFINITE, InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_JOB_LIST, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    STARTUPINFOW, Sleep, UpdateProcThreadAttribute, WaitForSingleObject,
};

/// Exit code when the helper cannot start the command; the status line carries the reason.
const EXIT_START_FAILED: u32 = 1;
/// Exit code of the job's processes when the parent asks for a stop: `STATUS_CONTROL_C_EXIT`.
const EXIT_STOPPED: u32 = 0xC000_013A;
/// How long the helper waits for an ended job to empty before it exits anyway.
const JOB_EMPTY_WAIT_MS: u32 = 5000;
const JOB_EMPTY_POLL_MS: u32 = 5;
const SPACE: u16 = b' ' as u16;
const TAB: u16 = b'\t' as u16;
const QUOTE: u16 = b'"' as u16;

/// The stage of a failed start with its Win32 error code.
struct StartError(&'static str, u32);

fn last_error(stage: &'static str) -> StartError {
    StartError(stage, unsafe { GetLastError() })
}

/// The handle of a descriptor the parent passed through the C runtime's startup block:
/// a 32-bit count, one flag byte per descriptor, then one handle per descriptor.
fn inherited_descriptor(descriptor: usize) -> Option<HANDLE> {
    unsafe {
        let mut info: STARTUPINFOW = zeroed();
        GetStartupInfoW(&mut info);
        let block = info.lpReserved2;
        let size = info.cbReserved2 as usize;
        if block.is_null() || size < size_of::<u32>() {
            return None;
        }
        let count = (block as *const u32).read_unaligned() as usize;
        let handles = size_of::<u32>() + count;
        if descriptor >= count || size < handles + count * size_of::<HANDLE>() {
            return None;
        }
        let handle = (block.add(handles) as *const HANDLE).add(descriptor).read_unaligned();
        (!handle.is_null() && handle != INVALID_HANDLE_VALUE).then_some(handle)
    }
}

fn write_status(handle: HANDLE, line: &str) {
    let mut written = 0;
    // A parent that is gone cannot read the status; the exit code still reports the failure.
    unsafe { WriteFile(handle, line.as_ptr(), line.len() as u32, &mut written, null_mut()) };
}

/// The length of the first token of a command line: up to the closing quote when it starts
/// with one, otherwise up to the first space or tab. Backslashes are not escapes here, which
/// is how the system and the C runtime read a program name.
fn first_token_end(line: &[u16]) -> usize {
    if line.first() == Some(&QUOTE) {
        line[1..].iter().position(|&c| c == QUOTE).map_or(line.len(), |end| end + 2)
    } else {
        line.iter().position(|&c| c == SPACE || c == TAB).unwrap_or(line.len())
    }
}

/// This process's command line without the helper's own name: the command to run, exactly as
/// the parent quoted it.
fn command_line() -> Vec<u16> {
    let line = unsafe {
        let start = GetCommandLineW();
        let mut length = 0;
        while *start.add(length) != 0 {
            length += 1;
        }
        std::slice::from_raw_parts(start, length)
    };
    let rest = &line[first_token_end(line)..];
    let skip = rest.iter().position(|&c| c != SPACE && c != TAB).unwrap_or(rest.len());
    rest[skip..].to_vec()
}

/// The program path in the first token, NUL-terminated, without its quotes.
fn application_name(command: &[u16]) -> Vec<u16> {
    let token = &command[..first_token_end(command)];
    let path = match token {
        [QUOTE, inner @ .., QUOTE] => inner,
        other => other,
    };
    path.iter().copied().chain(Some(0)).collect()
}

fn create_job() -> Result<HANDLE, StartError> {
    unsafe {
        let job = CreateJobObjectW(null(), null());
        if job.is_null() {
            return Err(last_error("job-create"));
        }
        // No BREAKAWAY_OK and no SILENT_BREAKAWAY_OK: nothing in the job can leave it.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let limited = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if limited == 0 {
            return Err(last_error("job-limit"));
        }
        Ok(job)
    }
}

/// Starts the command inside the job, inheriting only the standard streams.
fn start(command: &mut [u16], application: &[u16], job: &HANDLE, streams: &[HANDLE]) -> Result<PROCESS_INFORMATION, StartError> {
    unsafe {
        let mut size = 0;
        InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut size);
        let mut buffer = vec![0u8; size];
        let attributes = buffer.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
        if InitializeProcThreadAttributeList(attributes, 2, 0, &mut size) == 0 {
            return Err(last_error("attributes"));
        }
        let joined = UpdateProcThreadAttribute(
            attributes,
            0,
            PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
            job as *const HANDLE as *const c_void,
            size_of::<HANDLE>(),
            null_mut(),
            null(),
        );
        if joined == 0 {
            return Err(last_error("attribute-job"));
        }
        let inherited = UpdateProcThreadAttribute(
            attributes,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            streams.as_ptr() as *const c_void,
            size_of_val(streams),
            null_mut(),
            null(),
        );
        if inherited == 0 {
            return Err(last_error("attribute-handles"));
        }

        let mut startup: STARTUPINFOEXW = zeroed();
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
        startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
        startup.lpAttributeList = attributes;

        let mut process: PROCESS_INFORMATION = zeroed();
        // CREATE_NO_WINDOW: a console program must never open a window on the user's desktop.
        let created = CreateProcessW(
            application.as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
            null(),
            null(),
            &startup.StartupInfo,
            &mut process,
        );
        let failure = (created == 0).then(|| last_error("process-create"));
        DeleteProcThreadAttributeList(attributes);
        match failure {
            Some(error) => Err(error),
            None => Ok(process),
        }
    }
}

/// The distinct valid standard stream handles; the system refuses duplicates in a handle list.
fn standard_streams() -> Vec<HANDLE> {
    let mut streams: Vec<HANDLE> = Vec::with_capacity(3);
    for id in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        let handle = unsafe { GetStdHandle(id) };
        if !handle.is_null() && handle != INVALID_HANDLE_VALUE && !streams.contains(&handle) {
            streams.push(handle);
        }
    }
    streams
}

/// Ends the job when the parent closes its end of the status pipe, or when the parent is gone.
/// Reads only after the status line is written: a synchronous pipe handle serves one call at a time.
fn stop_on_status_close(status: HANDLE, job: HANDLE) {
    // Handles are process-wide; the integers only carry them into the thread.
    let (status, job) = (status as usize, job as usize);
    std::thread::spawn(move || unsafe {
        let mut byte = 0u8;
        let mut read = 0;
        while ReadFile(status as HANDLE, &mut byte, 1, &mut read, null_mut()) != 0 && read != 0 {}
        TerminateJobObject(job as HANDLE, EXIT_STOPPED);
    });
}

/// Ends what is left of the job and waits until the system reports it empty.
fn end_job(job: HANDLE, code: u32) {
    unsafe {
        TerminateJobObject(job, code);
        let mut waited = 0;
        while waited < JOB_EMPTY_WAIT_MS {
            let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = zeroed();
            let queried = QueryInformationJobObject(
                job,
                JobObjectBasicAccountingInformation,
                &mut accounting as *mut _ as *mut c_void,
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                null_mut(),
            );
            if queried == 0 || accounting.ActiveProcesses == 0 {
                return;
            }
            Sleep(JOB_EMPTY_POLL_MS);
            waited += JOB_EMPTY_POLL_MS;
        }
    }
}

/// Runs the command and returns its exit code. The job handle stays open until this process
/// exits, because closing it ends the command.
fn run(status: HANDLE) -> Result<u32, StartError> {
    let mut command = command_line();
    if command.is_empty() {
        return Err(StartError("usage", 0));
    }
    let application = application_name(&command);
    command.push(0);
    let job = create_job()?;
    let process = start(&mut command, &application, &job, &standard_streams())?;
    unsafe {
        CloseHandle(process.hThread);
        write_status(status, "ready\n");
        stop_on_status_close(status, job);
        if WaitForSingleObject(process.hProcess, INFINITE) != WAIT_OBJECT_0 {
            return Err(last_error("process-wait"));
        }
        let mut code = 0;
        if GetExitCodeProcess(process.hProcess, &mut code) == 0 {
            return Err(last_error("process-exit-code"));
        }
        end_job(job, code);
        Ok(code)
    }
}

fn main() {
    let Some(status) = inherited_descriptor(3) else {
        unsafe { ExitProcess(EXIT_START_FAILED) }
    };
    let code = match run(status) {
        Ok(code) => code,
        Err(StartError(stage, code)) => {
            write_status(status, &format!("error {stage} {code}\n"));
            EXIT_START_FAILED
        }
    };
    unsafe { ExitProcess(code) }
}
