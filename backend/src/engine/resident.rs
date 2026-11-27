//! Resident process coordination: runtime resource generation, parked Serial
//! shells, retained background service trees, idle reaping, and explicit release.

use serde::{Deserialize, Serialize};
use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

#[cfg(not(feature = "fixture"))]
use super::lingering::{self, LingeringWorker};

pub const DEFAULT_MAX_PARKED_AGENTS: usize = 8;
pub const DEFAULT_PARKED_AGENT_IDLE_TTL: Duration = Duration::from_secs(30 * 60);

#[cfg(not(feature = "fixture"))]
use super::{prewarm::Worker, PiRequest, PiRole, SessionChannels};
#[cfg(not(feature = "fixture"))]
use crate::process_control;
#[cfg(not(feature = "fixture"))]
use std::{
    path::Path,
    sync::{mpsc, OnceLock},
    thread,
    time::Instant,
};

/// Monotonic generation bumped whenever runtime resources loaded at Pi startup
/// (extensions, provider credentials) change. Parked Serial shells capture this
/// generation at launch and are gracefully rotated (preserving background
/// services) if a newer generation is active when the next turn starts.
static RUNTIME_RESOURCE_GENERATION: AtomicU64 = AtomicU64::new(1);

pub fn current_resource_generation() -> u64 {
    RUNTIME_RESOURCE_GENERATION.load(Ordering::Acquire)
}

