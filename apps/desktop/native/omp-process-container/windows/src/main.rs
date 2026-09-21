//! A deliberately narrow Windows containment host for a managed OMP session.
//!
//! This executable is launched only by Desktop Main.  It does not expose IPC,
//! open a network listener, elevate privileges, or interpret a shell command.
//! It receives an already-validated absolute OMP executable plus individual
//! argv values, starts it suspended, assigns it to a kill-on-close Job Object,
//! then resumes it and relays raw stdio bytes.  Holding the Job handle in this
//! process means OMP descendants cannot outlive either the Desktop Main process
//! or the root OMP executable.

#![cfg(windows)]

use std::{
    ffi::{OsStr, OsString},
    fs, io,
    mem::{self, size_of},
    os::windows::ffi::OsStrExt,
    path::Path,
    ptr, thread,
};

use windows_sys::{
    core::{PCWSTR, PWSTR},
    Win32::{
        Foundation::{
            CloseHandle, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
            WAIT_FAILED, WAIT_OBJECT_0,
        },
        Security::SECURITY_ATTRIBUTES,
        Storage::FileSystem::{ReadFile, WriteFile},
        System::{
            Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE},
            Environment::{FreeEnvironmentStringsW, GetEnvironmentStringsW},
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Pipes::CreatePipe,
            Threading::{
                CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
                InitializeProcThreadAttributeList, OpenProcess, ResumeThread, TerminateProcess,
                UpdateProcThreadAttribute, WaitForMultipleObjects, CREATE_NO_WINDOW,
                CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT,
                INFINITE, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW,
            },
        },
    },
};

const CONTAINMENT_PROTOCOL: &str = "1";
const MAX_ARGUMENTS: usize = 512;
const MAX_COMMAND_LINE_UTF16: usize = 32_767;
const COPY_BUFFER_BYTES: usize = 64 * 1024;
const OMP_EXECUTABLE_NAME: &str = "omp.exe";

type Result<T> = std::result::Result<T, io::Error>;

fn last_error() -> io::Error {
    io::Error::last_os_error()
}

fn invalid_input() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "invalid containment launch request",
    )
}

struct Handle(HANDLE);

unsafe impl Send for Handle {}

impl Handle {
    fn new(raw: HANDLE) -> Result<Self> {
        if raw.is_null() || raw == INVALID_HANDLE_VALUE {
            Err(last_error())
        } else {
            Ok(Self(raw))
        }
    }

    fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

struct EnvironmentBlock(PWSTR);

impl EnvironmentBlock {
    fn current() -> Result<Self> {
        let value = unsafe { GetEnvironmentStringsW() };
        if value.is_null() {
            Err(last_error())
        } else {
            Ok(Self(value))
        }
    }

    fn as_ptr(&self) -> *const core::ffi::c_void {
        self.0.cast()
    }
}

impl Drop for EnvironmentBlock {
    fn drop(&mut self) {
        unsafe {
            FreeEnvironmentStringsW(self.0);
        }
    }
}

struct AttributeList {
    _bytes: Vec<u8>,
    ptr: LPPROC_THREAD_ATTRIBUTE_LIST,
}

impl AttributeList {
    fn handles(handles: &mut [HANDLE]) -> Result<Self> {
        let mut size = 0usize;
        // The first call is specified to fail with ERROR_INSUFFICIENT_BUFFER.
        unsafe {
            InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut size);
        }
        if size == 0 {
            return Err(last_error());
        }
        let mut bytes = vec![0u8; size];
        let ptr = bytes.as_mut_ptr().cast::<_>();
        if unsafe { InitializeProcThreadAttributeList(ptr, 1, 0, &mut size) } == 0 {
            return Err(last_error());
        }
        if unsafe {
            UpdateProcThreadAttribute(
                ptr,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_mut_ptr().cast(),
                mem::size_of_val(handles),
                ptr::null_mut(),
                ptr::null(),
            )
        } == 0
        {
            unsafe {
                DeleteProcThreadAttributeList(ptr);
            }
            return Err(last_error());
        }
        Ok(Self { _bytes: bytes, ptr })
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.ptr);
        }
    }
}

struct Pipe {
    read: Handle,
    write: Handle,
}

