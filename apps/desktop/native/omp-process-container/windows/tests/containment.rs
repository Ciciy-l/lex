#![cfg(windows)]

use std::{
    env, fs,
    path::PathBuf,
    process::Command,
    thread,
    time::{Duration, Instant},
};

use windows_sys::Win32::{
    Foundation::CloseHandle,
    System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
};

fn wait_for_marker(marker: &PathBuf) -> u32 {
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if let Ok(contents) = fs::read_to_string(marker) {
            if let Ok(pid) = contents.trim().parse::<u32>() {
                return pid;
            }
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("fixture did not publish a grandchild PID");
}

fn process_is_alive(pid: u32) -> bool {
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        return false;
    }
    let alive = unsafe { WaitForSingleObject(handle, 0) } != 0;
    unsafe { CloseHandle(handle) };
    alive
}

#[test]
fn root_exit_reclaims_a_grandchild_before_the_container_exits() {
    let root = env::temp_dir().join(format!(
        "cindy-omp-container-test-{}-{}",
        std::process::id(),
        Instant::now().elapsed().as_nanos(),
    ));
    fs::create_dir_all(&root).expect("test root");
    let marker = root.join("grandchild.pid");
    let container =
        env::var("CARGO_BIN_EXE_cindy-omp-process-container").expect("container test binary");
    let fixture = env::var("CARGO_BIN_EXE_fixture").expect("fixture test binary");
    // Production accepts only a sibling omp.exe. Stage the test fixture under
    // that exact name beside the container so this exercises the same guard.
    let omp = PathBuf::from(&container)
        .parent()
        .expect("container directory")
        .join("omp.exe");
    fs::copy(&fixture, &omp).expect("stage sibling omp fixture");
    let parent_pid = std::process::id().to_string();

    let status = Command::new(container)
        .args([
            "--protocol",
            "1",
            "--parent-pid",
            &parent_pid,
            "--",
            omp.to_str().expect("utf8 OMP fixture path"),
            "--spawn-grandchild",
            marker.to_str().expect("utf8 marker path"),
        ])
        .current_dir(&root)
        .status()
        .expect("container spawn");
    assert!(status.success(), "container returned {status}");

    let grandchild = wait_for_marker(&marker);
    let deadline = Instant::now() + Duration::from_secs(3);
    while process_is_alive(grandchild) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    assert!(
        !process_is_alive(grandchild),
        "grandchild {grandchild} outlived contained OMP root",
    );
    fs::remove_file(omp).expect("fixture cleanup");
    fs::remove_dir_all(root).expect("test cleanup");
}
