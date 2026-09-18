//! Test-only child used by `tests/containment.rs`. It is not built by the
//! explicit `pnpm install:omp` production helper command.

use std::{env, fs, process::Command, thread, time::Duration};

fn main() {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("--grandchild") => loop {
            thread::sleep(Duration::from_secs(1));
        },
        Some("--spawn-grandchild") => {
            let marker = args.next().expect("marker path");
            let child = Command::new(env::current_exe().expect("fixture path"))
                .arg("--grandchild")
                .spawn()
                .expect("grandchild spawn");
            fs::write(marker, child.id().to_string()).expect("marker write");
        }
        _ => std::process::exit(2),
    }
}
