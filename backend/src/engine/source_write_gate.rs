//! Cooperative single-sided wait for active source-workspace write tools.
//!
//! Direct (Serial) and other source-native runs stream `tool_execution_start`
//! and `tool_execution_end` events through `engine::run_turn`. Tracking active
//! mutating tools per canonical repository lets Compile's source snapshots and
//! publication deliveries pause briefly until an in-flight write/edit/bash call
//! finishes, without intercepting or altering Serial's native tool execution.
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Condvar, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

pub(crate) const INITIAL_SOURCE_WRITE_WAIT: Duration = Duration::from_secs(4);
pub(crate) const LOCKED_SOURCE_WRITE_WAIT: Duration = Duration::from_millis(1500);

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum OwnerKey {
    Run(String),
    Anonymous(u64),
}

#[derive(Default)]
struct GateState {
    /// repo_key -> (owner -> active mutating tool count)
    active: HashMap<String, HashMap<OwnerKey, usize>>,
}

struct Gate {
    state: Mutex<GateState>,
    changed: Condvar,
}

impl Gate {
    fn new() -> Self {
        Self {
            state: Mutex::new(GateState::default()),
            changed: Condvar::new(),
        }
    }

    fn add(&self, repo_key: &str, owner: &OwnerKey, delta: usize) {
        if delta == 0 {
            return;
        }
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let entry = guard
            .active
            .entry(repo_key.to_string())
            .or_default()
            .entry(owner.clone())
            .or_insert(0);
        *entry = entry.saturating_add(delta);
    }

    fn sub(&self, repo_key: &str, owner: &OwnerKey, delta: usize) {
        if delta == 0 {
            return;
        }
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut became_idle = false;
        if let Some(owners) = guard.active.get_mut(repo_key) {
            if let Some(count) = owners.get_mut(owner) {
                *count = count.saturating_sub(delta);
                if *count == 0 {
                    owners.remove(owner);
                    became_idle = true;
                }
            }
            if owners.is_empty() {
                guard.active.remove(repo_key);
                became_idle = true;
            }
        }
        drop(guard);
        if became_idle {
            self.changed.notify_all();
        }
    }

    fn has_other_active(&self, guard: &GateState, repo_key: &str, exclude_run: Option<&str>) -> bool {
        let Some(owners) = guard.active.get(repo_key) else {
            return false;
        };
        owners.iter().any(|(owner, count)| {
            *count > 0
                && !matches!(
                    (owner, exclude_run),
                    (OwnerKey::Run(id), Some(excluded)) if !excluded.is_empty() && id == excluded
                )
        })
    }

    fn wait_idle(
        &self,
        repo_key: &str,
        exclude_run: Option<&str>,
        max_wait: Duration,
    ) -> Result<bool, String> {
        let deadline = Instant::now() + max_wait;
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if !self.has_other_active(&guard, repo_key, exclude_run) {
                return Ok(true);
            }
            crate::process_control::check_current_owner_stop()?;
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return Ok(false);
            };
            if remaining.is_zero() {
                return Ok(false);
            }
            let slice = remaining.min(Duration::from_millis(50));
            let (next, _) = self
                .changed
                .wait_timeout(guard, slice)
                .unwrap_or_else(|e| e.into_inner());
            guard = next;
        }
    }
}

fn gate() -> &'static Gate {
    static GATE: OnceLock<Gate> = OnceLock::new();
    GATE.get_or_init(Gate::new)
}

fn next_anonymous_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

pub(crate) fn is_mutating_source_tool(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "write"
            | "edit"
            | "bash"
            | "powershell"
            | "apply_patch"
            | "multi_edit"
            | "notebook_edit"
            | "delete"
            | "rm"
    )
}

/// Per-turn RAII tracker attached to turns running directly in a source
/// repository. Dropping the tracker releases any unclosed tool counts so a
/// crashed or aborted process can never leave the gate stuck.
pub(crate) struct SourceWriteTracker {
    repo_key: String,
    owner: OwnerKey,
    active_ids: HashSet<String>,
    unnamed_active: usize,
}

impl SourceWriteTracker {
    pub(crate) fn new(repository: &Path, run_id: Option<&str>) -> Self {
        let owner = match run_id.filter(|id| !id.is_empty()) {
            Some(id) => OwnerKey::Run(id.to_string()),
            None => OwnerKey::Anonymous(next_anonymous_id()),
        };
        Self {
            repo_key: crate::path_identity::path_key(repository),
            owner,
            active_ids: HashSet::new(),
            unnamed_active: 0,
        }
    }