fn create_pipe() -> Result<Pipe> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: ptr::null_mut(),
        bInheritHandle: 1,
    };
    let mut read = ptr::null_mut();
    let mut write = ptr::null_mut();
    if unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) } == 0 {
        return Err(last_error());
    }
    Ok(Pipe {
        read: Handle::new(read)?,
        write: Handle::new(write)?,
    })
}

fn make_non_inheritable(handle: HANDLE) -> Result<()> {
    if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) } == 0 {
        Err(last_error())
    } else {
        Ok(())
    }
}

#[derive(Debug)]
struct LaunchSpec {
    parent_pid: u32,
    executable: OsString,
    arguments: Vec<OsString>,
}

fn parse_launch() -> Result<LaunchSpec> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(OsStr::new("--protocol")) {
        return Err(invalid_input());
    }
    if args.next().as_deref() != Some(OsStr::new(CONTAINMENT_PROTOCOL)) {
        return Err(invalid_input());
    }
    if args.next().as_deref() != Some(OsStr::new("--parent-pid")) {
        return Err(invalid_input());
    }
    let parent_pid = args
        .next()
        .and_then(|value| value.to_str().and_then(|value| value.parse::<u32>().ok()))
        .filter(|value| *value > 0)
        .ok_or_else(invalid_input)?;
    if args.next().as_deref() != Some(OsStr::new("--")) {
        return Err(invalid_input());
    }
    let executable = args.next().ok_or_else(invalid_input)?;
    if !Path::new(&executable).is_absolute() {
        return Err(invalid_input());
    }
    // This helper is deliberately not a generic process runner.  The caller
    // can only select an absolute, ordinary `omp.exe`; Main separately repeats
    // the fixed SHA-256 check immediately before every launch.  Packaged Lex
    // keeps this signed helper in resources while the user-managed runtime
    // lives under userData, so they must not be required to share a directory.
    let executable_path = Path::new(&executable);
    if executable_path.file_name() != Some(OsStr::new(OMP_EXECUTABLE_NAME)) {
        return Err(invalid_input());
    }
    let metadata = fs::symlink_metadata(executable_path).map_err(|_| invalid_input())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(invalid_input());
    }
    let executable = fs::canonicalize(executable_path).map_err(|_| invalid_input())?;
    if executable.file_name() != Some(OsStr::new(OMP_EXECUTABLE_NAME)) || !executable.is_file() {
        return Err(invalid_input());
    }
    let arguments: Vec<OsString> = args.collect();
    if arguments.len() > MAX_ARGUMENTS || wide_without_nul(executable.as_os_str())?.is_empty() {
        return Err(invalid_input());
    }
    for argument in &arguments {
        let _ = wide_without_nul(argument)?;
    }
    Ok(LaunchSpec {
        parent_pid,
        executable: executable.into_os_string(),
        arguments,
    })
}

fn wide_without_nul(value: &OsStr) -> Result<Vec<u16>> {
    let units: Vec<u16> = value.encode_wide().collect();
    if units.iter().any(|unit| *unit == 0) {
        return Err(invalid_input());
    }
    Ok(units)
}

fn wide_null(value: &OsStr) -> Result<Vec<u16>> {
    let mut units = wide_without_nul(value)?;
    units.push(0);
    Ok(units)
}

/// Quote a single argv member according to CommandLineToArgvW-compatible
/// Windows parsing rules. The container never invokes a shell.
fn quote_argument(value: &[u16], output: &mut Vec<u16>) {
    output.push(b'"' as u16);
    let mut slash_count = 0usize;
    for unit in value {
        if *unit == b'\\' as u16 {
            slash_count += 1;
            continue;
        }
        if *unit == b'"' as u16 {
            output.extend(std::iter::repeat(b'\\' as u16).take(slash_count * 2 + 1));
            output.push(*unit);
            slash_count = 0;
            continue;
        }
        output.extend(std::iter::repeat(b'\\' as u16).take(slash_count));
        slash_count = 0;
        output.push(*unit);
    }
    output.extend(std::iter::repeat(b'\\' as u16).take(slash_count * 2));
    output.push(b'"' as u16);
}

