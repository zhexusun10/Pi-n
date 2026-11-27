//! Resident process inspection and explicit release handlers.

use crate::engine::{
    release_resident_processes as engine_release_resident_processes,
    resident_process_status as engine_resident_process_status, ResidentProcessStatus,
    ResidentReleaseResult, ResidentReleaseScope,
};

pub(super) fn get_resident_processes() -> ResidentProcessStatus {
    engine_resident_process_status()
}

pub(super) fn release_resident_processes(
    body: &serde_json::Value,
) -> Result<ResidentReleaseResult, String> {
    let run_id = body
        .get("runId")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty());
    let scope = ResidentReleaseScope::parse(body.get("scope").and_then(serde_json::Value::as_str))?;
    Ok(engine_release_resident_processes(run_id, scope))
}