    pub(crate) fn observe_event(&mut self, event: &Value) {
        let Some(kind) = event.get("type").and_then(Value::as_str) else {
            return;
        };
        match kind {
            "tool_execution_start" => {
                let Some(tool_name) = event.get("toolName").and_then(Value::as_str) else {
                    return;
                };
                if !is_mutating_source_tool(tool_name) {
                    return;
                }
                if let Some(id) = event
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    if self.active_ids.insert(id.to_string()) {
                        gate().add(&self.repo_key, &self.owner, 1);
                    }
                } else {
                    self.unnamed_active = self.unnamed_active.saturating_add(1);
                    gate().add(&self.repo_key, &self.owner, 1);
                }
            }
            "tool_execution_end" => {
                if let Some(id) = event
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    if self.active_ids.remove(id) {
                        gate().sub(&self.repo_key, &self.owner, 1);
                    }
                } else if self.unnamed_active > 0
                    && event
                        .get("toolName")
                        .and_then(Value::as_str)
                        .is_none_or(is_mutating_source_tool)
                {
                    self.unnamed_active -= 1;
                    gate().sub(&self.repo_key, &self.owner, 1);
                }
            }
            "agent_end" | "agent_settled" => {
                self.release_all();
            }
            _ => {}
        }
    }

    fn release_all(&mut self) {
        let remaining = self.active_ids.len().saturating_add(self.unnamed_active);
        self.active_ids.clear();
        self.unnamed_active = 0;
        if remaining > 0 {
            gate().sub(&self.repo_key, &self.owner, remaining);
        }
    }
}

impl Drop for SourceWriteTracker {
    fn drop(&mut self) {
        self.release_all();
    }
}

/// Wait up to `max_wait` for active mutating tools from other runs on
/// `repository` to finish. Returns `Ok(true)` when idle, `Ok(false)` when
/// `max_wait` elapsed, or `Err` if the current owner was stopped.
pub(crate) fn wait_for_source_writers_idle(
    repository: &Path,
    max_wait: Duration,
) -> Result<bool, String> {
    if max_wait.is_zero() {
        crate::process_control::check_current_owner_stop()?;
        return Ok(false);
    }
    let repo_key = crate::path_identity::path_key(repository);
    let current = crate::process_control::current_owner();
    let exclude = current
        .as_deref()
        .map(|owner| owner.split(':').next().unwrap_or(owner));
    gate().wait_idle(&repo_key, exclude, max_wait)
}