/// Unified invalidation entrypoint for runtime resource mutations (extension
/// enable/disable, provider auth changes). Bumps the resource generation for
/// resident Serial shells and invalidates prepared & warm-node caches together.
pub fn invalidate_runtime_resources() -> u64 {
    let next = RUNTIME_RESOURCE_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
    #[cfg(not(feature = "fixture"))]
    {
        super::invalidate_prepared_processes();
        super::invalidate_warm_node();
    }
    next
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParkedAgentStatus {
    pub run_id: String,
    pub session_id: String,
    pub repository: String,
    pub idle_secs: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundServiceStatus {
    pub run_id: String,
    pub count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResidentProcessStatus {
    pub resource_generation: u64,
    pub max_parked_agents: usize,
    pub idle_ttl_secs: u64,
    pub parked_agents: Vec<ParkedAgentStatus>,
    pub background_services: Vec<BackgroundServiceStatus>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResidentReleaseScope {
    /// Reclaim idle parked Pi agents while preserving any running background services.
    Agents,
    /// Terminate retained background service trees without touching parked agents.
    Services,
    /// Terminate both parked agents and retained background services.
    All,
}

impl ResidentReleaseScope {
    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw.unwrap_or("all") {
            "agents" => Ok(Self::Agents),
            "services" => Ok(Self::Services),
            "all" => Ok(Self::All),
            other => Err(format!("Unsupported resident release scope: {other}")),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResidentReleaseResult {
    pub released_agents: usize,
    pub released_services: usize,
    pub status: ResidentProcessStatus,
}

#[cfg(not(feature = "fixture"))]
pub(super) struct ParkedSerial {
    pub(super) child: std::process::Child,
    pub(super) tree: process_control::ProcessTree,
    pub(super) channels: SessionChannels,
    pub(super) selection: (String, Option<String>),
    pub(super) resource_generation: u64,
    pub(super) run_id: String,
}

#[cfg(not(feature = "fixture"))]
impl Worker for ParkedSerial {
    fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
    fn retire(mut self) {
        self.tree.terminate();
        let _ = self.child.wait();
        self.tree.mark_reaped_if_empty();
    }
}

#[cfg(not(feature = "fixture"))]
impl LingeringWorker for ParkedSerial {
    fn evict_preserving_services(self, run_id: &str) {
        let effective_run_id = if run_id.is_empty() {
            self.run_id.as_str()
        } else {
            run_id
        };
        reclaim_agent_preserving_services(self.child, self.tree, self.channels, effective_run_id);
    }
}

/// Shut down only the Pi agent process (stdin EOF -> bounded wait -> kill child
/// only) while preserving any surviving background descendants (for example dev
/// servers) in the Run-scoped background services pool.
#[cfg(not(feature = "fixture"))]
pub(super) fn reclaim_agent_preserving_services(
    mut child: std::process::Child,
    tree: process_control::ProcessTree,
    mut channels: SessionChannels,
    run_id: &str,
) {
    channels.parked.store(true, Ordering::Release);
    drop(channels.rpc_sender.take());
    let wait_deadline = Instant::now() + Duration::from_secs(2);
    let exited = loop {
        match child.try_wait() {
            Ok(Some(_)) => break true,
            Ok(None) if Instant::now() >= wait_deadline => break false,
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(_) => break true,
        }
    };
    if !exited {
        let _ = child.kill();
        let _ = child.wait();
    }
    if !run_id.is_empty() && tree.has_live_members() {
        let owner = format!("serial-service:{run_id}:{}", uuid::Uuid::new_v4());
        if process_control::reassign_owner(&tree, &owner).is_ok() {
            planner_services().hold(run_id.to_string(), PlannerServiceTree { tree });
            return;
        }
    }
    if tree.has_live_members() {
        tree.terminate();
    } else {
        tree.mark_reaped_if_empty();
    }
}

#[cfg(not(feature = "fixture"))]
static LINGER_POOL: OnceLock<lingering::Lingering<ParkedSerial>> = OnceLock::new();

#[cfg(not(feature = "fixture"))]
pub(super) fn lingering_pool() -> &'static lingering::Lingering<ParkedSerial> {
    LINGER_POOL.get_or_init(lingering::Lingering::new)
}

#[cfg(not(feature = "fixture"))]
pub(super) fn has_live_lingering(repository: &Path, session_id: &str) -> bool {
    let Some(pool) = LINGER_POOL.get() else {
        return false;
    };
    let Ok(repository) = crate::path_identity::actual_path(repository) else {
        return false;
    };
    pool.has_live(&lingering::SessionKey {
        repository,
        session_id: session_id.to_string(),
    })
}

#[cfg(not(feature = "fixture"))]
pub(super) struct PlannerServiceTree {
    pub(super) tree: process_control::ProcessTree,
}

#[cfg(not(feature = "fixture"))]
impl Worker for PlannerServiceTree {
    fn alive(&mut self) -> bool {
        self.tree.has_live_members()
    }

    fn retire(self) {
        if self.tree.has_live_members() {
            self.tree.terminate();
        } else {
            self.tree.mark_reaped_if_empty();
        }
    }
}

#[cfg(not(feature = "fixture"))]
static PLANNER_SERVICES: OnceLock<lingering::LingeringServices<PlannerServiceTree>> =
    OnceLock::new();

#[cfg(not(feature = "fixture"))]
pub(super) fn planner_services() -> &'static lingering::LingeringServices<PlannerServiceTree> {
    PLANNER_SERVICES.get_or_init(lingering::LingeringServices::new)
}

#[cfg(all(test, not(feature = "fixture")))]
pub(crate) fn planner_service_count_for_run(run_id: &str) -> usize {
    planner_services().count_for_run(run_id)
}

/// Park a throwaway shell for a Run/session so runtime tests can observe that a
/// history edit retires the conversation's parked process.
#[cfg(all(test, not(feature = "fixture")))]
pub(crate) fn park_test_shell(run_id: &str, session_id: &str) -> process_control::ProcessTree {
    use super::composer;
    use std::{
        collections::HashMap,
        path::PathBuf,
        process::Stdio,
        sync::{atomic::AtomicBool, Arc, Mutex},
    };
    let mut command = if cfg!(windows) {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", "ping 127.0.0.1 -n 30 > NUL"]);
        command
    } else {
        let mut command = std::process::Command::new("sh");
        command.args(["-c", "sleep 30"]);
        command
    };
    process_control::configure_command(&mut command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = command.spawn().unwrap();
    let tree = process_control::with_owner(run_id, || process_control::track(&child).unwrap());
    let (_line_tx, receiver) = mpsc::channel::<(bool, String)>();
    let (_input_tx, input_receiver) = mpsc::channel::<Result<(), std::io::Error>>();
    let (rpc_tx, _rpc_rx) = mpsc::channel::<String>();
    let channels = SessionChannels {
        receiver,
        input_receiver,
        rpc_sender: Some(rpc_tx),
        rpc_pending: Some(Arc::new(Mutex::new(HashMap::new()))),
        rpc_ui: Arc::new(Mutex::new(composer::CommandUi::default())),
        parked: Arc::new(AtomicBool::new(true)),
    };
    lingering_pool().park(
        lingering::SessionKey {
            repository: PathBuf::new(),
            session_id: session_id.into(),
        },
        run_id.into(),
        ParkedSerial {
            child,
            tree: tree.clone(),
            channels,
            selection: (String::new(), None),
            resource_generation: current_resource_generation(),
            run_id: run_id.into(),
        },
    );
    tree
}

#[cfg(all(test, not(feature = "fixture")))]
pub(crate) fn parked_shell_count() -> usize {
    lingering_pool().len()
}

/// Stop every parked shell and held background service.
#[cfg(not(feature = "fixture"))]
pub fn stop_lingering() {
    if let Some(pool) = LINGER_POOL.get() {
        pool.shutdown();
    }
    stop_planner_services();
}

/// Retire a Run's parked Serial shells (also used when branching its history).
#[cfg(not(feature = "fixture"))]
pub fn stop_lingering_for_run(run_id: &str) {
    if run_id.is_empty() {
        return;
    }
    if let Some(pool) = LINGER_POOL.get() {
        pool.retire_where(|held| held == run_id);
    }
}

#[cfg(not(feature = "fixture"))]
pub fn stop_planner_services() {
    if let Some(pool) = PLANNER_SERVICES.get() {
        pool.shutdown();
    }
}

#[cfg(not(feature = "fixture"))]
pub fn stop_planner_services_for_run(run_id: &str) {
    if !run_id.is_empty() {
        if let Some(pool) = PLANNER_SERVICES.get() {
            pool.retire_run(run_id);
        }
    }
}

/// Periodically reap idle parked Serial agent shells (preserving live background
/// services) and prune exited background service trees.
#[cfg(not(feature = "fixture"))]
pub fn reap_idle_lingering() -> usize {
    let reaped = LINGER_POOL
        .get()
        .map(lingering::Lingering::reap_idle)
        .unwrap_or(0);
    if let Some(services) = PLANNER_SERVICES.get() {
        services.prune_dead();
    }
    reaped
}

#[cfg(not(feature = "fixture"))]
pub fn resident_process_status() -> ResidentProcessStatus {
    let (max_parked_agents, idle_ttl_secs, parked_agents) = match LINGER_POOL.get() {
        Some(pool) => (
            pool.max_entries(),
            pool.idle_ttl().as_secs(),
            pool.snapshot_entries()
                .into_iter()
                .map(|entry| ParkedAgentStatus {
                    run_id: entry.run_id,
                    session_id: entry.session_id,
                    repository: entry.repository,
                    idle_secs: entry.idle_secs,
                })
                .collect(),
        ),
        None => (
            DEFAULT_MAX_PARKED_AGENTS,
            DEFAULT_PARKED_AGENT_IDLE_TTL.as_secs(),
            Vec::new(),
        ),
    };
    let background_services = match PLANNER_SERVICES.get() {
        Some(services) => services
            .snapshot_by_run()
            .into_iter()
            .map(|(run_id, count)| BackgroundServiceStatus { run_id, count })
            .collect(),
        None => Vec::new(),
    };
    ResidentProcessStatus {
        resource_generation: current_resource_generation(),
        max_parked_agents,
        idle_ttl_secs,
        parked_agents,
        background_services,
    }
}

#[cfg(not(feature = "fixture"))]
pub fn release_resident_processes(
    run_id: Option<&str>,
    scope: ResidentReleaseScope,
) -> ResidentReleaseResult {
    let target_run = run_id.filter(|value| !value.is_empty());
    let mut released_agents = 0;
    let mut released_services = 0;
    match scope {
        ResidentReleaseScope::Agents => {
            if let Some(pool) = LINGER_POOL.get() {
                released_agents = match target_run {
                    Some(run) => pool.evict_where(|held| held == run),
                    None => pool.evict_where(|_| true),
                };
            }
        }
        ResidentReleaseScope::Services => {
            if let Some(services) = PLANNER_SERVICES.get() {
                released_services = match target_run {
                    Some(run) => services.retire_run(run),
                    None => services.shutdown(),
                };
            }
        }
        ResidentReleaseScope::All => {
            if let Some(pool) = LINGER_POOL.get() {
                released_agents = match target_run {
                    Some(run) => pool.retire_where(|held| held == run),
                    None => pool.retire_where(|_| true),
                };
            }
            if let Some(services) = PLANNER_SERVICES.get() {
                released_services = match target_run {
                    Some(run) => services.retire_run(run),
                    None => services.shutdown(),
                };
            }
        }
    }
    ResidentReleaseResult {
        released_agents,
        released_services,
        status: resident_process_status(),
    }
}

#[cfg(not(feature = "fixture"))]
pub(super) fn retain_source_planner_services(
    request: &PiRequest<'_>,
    process_tree: &process_control::ProcessTree,
    settled_response: bool,
    source_role: bool,
) -> bool {
    if request.role != PiRole::Planner
        || !source_role
        || !settled_response
        || request.session_id.is_none()
        || !process_tree.has_live_members()
    {
        return false;
    }
    let Some(run_id) = request
        .environment
        .iter()
        .find(|(key, _)| *key == "PI_N_ACTIVE_RUN_ID")
        .map(|(_, run_id)| run_id.clone())
        .filter(|run_id| !run_id.is_empty())
    else {
        return false;
    };
    let owner = format!("planner-service:{run_id}:{}", uuid::Uuid::new_v4());
    if let Err(error) = process_control::reassign_owner(process_tree, &owner) {
        eprintln!("[Pi^n] Could not retain source Planner background services: {error}");
        return false;
    }
    planner_services().hold(
        run_id,
        PlannerServiceTree {
            tree: process_tree.clone(),
        },
    );
    true
}

#[cfg(feature = "fixture")]
pub fn stop_lingering() {}
#[cfg(feature = "fixture")]
pub fn stop_lingering_for_run(_run_id: &str) {}
#[cfg(feature = "fixture")]
pub fn stop_planner_services() {}
#[cfg(feature = "fixture")]
pub fn stop_planner_services_for_run(_run_id: &str) {}
#[cfg(feature = "fixture")]
pub fn reap_idle_lingering() -> usize {
    0
}
#[cfg(feature = "fixture")]
pub fn resident_process_status() -> ResidentProcessStatus {
    ResidentProcessStatus {
        resource_generation: current_resource_generation(),
        max_parked_agents: DEFAULT_MAX_PARKED_AGENTS,
        idle_ttl_secs: DEFAULT_PARKED_AGENT_IDLE_TTL.as_secs(),
        parked_agents: Vec::new(),
        background_services: Vec::new(),
    }
}
#[cfg(feature = "fixture")]
pub fn release_resident_processes(
    _run_id: Option<&str>,
    _scope: ResidentReleaseScope,
) -> ResidentReleaseResult {
    ResidentReleaseResult {
        released_agents: 0,
        released_services: 0,
        status: resident_process_status(),
    }
}

/// Serial Agent sessions are the only parked Pi shells. Their model role is
/// `NodeAgent`, but only an explicit Serial identity may enter this pool.
#[cfg(not(feature = "fixture"))]
pub(super) fn serial_linger_key(request: &PiRequest<'_>) -> Option<lingering::SessionKey> {
    // A Serial Agent is never identified by cwd alone: source-direct Graph Node
    // Agents can also run from the bound source and must not claim parked shells.
    let agent_kind = request
        .environment
        .iter()
        .find(|(key, _)| *key == "PI_N_AGENT_KIND")
        .map(|(_, value)| value.as_str());
    if request.role != PiRole::NodeAgent
        || agent_kind != Some("serial")
        || request.config.environment.is_some()
    {
        return None;
    }
    let session_id = request.session_id?;
    let cwd = crate::path_identity::actual_path(request.cwd).ok()?;
    let repository =
        crate::path_identity::actual_path(Path::new(&request.config.repository)).ok()?;
    if !crate::path_identity::same_path(&cwd, &repository) {
        return None;
    }
    Some(lingering::SessionKey {
        repository,
        session_id: session_id.to_string(),
    })
}

// A settled Serial shell can still be parked when later workspace/protocol
// finalization fails. Do not resume it with stale model settings on retry.
#[cfg(not(feature = "fixture"))]
pub(super) fn serial_selection(request: &PiRequest<'_>) -> (String, Option<String>) {
    let thinking = request
        .extra_args
        .windows(2)
        .find(|args| args[0] == "--thinking")
        .map(|args| args[1].to_string());
    (request.config.model.clone(), thinking)
}

#[cfg(not(feature = "fixture"))]
const PARKED_RPC_SWITCH_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg(not(feature = "fixture"))]
fn send_parked_rpc(
    host: &mut ParkedSerial,
    mut payload: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let sender = host
        .channels
        .rpc_sender
        .as_ref()
        .ok_or_else(|| "Parked session has no RPC input".to_string())?;
    let rpc_id = uuid::Uuid::new_v4().to_string();
    payload["id"] = serde_json::Value::String(rpc_id.clone());
    sender
        .send(payload.to_string())
        .map_err(|error| format!("Cannot send RPC to parked session: {error}"))?;
    let deadline = Instant::now() + timeout;
    loop {
        process_control::check_current_owner_stop()?;
        if let Ok(Err(error)) = host.channels.input_receiver.try_recv() {
            return Err(format!("Cannot write RPC to parked session: {error}"));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Timed out waiting for parked session RPC response".into());
        }
        match host
            .channels
            .receiver
            .recv_timeout(remaining.min(Duration::from_millis(50)))
        {
            Ok((true, _)) => continue,
            Ok((false, line)) => {
                let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                if event["type"].as_str() == Some("response")
                    && event["id"].as_str() == Some(rpc_id.as_str())
                {
                    if event["success"].as_bool() == Some(true) {
                        return Ok(event);
                    }
                    let error = event["error"]
                        .as_str()
                        .unwrap_or("Parked session rejected RPC command");
                    return Err(error.to_string());
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("Parked session exited before replying to RPC".into());
            }
        }
    }
}

#[cfg(not(feature = "fixture"))]
fn resolve_parked_model_target(
    host: &mut ParkedSerial,
    desired_model: &str,
    timeout: Duration,
) -> Result<(String, String), String> {
    let slash_count = desired_model.bytes().filter(|&b| b == b'/').count();
    if slash_count == 1 {
        if let Some((provider, model_id)) = desired_model.split_once('/') {
            if !provider.is_empty() && !model_id.is_empty() {
                return Ok((provider.to_string(), model_id.to_string()));
            }
        }
    }
    let response = send_parked_rpc(
        host,
        serde_json::json!({ "type": "get_available_models" }),
        timeout,
    )?;
    let models = response["data"]["models"]
        .as_array()
        .ok_or_else(|| "Missing models array in get_available_models response".to_string())?;
    models
        .iter()
        .find_map(|entry| {
            let provider = entry["provider"].as_str()?;
            let id = entry["id"].as_str()?;
            if format!("{provider}/{id}") == desired_model
                || (slash_count == 0 && id == desired_model)
            {
                Some((provider.to_string(), id.to_string()))
            } else {
                None
            }
        })
        .ok_or_else(|| format!("Model not found in parked session: {desired_model}"))
}

#[cfg(not(feature = "fixture"))]
fn switch_parked_serial_selection(
    host: &mut ParkedSerial,
    desired: &(String, Option<String>),
    timeout: Duration,
) -> Result<(), String> {
    let (current_model, current_thinking) = &host.selection;
    let (desired_model, desired_thinking) = desired;
    let model_changed = current_model != desired_model;
    let thinking_changed = current_thinking != desired_thinking;
    if !model_changed && !thinking_changed {
        return Ok(());
    }
    let target_thinking = desired_thinking
        .as_deref()
        .map(str::trim)
        .filter(|level| !level.is_empty());
    if thinking_changed && target_thinking.is_none() {
        return Err("Cannot clear thinking level in-place without an explicit target level".into());
    }
    process_control::check_current_owner_stop()?;
    while host.channels.receiver.try_recv().is_ok() {}
    while host.channels.input_receiver.try_recv().is_ok() {}
    host.channels.parked.store(false, Ordering::Release);
    if model_changed {
        let (provider, model_id) = resolve_parked_model_target(host, desired_model, timeout)?;
        send_parked_rpc(
            host,
            serde_json::json!({
                "type": "set_model",
                "provider": provider,
                "modelId": model_id,
            }),
            timeout,
        )?;
    }
    // `set_model` in Pi applies its own per-model/default thinking level, so
    // always follow up with `set_thinking_level` whenever model or thinking changed.
    if let Some(level) = target_thinking {
        send_parked_rpc(
            host,
            serde_json::json!({
                "type": "set_thinking_level",
                "level": level,
            }),
            timeout,
        )?;
    }
    host.selection = desired.clone();
    Ok(())
}

#[cfg(not(feature = "fixture"))]
pub(super) fn claim_matching_serial(request: &PiRequest<'_>) -> Option<ParkedSerial> {
    let key = serial_linger_key(request)?;
    let mut host = lingering_pool().claim(&key)?;
    let expected_generation = current_resource_generation();
    if host.resource_generation != expected_generation {
        eprintln!(
            "[Pi^n] Parked Serial resource generation stale ({} != {}); rotating agent while preserving background services",
            host.resource_generation, expected_generation
        );
        let run_id = host.run_id.clone();
        host.evict_preserving_services(&run_id);
        return None;
    }
    let desired = serial_selection(request);
    if host.selection == desired {
        return Some(host);
    }
    match switch_parked_serial_selection(&mut host, &desired, PARKED_RPC_SWITCH_TIMEOUT) {
        Ok(()) => Some(host),
        Err(error) => {
            eprintln!("[Pi^n] Parked Serial in-place model switch failed ({error}); rotating agent while preserving background services");
            let run_id = host.run_id.clone();
            host.evict_preserving_services(&run_id);
            None
        }
    }
}
