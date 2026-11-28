//! On-demand file-change summary queries with pagination and live content-version stamping.

use super::{argument, Service};
use crate::model::{Execution, Snapshot};
use std::sync::Arc;

const MAX_FILE_CHANGES_PAGE_LIMIT: usize = 500;

pub(super) fn get_file_changes(
    body: &serde_json::Value,
    service: &Arc<Service>,
) -> Result<serde_json::Value, String> {
    let requested_run_id = body
        .get("runId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let execution_id = body
        .get("executionId")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let execution_ids: Option<Vec<String>> = argument(body, "executionIds")?;
    if execution_id.is_some() && execution_ids.is_some() {
        return Err("Specify executionId or executionIds, not both".into());
    }
    let offset: usize = body
        .get("offset")
        .filter(|value| !value.is_null())
        .map(|_| argument(body, "offset"))
        .transpose()?
        .unwrap_or(0);
    let limit: usize = body
        .get("limit")
        .filter(|value| !value.is_null())
        .map(|_| argument(body, "limit"))
        .transpose()?
        .unwrap_or(crate::file_changes::MAX_DISPLAYED_FILE_CHANGES)
        .clamp(1, MAX_FILE_CHANGES_PAGE_LIMIT);
    let scope = execution_ids
        .clone()
        .or_else(|| execution_id.clone().map(|id| vec![id]));
    let (in_memory_state, root) = {
        let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
        let state = if requested_run_id.is_empty() || runtime.state.run_id == requested_run_id {
            // Capture metadata without copying the in-memory transcript under the Run lock.
            let lightweight = Snapshot {
                run_id: runtime.state.run_id.clone(),
                config: runtime.state.config.clone(),
                planning_id: runtime.state.planning_id.clone(),
                planning: runtime.state.planning.clone(),
                base: runtime.state.base.clone(),
                latest_source_base: runtime.state.latest_source_base.clone(),
                publication: runtime.state.publication.clone(),
                superseded_execution_ids: runtime.state.superseded_execution_ids.clone(),
                executions: runtime
                    .state
                    .executions
                    .iter()
                    .map(Execution::clone_without_output)
                    .collect(),
                mergers: runtime
                    .state
                    .mergers
                    .iter()
                    .map(Execution::clone_without_output)
                    .collect(),
                ..Snapshot::default()
            };
            let fence = crate::file_changes::capture_warm_fence(&lightweight, scope.as_deref())?;
            Some((lightweight, fence))
        } else {
            None
        };
        (state, runtime.root.clone())
    };
    // Cold sidecar/log parsing and Git diffs never hold the Run mutex. Use a
    // read-only connection, and warm only this request's execution scope.
    // Cache publication is fenced against concurrent live output/invalidation.
    let reader = crate::store::Store::open_reader(&root.join("events.sqlite"))?;
    let (state, fence) = match in_memory_state {
        Some((state, fence)) => (state, fence),
        None => {
            let state = reader.load(&requested_run_id)?;
            let fence = crate::file_changes::capture_warm_fence(&state, scope.as_deref())?;
            (state, fence)
        }
    };
    crate::file_changes::warm_scoped_changes(
        &state,
        &reader,
        Some(&root),
        scope.as_deref(),
        &fence,
    );

    let summary = if let Some(ids) = &scope {
        let selected: Vec<_> = state
            .executions
            .iter()
            .chain(state.mergers.iter())
            .filter(|exec| ids.contains(&exec.id))
            .collect();
        let parts = selected.iter().map(|exec| {
            let cached = crate::file_changes::get_cached_execution_changes(&state.run_id, exec)
                .unwrap_or_default();
            if exec.status == "running" && !exec.before.is_empty() && !exec.worktree.is_empty() {
                if let Some(live_git) = crate::file_changes::compute_git_changes(
                    std::path::Path::new(&exec.worktree),
                    &exec.before,
                    None,
                    &exec.node,
                    &exec.id,
                ) {
                    return crate::file_changes::merge_summaries([cached, live_git], true);
                }
            }
            cached
        });
        // Union complete per-execution paths before paging the response. Adding
        // already-paged totals in the browser cannot deduplicate shared files.
        crate::file_changes::merge_summaries(
            parts,
            selected.iter().any(|exec| exec.status == "running"),
        )
    } else {
        crate::file_changes::get_cached_run_changes(&state).unwrap_or_default()
    };
    // Bash rows are only leads (`rm x`, `sed -i x`): keep those Git confirms.
    let summary = crate::file_changes::verify_snapshot_changes(summary, &state);
    // Hide untracked `.gitignore`d artifacts and rebuildable caches from the
    // display summary while keeping project-tracked files and snapshot contracts intact.
    let summary = crate::file_changes::filter_display_ignored(summary, &state);
    // Page the transferred rows while keeping true totals so large runs stay
    // fast on first open and still allow complete review via offset/limit.
    let (mut summary, order_version) = crate::file_changes::page_summary_files(summary, offset, limit);
    crate::file_changes::refresh_live_content_versions(&mut summary, &state);

    Ok(serde_json::json!({
        "runId": state.run_id,
        "executionId": execution_id,
        "executionIds": execution_ids,
        "offset": offset,
        "limit": limit,
        "orderVersion": order_version,
        "summary": summary,
    }))
}