/// Wait for active source writers using a shared remaining `budget`, deducting
/// the elapsed wait time so retries cannot multiply the maximum stall.
pub(crate) fn wait_for_source_writers_with_budget(
    repository: &Path,
    budget: &mut Duration,
) -> Result<bool, String> {
    if budget.is_zero() {
        crate::process_control::check_current_owner_stop()?;
        return Ok(false);
    }
    let started = Instant::now();
    let idle = wait_for_source_writers_idle(repository, *budget)?;
    *budget = budget.saturating_sub(started.elapsed());
    Ok(idle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn waits_for_other_runs_mutating_tool_and_wakes_on_end() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        let mut tracker = SourceWriteTracker::new(repo, Some("direct-run"));
        tracker.observe_event(&json!({
            "type": "tool_execution_start",
            "toolCallId": "call-1",
            "toolName": "write"
        }));

        let repo_wait = repo.to_path_buf();
        let started = Instant::now();
        let waiter = std::thread::spawn(move || {
            crate::process_control::with_owner("compile-run", || {
                wait_for_source_writers_idle(&repo_wait, Duration::from_secs(2))
            })
        });
        std::thread::sleep(Duration::from_millis(60));
        tracker.observe_event(&json!({
            "type": "tool_execution_end",
            "toolCallId": "call-1"
        }));
        assert_eq!(waiter.join().unwrap().unwrap(), true);
        assert!(started.elapsed() >= Duration::from_millis(50));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn ignores_read_only_tools_and_same_run_owner() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        let mut tracker = SourceWriteTracker::new(repo, Some("same-run"));
        tracker.observe_event(&json!({
            "type": "tool_execution_start",
            "toolCallId": "r1",
            "toolName": "read"
        }));
        assert_eq!(
            crate::process_control::with_owner("other-run", || {
                wait_for_source_writers_idle(repo, Duration::from_millis(200))
            })
            .unwrap(),
            true
        );

        tracker.observe_event(&json!({
            "type": "tool_execution_start",
            "toolCallId": "b1",
            "toolName": "bash"
        }));
        // Same run (including scoped execution owners) never waits on itself.
        assert_eq!(
            crate::process_control::with_owner("same-run:node:a:execution:1", || {
                wait_for_source_writers_idle(repo, Duration::from_millis(200))
            })
            .unwrap(),
            true
        );
        // Another run times out cleanly when the tool stays active past max_wait.
        assert_eq!(
            crate::process_control::with_owner("other-run", || {
                wait_for_source_writers_idle(repo, Duration::from_millis(60))
            })
            .unwrap(),
            false
        );
    }

    #[test]
    fn drop_releases_unclosed_tool_calls() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        {
            let mut tracker = SourceWriteTracker::new(repo, Some("crashed-direct"));
            tracker.observe_event(&json!({
                "type": "tool_execution_start",
                "toolCallId": "c1",
                "toolName": "edit"
            }));
            tracker.observe_event(&json!({
                "type": "tool_execution_start",
                "toolName": "bash"
            }));
        }
        assert_eq!(
            crate::process_control::with_owner("compile-run", || {
                wait_for_source_writers_idle(repo, Duration::from_millis(100))
            })
            .unwrap(),
            true
        );
    }

    #[test]
    fn wait_aborts_promptly_when_current_owner_is_stopped() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        let mut tracker = SourceWriteTracker::new(repo, Some("direct-run"));
        tracker.observe_event(&json!({
            "type": "tool_execution_start",
            "toolCallId": "slow-bash",
            "toolName": "bash"
        }));
        let owner = format!("stop-compile-{}", uuid::Uuid::new_v4());
        let owner_to_stop = owner.clone();
        let repo_wait = repo.to_path_buf();
        let started = Instant::now();
        let waiter = std::thread::spawn(move || {
            crate::process_control::with_owner(&owner, || {
                wait_for_source_writers_idle(&repo_wait, Duration::from_secs(5))
            })
        });
        std::thread::sleep(Duration::from_millis(60));
        crate::process_control::stop_owner(&owner_to_stop).unwrap();
        let result = waiter.join().unwrap();
        crate::process_control::clear_owner_stop(&owner_to_stop);
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn collect_source_snapshot_waits_for_active_direct_write_tool() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("source");
        std::fs::create_dir(&repo).unwrap();
        crate::workspace::git(&repo, &["init", "-q"]).unwrap();
        std::fs::write(repo.join("base.txt"), "base\n").unwrap();
        crate::workspace::git(&repo, &["add", "-A"]).unwrap();
        crate::workspace::git(&repo, &["commit", "-qm", "base"]).unwrap();

        let mut tracker = SourceWriteTracker::new(&repo, Some("direct-run"));
        tracker.observe_event(&json!({
            "type": "tool_execution_start",
            "toolCallId": "write-1",
            "toolName": "write"
        }));

        let repo_snap = repo.clone();
        let snapshotter = std::thread::spawn(move || {
            crate::process_control::with_owner("compile-run", || {
                crate::runtime::collect_source_snapshot(&repo_snap, &[], true)
            })
        });
        std::thread::sleep(Duration::from_millis(80));
        std::fs::write(repo.join("direct.txt"), "written before tool end\n").unwrap();
        tracker.observe_event(&json!({
            "type": "tool_execution_end",
            "toolCallId": "write-1"
        }));

        let head = snapshotter.join().unwrap().unwrap();
        assert_eq!(
            crate::workspace::repository_git(&repo, &["show", &format!("{head}:direct.txt")])
                .unwrap(),
            "written before tool end"
        );
    }

    #[test]
    fn unnamed_read_end_does_not_release_active_unnamed_mutating_tool_and_budget_caps_wait() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        let mut tracker = SourceWriteTracker::new(repo, Some("direct-run"));
        tracker.observe_event(&json!({
            "type": "tool_execution_start",
            "toolName": "bash"
        }));
        tracker.observe_event(&json!({
            "type": "tool_execution_start",
            "toolName": "read"
        }));
        // Ending the unnamed read tool must NOT prematurely clear the active bash tool.
        tracker.observe_event(&json!({
            "type": "tool_execution_end",
            "toolName": "read"
        }));
        let mut budget = Duration::from_millis(80);
        assert_eq!(
            crate::process_control::with_owner("compile-run", || {
                wait_for_source_writers_with_budget(repo, &mut budget)
            })
            .unwrap(),
            false
        );
        // Budget is now exhausted; a subsequent call returns immediately without waiting.
        let started = Instant::now();
        assert_eq!(
            crate::process_control::with_owner("compile-run", || {
                wait_for_source_writers_with_budget(repo, &mut budget)
            })
            .unwrap(),
            false
        );
        assert!(started.elapsed() < Duration::from_millis(40));

        // agent_settled clears any remaining active count.
        tracker.observe_event(&json!({ "type": "agent_settled" }));
        assert_eq!(
            crate::process_control::with_owner("compile-run", || {
                wait_for_source_writers_idle(repo, Duration::from_millis(100))
            })
            .unwrap(),
            true
        );
    }
}
