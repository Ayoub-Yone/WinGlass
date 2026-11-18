// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(pos) = args.iter().position(|a| a == winglass_lib::GUARDIAN_FLAG) {
        if let Some(pid) = args.get(pos + 1).and_then(|p| p.parse::<u32>().ok()) {
            winglass_lib::run_guardian(pid);
        }
        return;
    }
    winglass_lib::run()
}