fn make_command_line(spec: &LaunchSpec) -> Result<Vec<u16>> {
    let mut values = Vec::with_capacity(spec.arguments.len() + 1);
    values.push(wide_without_nul(&spec.executable)?);
    for argument in &spec.arguments {
        values.push(wide_without_nul(argument)?);
    }
    let mut command = Vec::new();
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            command.push(b' ' as u16);
        }
        quote_argument(value, &mut command);
    }
    if command.len() + 1 > MAX_COMMAND_LINE_UTF16 {
        return Err(invalid_input());
    }
    command.push(0);
    Ok(command)
}

fn create_job() -> Result<Handle> {
    let job = Handle::new(unsafe { CreateJobObjectW(ptr::null(), ptr::null()) })?;
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job.raw(),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        return Err(last_error());
    }
    Ok(job)
}

struct ContainedProcess {
    job: Handle,
    process: Handle,
    parent: Handle,
    stdin_write: Handle,
    stdout_read: Handle,
    stderr_read: Handle,
}

fn launch_contained(spec: &LaunchSpec) -> Result<ContainedProcess> {
    let parent = Handle::new(unsafe {
        OpenProcess(
            PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            spec.parent_pid,
        )
    })?;
    let job = create_job()?;
    let stdin = create_pipe()?;
    let stdout = create_pipe()?;
    let stderr = create_pipe()?;

    // Only the OMP-facing three ends can be inherited. STARTUPINFOEX repeats
    // this as an exact allow-list to close the concurrent broad-inheritance gap.
    make_non_inheritable(stdin.write.raw())?;
    make_non_inheritable(stdout.read.raw())?;
    make_non_inheritable(stderr.read.raw())?;
    let mut child_handles = [stdin.read.raw(), stdout.write.raw(), stderr.write.raw()];
    let attributes = AttributeList::handles(&mut child_handles)?;

    let executable = wide_null(&spec.executable)?;
    // The caller's cwd is the OMP project root.  It is passed in an explicit
    // environment value that this process inherited, not inferred from PATH.
    let cwd = std::env::current_dir().map_err(|_| invalid_input())?;
    if !cwd.is_absolute() {
        return Err(invalid_input());
    }
    let working_directory = wide_null(cwd.as_os_str())?;
    let mut command = make_command_line(spec)?;
    let environment = EnvironmentBlock::current()?;

    let mut startup: STARTUPINFOEXW = unsafe { mem::zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdin.read.raw();
    startup.StartupInfo.hStdOutput = stdout.write.raw();
    startup.StartupInfo.hStdError = stderr.write.raw();
    startup.lpAttributeList = attributes.ptr;
    let mut process: PROCESS_INFORMATION = unsafe { mem::zeroed() };
    if unsafe {
        CreateProcessW(
            executable.as_ptr() as PCWSTR,
            command.as_mut_ptr() as PWSTR,
            ptr::null(),
            ptr::null(),
            1,
            CREATE_SUSPENDED
                | CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT
                | CREATE_NO_WINDOW,
            environment.as_ptr(),
            working_directory.as_ptr() as PCWSTR,
            &startup.StartupInfo,
            &mut process,
        )
    } == 0
    {
        return Err(last_error());
    }
    let thread = Handle::new(process.hThread)?;
    let child = Handle::new(process.hProcess)?;
    if unsafe { AssignProcessToJobObject(job.raw(), child.raw()) } == 0 {
        let error = last_error();
        // The process is still suspended, but it was never assigned to the
        // Job.  Killing only the (empty) Job here would orphan a suspended
        // root process; terminate and reap the exact handle before returning.
        unsafe {
            TerminateProcess(child.raw(), 1);
            WaitForMultipleObjects(1, [child.raw()].as_ptr(), 1, INFINITE);
        }
        return Err(error);
    }
    if unsafe { ResumeThread(thread.raw()) } == u32::MAX {
        let error = last_error();
        unsafe {
            TerminateJobObject(job.raw(), 1);
            WaitForMultipleObjects(1, [child.raw()].as_ptr(), 1, INFINITE);
        }
        return Err(error);
    }

    // `stdin.read`, `stdout.write`, and `stderr.write` must be closed in the
    // container before its relay threads can observe target EOF.
    drop(stdin.read);
    drop(stdout.write);
    drop(stderr.write);

    Ok(ContainedProcess {
        job,
        process: child,
        parent,
        stdin_write: stdin.write,
        stdout_read: stdout.read,
        stderr_read: stderr.read,
    })
}

fn forward(source: Handle, destination: HANDLE) {
    let mut buffer = [0u8; COPY_BUFFER_BYTES];
    loop {
        let mut read = 0u32;
        if unsafe {
            ReadFile(
                source.raw(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                &mut read,
                ptr::null_mut(),
            )
        } == 0
            || read == 0
        {
            return;
        }
        let mut offset = 0usize;
        while offset < read as usize {
            let mut written = 0u32;
            if unsafe {
                WriteFile(
                    destination,
                    buffer[offset..read as usize].as_ptr(),
                    (read as usize - offset) as u32,
                    &mut written,
                    ptr::null_mut(),
                )
            } == 0
                || written == 0
            {
                return;
            }
            offset += written as usize;
        }
    }
}

fn forward_input(source: HANDLE, destination: Handle) {
    let mut buffer = [0u8; COPY_BUFFER_BYTES];
    loop {
        let mut read = 0u32;
        if unsafe {
            ReadFile(
                source,
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                &mut read,
                ptr::null_mut(),
            )
        } == 0
            || read == 0
        {
            return;
        }
        let mut offset = 0usize;
        while offset < read as usize {
            let mut written = 0u32;
            if unsafe {
                WriteFile(
                    destination.raw(),
                    buffer[offset..read as usize].as_ptr(),
                    (read as usize - offset) as u32,
                    &mut written,
                    ptr::null_mut(),
                )
            } == 0
                || written == 0
            {
                return;
            }
            offset += written as usize;
        }
    }
}

fn exit_code(process: HANDLE) -> i32 {
    let mut code = 1u32;
    if unsafe { GetExitCodeProcess(process, &mut code) } == 0 {
        1
    } else {
        code as i32
    }
}

fn run(spec: LaunchSpec) -> Result<i32> {
    // The launcher has exactly the environment and cwd supplied by Main's
    // isolated OMP launch plan. Do not add PATH, user profile, or credential
    // fallbacks here.
    let ContainedProcess {
        job,
        process,
        parent,
        stdin_write,
        stdout_read,
        stderr_read,
    } = launch_contained(&spec)?;
    let stdout = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    let stderr = unsafe { GetStdHandle(STD_ERROR_HANDLE) };
    let stdin = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
    if stdout.is_null() || stderr.is_null() || stdin.is_null() {
        unsafe {
            TerminateJobObject(job.raw(), 1);
        }
        return Err(last_error());
    }

    let stdout_raw = stdout as usize;
    let stderr_raw = stderr as usize;
    let stdin_raw = stdin as usize;
    let stdout_thread = thread::spawn(move || forward(stdout_read, stdout_raw as HANDLE));
    let stderr_thread = thread::spawn(move || forward(stderr_read, stderr_raw as HANDLE));
    // Input may remain blocked in ReadFile after the target exits.  It owns no
    // lifecycle authority; process teardown closes its one pipe endpoint.
    let _stdin_thread = thread::spawn(move || forward_input(stdin_raw as HANDLE, stdin_write));

    // The Job is intentionally held in this process rather than in Electron.
    // If Main crashes, this process detects parent death and drops the final
    // Job handle; if OMP root exits first, it proactively reclaims descendants
    // before waiting for its buffered stdout/stderr tail to drain.
    let handles = [process.raw(), parent.raw()];
    let wait =
        unsafe { WaitForMultipleObjects(handles.len() as u32, handles.as_ptr(), 0, INFINITE) };
    let status = if wait == WAIT_OBJECT_0 {
        let code = exit_code(process.raw());
        unsafe {
            TerminateJobObject(job.raw(), 1);
        }
        let _ = stdout_thread.join();
        let _ = stderr_thread.join();
        code
    } else {
        unsafe {
            TerminateJobObject(job.raw(), 1);
        }
        if wait == WAIT_FAILED {
            return Err(last_error());
        }
        1
    };
    Ok(status)
}

fn main() {
    match parse_launch().and_then(run) {
        Ok(code) => std::process::exit(code),
        Err(_) => {
            // stderr is deliberately drained by the Main-owned host. Do not
            // disclose paths, argv, environment values, or upstream output.
            eprintln!("OMP containment launcher failed");
            std::process::exit(1);
        }
    }
}
