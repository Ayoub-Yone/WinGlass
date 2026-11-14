pub mod backdrop;

use tauri::http::{Response, StatusCode};

/// Build the `glass://capture` response: raw BGRA bytes + X-Width / X-Height headers.
/// The body is the only per-response allocation (the scheme handler must own what it returns).
pub fn capture_response() -> Response<Vec<u8>> {
    let builder = || {
        Response::builder()
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Expose-Headers", "X-Width, X-Height, X-Seq")
            .header("Cache-Control", "no-store")
    };
    let response = backdrop::with_latest(|frame| {
        builder()
            .status(StatusCode::OK)
            .header("Content-Type", "application/octet-stream")
            .header("X-Width", frame.width.to_string())
            .header("X-Height", frame.height.to_string())
            .header("X-Seq", frame.seq.to_string())
            .body(frame.bgra.clone())
    })
    .unwrap_or_else(|| builder().status(StatusCode::NO_CONTENT).body(Vec::new()));
    response.unwrap_or_else(|_| Response::new(Vec::new()))
}
