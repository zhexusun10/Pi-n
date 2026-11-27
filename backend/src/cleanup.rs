//! Durable, narrowly scoped cleanup. Database deletion and its cleanup manifest
//! commit together; failed filesystem operations never lose their ownership.
use crate::{
    model::{Config, EventKind, Snapshot},
    path_safety::real_child_path,
    store::Store,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub(crate) mod detached;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Target {
    Data {
        bucket: String,
        id: String,
    },
    Workspace {
        parent: PathBuf,
        bucket: String,
        owner: String,
        checkout: Option<String>,
    },
    Shadow {
        root: PathBuf,
        name: String,
        /// Source binding owned when this target was recorded. Used to serialize
        /// live ref/object reclamation with Pi^n Git work on that source.
        #[serde(deserialize_with = "Option::deserialize")]
        source: Option<PathBuf>,
    },
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub targets: BTreeSet<Target>,
    /// None: deleted conversation; Some: workspace-only cleanup at this event.
    pub sequence: Option<i64>,
    pub protected_sources: BTreeSet<PathBuf>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub unresolved_repository: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub run_id: String,
    pub manifest: Manifest,
    pub attempts: usize,
    pub last_error: Option<String>,
}

fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub(crate) fn is_publication_workspace_checkout(checkout: &str) -> bool {
    let is_hex16 = |value: &str| value.len() == 16 && value.bytes().all(|b| b.is_ascii_hexdigit());
    if let Some(rest) = checkout.strip_prefix("publication-files-") {
        if let Some(hex) = rest.strip_suffix(".publication") {
            return is_hex16(hex);
        }
        return is_hex16(rest);
    }
    if let Some(hex) = checkout.strip_prefix("publication-view-") {
        return is_hex16(hex);
    }
    false
}

pub(crate) fn valid_workspace_checkout(checkout: &str) -> bool {
    if let Some(git) = checkout.strip_prefix(".pi-n-git/") {
        return git
            .strip_suffix(".git")
            .is_some_and(|hex| hex.len() == 16 && hex.bytes().all(|b| b.is_ascii_hexdigit()));
    }
    if let Some(state) = checkout.strip_prefix(".pi-n-state/") {
        return state.len() == 16 && state.bytes().all(|b| b.is_ascii_hexdigit());
    }
    if is_publication_workspace_checkout(checkout) {
        return true;
    }
    !checkout.is_empty()
        && checkout != "."
        && checkout != ".."
        && !checkout.contains(['/', '\\', '\0'])
        && !checkout.starts_with(".pi-n-cleanup-")
        && checkout != ".files"
        && checkout != ".pi-n-git"
        && checkout != ".pi-n-state"
        && !checkout.starts_with("publication-")
}

impl Target {
    pub fn data(bucket: &str, id: &str) -> Self {
        Self::Data {
            bucket: bucket.into(),
            id: id.into(),
        }
    }

    fn location(&self, data: &Path, run_id: &str) -> Result<(PathBuf, PathBuf), String> {
        let location = match self {
            Self::Data { bucket, id } => {
                if !matches!(
                    bucket.as_str(),
                    "sessions"
                        | "planning"
                        | "mergers"
                        | "planner-sessions"
                        | "environments"
                        | "file-changes"
                        | "attachment-inputs"
                ) || !safe_id(id)
                {
                    return Err("Invalid owned session directory".into());
                }
                (data.to_path_buf(), data.join(bucket).join(id))
            }
            Self::Workspace {
                parent,
                bucket,
                owner,
                checkout,
            } => {
                if !parent.is_absolute()
                    || bucket != ".pi-n-worktrees"
                    || Uuid::parse_str(owner).is_err()
                    || owner != run_id
                    || checkout
                        .as_deref()
                        .is_some_and(|slot| !valid_workspace_checkout(slot))
                {
                    return Err("Invalid owned workspace directory".into());
                }
                let run_dir = parent.join(bucket).join(owner);
                let target = match checkout {
                    Some(slot) => run_dir.join(slot),
                    None => run_dir,
                };
                (parent.clone(), target)
            }
            Self::Shadow { root, name, .. } => {
                let valid = name
                    .strip_suffix(".git")
                    .and_then(|name| name.rsplit_once('_'))
                    .is_some_and(|(project, hash)| {
                        !project.is_empty()
                            && !project.contains(['/', '\\'])
                            && hash.len() == 16
                            && hash.chars().all(|c| c.is_ascii_hexdigit())
                    });
                if !root.is_absolute() || !valid {
                    return Err("Invalid owned shadow repository".into());
                }
                (root.clone(), root.join("shadow_repos").join(name))
            }
        };
        Ok(location)
    }

    pub(crate) fn resolve(&self, data: &Path, run_id: &str) -> Result<Option<PathBuf>, String> {
        let (root, child) = self.location(data, run_id)?;
        if !root.exists() {
            match fs::symlink_metadata(&root) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error.to_string()),
                Ok(_) => {
                    return Err(format!(
                        "Refusing missing or linked cleanup root: {}",
                        root.display()
                    ))
                }
            }
        }
        real_child_path(&root, &child, false)
    }

    fn workspace(parent: &Path, run_id: &str, bucket: &str) -> Self {
        Self::Workspace {
            parent: parent.to_path_buf(),
            bucket: bucket.into(),
            owner: run_id.into(),
            checkout: None,
        }
    }

    pub(crate) fn workspace_checkout(
        parent: &Path,
        run_id: &str,
        checkout: impl Into<String>,
    ) -> Self {
        Self::Workspace {
            parent: parent.to_path_buf(),
            bucket: ".pi-n-worktrees".into(),
            owner: run_id.into(),
            checkout: Some(checkout.into()),
        }
    }
}

/// Record physical workspace ownership while the source still exists, before
/// any checkout is allocated. A moved/deleted source no longer loses this proof.
pub(crate) fn configuration_targets(
    root: &Path,
    run_id: &str,
    config: &Config,
    include_shadow: bool,
) -> Result<BTreeSet<Target>, String> {
    let mut targets = BTreeSet::new();
    if config.environment.is_some() && Uuid::parse_str(run_id).is_ok() {
        targets.insert(Target::data("environments", run_id));
    }
    let source = Path::new(&config.repository);
    if !source.is_absolute() {
        return Ok(targets);
    }
    let source = match source.canonicalize() {
        Ok(source) if source.is_dir() => {
            crate::path_identity::actual_path(&source).unwrap_or(source)
        }
        Ok(_) => return Ok(targets),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(targets),
        Err(error) => return Err(error.to_string()),
    };
    if Uuid::parse_str(run_id).is_ok() {
        let parent = crate::workspace::workspaces_parent(root);
        fs::create_dir_all(&parent).map_err(|error| error.to_string())?;
        let parent = parent
            .canonicalize()
            .map(|resolved| crate::path_identity::actual_path(&resolved).unwrap_or(resolved))
            .map_err(|error| error.to_string())?;
        targets.insert(Target::workspace(&parent, run_id, ".pi-n-worktrees"));
    }
    if include_shadow {
        let shadow = crate::workspace::shadow_repo_dir(&source)?;
        if fs::symlink_metadata(&shadow).is_ok() {
            targets.insert(Target::Shadow {
                root: crate::workspace::data_root(),
                name: shadow
                    .file_name()
                    .ok_or("Invalid shadow directory")?
                    .to_string_lossy()
                    .into_owned(),
                source: Some(source.clone()),
            });
        }
    }
    Ok(targets)
}

pub(crate) fn remember_event(
    root: &Path,
    store: &Store,
    state: &Snapshot,
    kind: &EventKind,
) -> Result<(), String> {
    remember_event_with_plan_type(root, store, state, kind, state.plan_type.as_deref())
}

pub(crate) fn remember_event_with_plan_type(
    root: &Path,
    store: &Store,
    state: &Snapshot,
    kind: &EventKind,
    plan_type: Option<&str>,
) -> Result<(), String> {
    let mut targets = BTreeSet::new();
    let config = match kind {
        EventKind::Created { config, .. }
        | EventKind::PlanningStarted { config, .. }
        | EventKind::DraftEdited { config, .. } => Some(config),
        EventKind::Approved { .. }
        | EventKind::Started { .. }
        | EventKind::MergerStarted { .. }
        | EventKind::GraphRevised { .. }
        | EventKind::ManualGraphRevised { .. } => state.config.as_ref(),
        _ => None,
    };
    if let Some(config) = config {
        store.remember_cleanup_source(Path::new(&config.repository))?;
        let include_shadow = plan_type != Some("serial")
            && !matches!(kind, EventKind::PlanningStarted { .. });
        targets.extend(configuration_targets(
            root,
            &state.run_id,
            config,
            include_shadow,
        )?);
    }
    match kind {
        EventKind::EnvironmentPolicyResolved {
            environment: Some(_),
            ..
        } => {
            targets.insert(Target::data("environments", &state.run_id));
        }
        EventKind::Started { execution, .. } => {
            targets.insert(Target::data("sessions", &execution.id));
        }
        EventKind::MergerStarted { execution } => {
            targets.insert(Target::data("mergers", &execution.id));
        }
        EventKind::Routed {
            images: Some(images),
            ..
        }
        | EventKind::PlannerSteerSubmitted {
            images: Some(images),
            ..
        }
        | EventKind::NodeInputBound {
            images: Some(images),
            ..
        }
        | EventKind::Steered {
            images: Some(images),
            ..
        }
        | EventKind::NodeMessaged {
            images: Some(images),
            ..
        }
        | EventKind::Invalidated {
            images: Some(images),
            ..
        }
        | EventKind::ConversationEdited {
            images: Some(images),
            ..
        } => {
            crate::attachment_inputs::adopt_images_for_run(root, store, &state.run_id, images)?;
        }
        _ => {}
    }
    if !targets.is_empty() {
        store.remember_cleanup_targets(&state.run_id, &targets)?;
    }
    Ok(())
}

pub(crate) fn manifest(
    root: &Path,
    store: &Store,
    state: &Snapshot,
    deleted: bool,
) -> Result<Manifest, String> {
    let mut targets = store.owned_cleanup_targets(&state.run_id)?;
    if let Some(config) = &state.config {
        let include_shadow = state.plan_type.as_deref() != Some("serial");
        match configuration_targets(root, &state.run_id, config, include_shadow) {
            Ok(current) => targets.extend(current),
            Err(_)
                if targets
                    .iter()
                    .any(|target| matches!(target, Target::Workspace { .. })) => {}
            Err(error) => return Err(error),
        }
    }
    let planning = crate::workspace_cleanup::planning_ids(root, state)?;
    let unresolved_repository = state
        .config
        .as_ref()
        .filter(|config| {
            Path::new(&config.repository).is_absolute()
                && !Path::new(&config.repository).is_dir()
                && Uuid::parse_str(&state.run_id).is_ok()
                && !targets
                    .iter()
                    .any(|target| matches!(target, Target::Workspace { .. }))
        })
        .map(|config| config.repository.clone());
    if deleted {
        for execution in &state.executions {
            targets.insert(Target::data("sessions", &execution.id));
        }
        for execution in &state.mergers {
            targets.insert(Target::data("mergers", &execution.id));
        }
        for event in &state.events {
            match &event.kind {
                EventKind::Started { execution, .. } => {
                    targets.insert(Target::data("sessions", &execution.id));
                }
                EventKind::MergerStarted { execution } => {
                    targets.insert(Target::data("mergers", &execution.id));
                }
                _ => {}
            }
        }
        for id in planning {
            targets.insert(Target::data("planning", &id));
        }
        if safe_id(&state.run_id) {
            targets.insert(Target::data("planner-sessions", &state.run_id));
            targets.insert(Target::data("file-changes", &state.run_id));
            targets.insert(Target::data(
                crate::attachment_inputs::BUCKET,
                &state.run_id,
            ));
        }
    } else {
        targets.retain(|target| matches!(target, Target::Workspace { .. }));
    }
    let mut protected_sources = store.cleanup_sources()?;
    let mut protect = |config: &Config| {
        let path = PathBuf::from(&config.repository);
        if path.is_absolute() {
            let resolved = crate::path_identity::actual_path(&path)
                .or_else(|_| path.canonicalize())
                .unwrap_or(path);
            protected_sources.insert(resolved);
        }
    };
    if let Some(config) = &state.config {
        protect(config);
    }
    for event in &state.events {
        if let EventKind::Created { config, .. }
        | EventKind::PlanningStarted { config, .. }
        | EventKind::DraftEdited { config, .. } = &event.kind
        {
            protect(config);
        }
    }
    let manifest = Manifest {
        targets,
        sequence: if deleted {
            None
        } else {
            Some(state.events.last().map_or(0, |event| event.sequence))
        },
        protected_sources,
        unresolved_repository,
    };
    if deleted {
        validate(root, &state.run_id, &manifest)?;
    }
    Ok(manifest)
}

pub(crate) fn validate(root: &Path, run_id: &str, manifest: &Manifest) -> Result<(), String> {
    for target in &manifest.targets {
        target.resolve(root, run_id)?;
    }
    Ok(())
}

/// Commits that another live Run may still resolve while its node results are
/// prepared. They keep their `refs/pi-n/heads/*` pins during a deleted Run's
/// object reclamation even if no current ref points at them yet.
pub(crate) fn protected_shadow_objects_for_repository(
    store: &Store,
    excluded: &str,
    repository: Option<&Path>,
) -> Result<BTreeSet<String>, String> {
    let target_shadow = repository.and_then(|repo| crate::workspace::shadow_repo_dir(repo).ok());
    let mut protected = BTreeSet::new();
    for id in store.runs()? {
        if id == excluded {
            continue;
        }
        let state: Snapshot = store.load(&id)?;
        if let Some(target_repo) = repository {
            let run_repo = state
                .config
                .as_ref()
                .map(|c| Path::new(&c.repository))
                .filter(|p| !p.as_os_str().is_empty());
            let same_repo = match run_repo {
                Some(run_repo) => {
                    crate::path_identity::same_path(run_repo, target_repo)
                        || target_shadow.as_ref().is_some_and(|expected| {
                            crate::workspace::shadow_repo_dir(run_repo)
                                .ok()
                                .is_some_and(|actual| actual == *expected)
                        })
                }
                None => false,
            };
            if !same_repo {
                continue;
            }
        }
        let mut add = |head: &str| {
            if !head.is_empty() {
                protected.insert(head.to_string());
            }
        };
        add(&state.base);
        if let Some(head) = &state.published_head {
            add(head);
        }
        for head in &state.published_heads {
            add(head);
        }
        for node in state.nodes.values() {
            if let Some(head) = &node.head {
                add(head);
            }
            if let Some(input) = &node.feedback_workspace {
                for source in input.sources() {
                    add(&source.head);
                }
            }
        }
        for execution in state.executions.iter().chain(state.mergers.iter()) {
            add(&execution.before);
            if let Some(head) = &execution.after {
                add(head);
            }
        }
        for event in &state.events {
            match &event.kind {
                EventKind::Approved { base } => add(base),
                EventKind::SourceSnapshotted { head }
                | EventKind::PublicationCompleted { head }
                | EventKind::Prepared { head, .. }
                | EventKind::WorkspaceResolved { head, .. } => add(head),
                EventKind::GraphRevised {
                    source_head: Some(head),
                    ..
                }
                | EventKind::ManualGraphRevised {
                    source_head: Some(head),
                    ..
                } => add(head),
                _ => {}
            }
        }
    }
    Ok(protected)
}
fn latest_batch_result_is_current(state: &Snapshot) -> bool {
    if state.plan_type.as_deref() == Some("serial") {
        return true;
    }
    state
        .events
        .iter()
        .rev()
        .find_map(|event| match &event.kind {
            EventKind::ResultPublished { .. } => Some(true),
            EventKind::ExecutionBatchStarted { .. } => Some(false),
            _ => None,
        })
        != Some(false)
}

/// Explicit fixed-layout policies retain workspaces across completion.
/// Automatic discovery policies (`automatic-lazy`) only retain workspaces when
/// an active/failed result execution or a current published result actually
/// bound a fixed-layout native environment (`launch.environment.is_some()`).
pub(crate) fn retains_managed_environment_workspaces(root: &Path, state: &Snapshot) -> bool {
    let Some(policy) = state
        .config
        .as_ref()
        .and_then(|config| config.environment.as_ref())
    else {
        return false;
    };
    if !policy.discovery {
        return true;
    }
    if state
        .result_execution
        .as_ref()
        .is_some_and(|execution| matches!(execution.status.as_str(), "running" | "failed"))
    {
        return true;
    }
    let Some(descriptor) = state.published_result.as_ref() else {
        return false;
    };
    if !latest_batch_result_is_current(state) {
        return false;
    }
    let Ok(store) = crate::environment::Environments::new(root, &state.run_id, policy) else {
        return true;
    };
    std::iter::once(&descriptor.result)
        .chain(descriptor.entries.iter().map(|entry| &entry.result))
        .any(|result| store.requires_fixed_layout(&result.launch_ref).unwrap_or(true))
}

/// Lifetime checks shared by normal completion and durable cleanup retries.
/// A matching event sequence proves freshness, not that recovery/result files
/// are disposable. Retrying an older queued task must honor today's policy.
pub(crate) fn retains_workspaces(root: &Path, state: &Snapshot) -> bool {
    if retains_managed_environment_workspaces(root, state) {
        return true;
    }
    let serial = state.plan_type.as_deref() == Some("serial");
    !serial
        && (!state.pending_feedback.is_empty()
            || state.nodes.values().any(|node| node.status != "completed")
            || state.executions.iter().any(|execution| {
                execution.status == "completed"
                    && state.nodes.contains_key(&execution.node)
                    && !state.superseded_execution_ids.contains(&execution.id)
                    && execution.after.as_ref().is_some_and(|head| {
                        !head.is_empty() && !state.published_heads.contains(head)
                    })
            }))
}

/// Caller must hold the Run's runtime mutex for workspace-only tasks. The
/// sequence check cancels stale cleanup once a follow-up/revision changes it.
pub(crate) fn execute(root: &Path, store: &Store, task: &Task) -> Result<(), String> {
    execute_inner(root, store, task, false)
}

/// Under the owning Run lock, retire workspace paths without recursively
/// deleting them. Independent durable receipts own the detached directories.
pub(crate) fn retire_workspaces(root: &Path, store: &Store, task: &Task) -> Result<(), String> {
    if task.manifest.sequence.is_none() {
        return Err("Only workspace-only cleanup can be detached".into());
    }
    match execute_inner(root, store, task, true) {
        Ok(()) => Ok(()),
        Err(error) => {
            store.fail_cleanup(&task.run_id, &error)?;
            Err(error)
        }
    }
}

fn execute_inner(root: &Path, store: &Store, task: &Task, detach: bool) -> Result<(), String> {
    let mut manifest = task.manifest.clone();
    if let Some(sequence) = task.manifest.sequence {
        if store.contains_run(&task.run_id)? {
            let state = store.load(&task.run_id)?;
            if state.events.last().map_or(0, |event| event.sequence) != sequence {
                return store.finish_cleanup(&task.run_id);
            }
            if matches!(
                state.phase.as_str(),
                "planning" | "publishing" | "merging" | "launching_result"
            ) || state.nodes.values().any(|node| node.status == "running")
                || state
                    .executions
                    .iter()
                    .chain(&state.mergers)
                    .any(|execution| execution.status == "running")
                || state
                    .result_execution
                    .as_ref()
                    .is_some_and(|execution| execution.status == "running")
            {
                return Err("Run is active; workspace cleanup is deferred".into());
            }
            if retains_workspaces(root, &state) {
                // Handle/cancel this cleanup generation without dropping its
                // ownership records. Explicit conversation deletion still owns
                // eventual removal; a later publication can queue a new task.
                return store.finish_cleanup(&task.run_id);
            }
            // Refresh recorded ownership while the Run generation is unchanged.
            manifest = self::manifest(root, store, &state, false)?;
            store.enqueue_cleanup(&task.run_id, &manifest)?;
        } else if !store.run_was_deleted(&task.run_id)? {
            return Err("Cleanup has no Run ownership".into());
        }
    } else if !store.run_was_deleted(&task.run_id)? {
        return Err("Refusing conversation cleanup without a deletion tombstone".into());
    }
    if let Some(repository) = &manifest.unresolved_repository {
        let recovered = if Path::new(repository).is_dir() {
            let config: Config = serde_json::from_value(
                serde_json::json!({"repository":repository,"model":"cleanup","maxParallel":1}),
            )
            .map_err(|error| error.to_string())?;
            configuration_targets(root, &task.run_id, &config, true)?
        } else {
            BTreeSet::new()
        };
        if recovered
            .iter()
            .any(|target| matches!(target, Target::Workspace { .. }))
        {
            manifest.targets.extend(recovered);
            manifest.unresolved_repository = None;
            store.enqueue_cleanup(&task.run_id, &manifest)?;
        }
    }
    // Revalidate the entire plan on EVERY retry, before the first removal.
    validate(root, &task.run_id, &manifest)?;
    manifest.protected_sources.extend(store.cleanup_sources()?);
    let deleting = task.manifest.sequence.is_none();
    let mut paths = Vec::new();
    let mut detached_targets = Vec::new();
    for target in &manifest.targets {
        let shared = store.cleanup_target_is_shared(&task.run_id, target)?;
        if shared && deleting {
            if let Target::Shadow { source, .. } = target {
                if let Some(path) = target.resolve(root, &task.run_id)? {
                    let protected = protected_shadow_objects_for_repository(
                        store,
                        &task.run_id,
                        source.as_deref(),
                    )?;
                    crate::workspace::prune_shadow_run_refs_for_source(
                        &path,
                        source.as_deref(),
                        &task.run_id,
                        &protected,
                        source.is_some(),
                    )?;
                }
            }
        }
        if shared {
            continue;
        }
        if let Some(path) = target.resolve(root, &task.run_id)? {
            if !manifest
                .protected_sources
                .iter()
                .any(|source| crate::workspace::scope_contains(source, &path))
            {
                if detach {
                    if !matches!(target, Target::Workspace { .. }) {
                        return Err("Detached cleanup cannot remove non-workspace resources".into());
                    }
                    detached_targets.push((target.clone(), path.clone()));
                }
                paths.push(path);
            }
        }
    }
    if detach {
        // Retire only the top-level targets; a parent's receipt owns its entire tree.
        for (target, path) in &detached_targets {
            if paths
                .iter()
                .any(|parent| parent != path && path.starts_with(parent))
            {
                continue;
            }
            detached::retire(root, store, &task.run_id, target)?;
        }
    } else {
        crate::workspace_cleanup::remove_paths(paths)?;
    }
    if let Some(repository) = &manifest.unresolved_repository {
        return Err(format!("Workspace ownership predates this version and the binding is missing: {repository}. Restore it or explicitly inspect its project parent with cleanup:workspaces."));
    }
    store.finish_cleanup(&task.run_id)
}

pub(crate) fn attempt(root: &Path, store: &Store, task: &Task) -> Result<(), String> {
    match execute(root, store, task) {
        Ok(()) => Ok(()),
        Err(error) => {
            store.fail_cleanup(&task.run_id, &error)?;
            Err(error)
        }
    }
}

fn path_older_than(path: &Path, min_age: std::time::Duration) -> bool {
    if min_age.is_zero() {
        return true;
    }
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    let Ok(modified) = metadata.modified() else {
        return false;
    };
    std::time::SystemTime::now()
        .duration_since(modified)
        .is_ok_and(|age| age >= min_age)
}

fn marker_exists_or_unreadable(path: &Path) -> bool {
    match fs::symlink_metadata(path) {
        Ok(meta) => meta.is_file(),
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    }
}

/// True when a `.publication` journal directory has no unsettled attempt
/// (no attempt with `prepared.json`, `input.json`, or `applying` lacking `installed`).
pub(crate) fn publication_journal_settled(journal_root: &Path) -> bool {
    let entries = match fs::read_dir(journal_root) {
        Ok(entries) => entries,
        Err(error) => return error.kind() == std::io::ErrorKind::NotFound,
    };
    for entry in entries {
        let Ok(entry) = entry else {
            return false;
        };
        let Ok(kind) = entry.file_type() else {
            return false;
        };
        if !kind.is_dir() {
            continue;
        }
        let attempt = entry.path();
        let has_state = marker_exists_or_unreadable(&attempt.join("prepared.json"))
            || marker_exists_or_unreadable(&attempt.join("input.json"))
            || marker_exists_or_unreadable(&attempt.join("applying"));
        if has_state && !attempt.join("installed").is_file() {
            return false;
        }
    }
    true
}

/// True when `.pi-n-worktrees/<uuid>` contains ONLY standalone publication
/// artifacts (`publication-files-*`, `publication-view-*`, optional
/// `.pi-n-state` / `.pi-n-git`), every publication journal inside it is
/// settled, and it has been idle for at least `min_age`.
pub(crate) fn is_settled_orphan_publication_dir(path: &Path, min_age: std::time::Duration) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return false;
    };
    if !meta.is_dir() || crate::workspace_symlinks::is_link(&meta) {
        return false;
    }
    if !path_older_than(path, min_age) {
        return false;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return false;
    };
    let mut saw_publication_entry = false;
    for entry in entries {
        let Ok(entry) = entry else {
            return false;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let child = entry.path();
        let Ok(child_meta) = fs::symlink_metadata(&child) else {
            return false;
        };
        if crate::workspace_symlinks::is_link(&child_meta) || !path_older_than(&child, min_age) {
            return false;
        }
        if is_publication_workspace_checkout(&name) {
            saw_publication_entry = true;
            if name.ends_with(".publication") {
                if !child_meta.is_dir() || !publication_journal_settled(&child) {
                    return false;
                }
                if !min_age.is_zero() {
                    let Ok(attempts) = fs::read_dir(&child) else {
                        return false;
                    };
                    for attempt in attempts {
                        let Ok(attempt) = attempt else {
                            return false;
                        };
                        if !path_older_than(&attempt.path(), min_age) {
                            return false;
                        }
                    }
                }
            }
        } else if matches!(name.as_str(), ".pi-n-state" | ".pi-n-git") {
            continue;
        } else {
            return false;
        }
    }
    saw_publication_entry
}

fn dir_children_older_than(dir: &Path, min_age: std::time::Duration, recursive: bool) -> bool {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => return error.kind() == std::io::ErrorKind::NotFound,
    };
    for entry in entries {
        let Ok(entry) = entry else {
            return false;
        };
        let child = entry.path();
        let Ok(meta) = fs::symlink_metadata(&child) else {
            return false;
        };
        if !path_older_than(&child, min_age) {
            return false;
        }
        if recursive
            && meta.is_dir()
            && !crate::workspace_symlinks::is_link(&meta)
            && !dir_children_older_than(&child, min_age, true)
        {
            return false;
        }
    }
    true
}

pub(crate) fn shadow_repo_idle(path: &Path, min_age: std::time::Duration) -> bool {
    if min_age.is_zero() {
        return true;
    }
    if !path_older_than(path, min_age) {
        return false;
    }
    for leaf in [
        "HEAD",
        "HEAD.lock",
        "index",
        "index.lock",
        "packed-refs",
        "packed-refs.lock",
        "logs",
        "logs/HEAD",
        "refs",
        "refs/heads",
        "refs/pi-n",
        "refs/pi-n/heads",
        "refs/pi-n/inputs",
        "refs/pi-n/runs",
        "refs/pi-n/published",
        "agent-views",
        "objects",
        "objects/pack",
        "worktrees",
    ] {
        let probe = path.join(leaf);
        match fs::symlink_metadata(&probe) {
            Ok(_) => {
                if !path_older_than(&probe, min_age) {
                    return false;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return false,
        }
    }
    dir_children_older_than(&path.join("objects"), min_age, false)
        && dir_children_older_than(&path.join("worktrees"), min_age, true)
        && dir_children_older_than(&path.join("agent-views"), min_age, false)
        && dir_children_older_than(&path.join("refs"), min_age, true)
        && dir_children_older_than(&path.join("logs"), min_age, true)
}

/// Reclaim shadow repositories under `<root>/shadow_repos` that have no
/// referencing Run in `store` and have been idle for at least `min_age`.
#[cfg(test)]
pub(crate) fn prune_orphaned_shadow_repos(
    root: &Path,
    store: &Store,
    min_age: std::time::Duration,
) -> Result<usize, String> {
    prune_orphaned_shadow_repos_with_guard(root, store, min_age, || false)
}

/// Reclaim shadow repositories under `<root>/shadow_repos`, acquiring each
/// shadow repository's lifecycle lock non-blockingly and re-checking
/// `should_abort`, idle state, and store references immediately before removal.
pub(crate) fn prune_orphaned_shadow_repos_with_guard(
    root: &Path,
    store: &Store,
    min_age: std::time::Duration,
    should_abort: impl Fn() -> bool,
) -> Result<usize, String> {
    if should_abort() {
        return Ok(0);
    }
    let Some(shadow_root) = real_child_path(root, &root.join("shadow_repos"), false)? else {
        return Ok(0);
    };
    let mut candidates = Vec::new();
    for entry in fs::read_dir(&shadow_root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let target = Target::Shadow {
            root: root.to_path_buf(),
            name,
            source: None,
        };
        let Ok(Some(path)) = target.resolve(root, "background-gc") else {
            continue;
        };
        if shadow_repo_idle(&path, min_age) {
            candidates.push(path);
        }
    }
    if candidates.is_empty() || should_abort() {
        return Ok(0);
    }
    let watermark = store.shadow_reference_watermark()?;
    let referenced = store.referenced_shadow_repos()?;
    let mut removed = 0usize;
    for path in candidates {
        if should_abort() {
            break;
        }
        if referenced.contains(&crate::path_identity::path_key(&path)) {
            continue;
        }
        let shadow_lock = crate::workspace::shadow_use_lock(&path)?;
        let Ok(_shadow_guard) = shadow_lock.try_write() else {
            continue;
        };
        if should_abort() {
            break;
        }
        // Re-verify idle state and database references under the exclusive
        // shadow lock before deleting to close any race with a new Run.
        if !shadow_repo_idle(&path, min_age) {
            continue;
        }
        if store.shadow_reference_watermark()? != watermark
            && store.is_shadow_repo_referenced(&path)?
        {
            continue;
        }
        crate::workspace_cleanup::remove_tree(&path).map_err(|error| error.to_string())?;
        removed += 1;
    }
    Ok(removed)
}

/// Reclaim settled orphan publication cache roots under
/// `<workspaces_parent>/.pi-n-worktrees/<uuid>` that belong to no live or
/// recorded Run and have been idle for at least `min_age`.
pub(crate) fn prune_orphaned_publication_dirs(
    root: &Path,
    store: &Store,
    min_age: std::time::Duration,
) -> Result<usize, String> {
    let parent = crate::workspace::workspaces_parent(root);
    let Some(bucket) = real_child_path(&parent, &parent.join(".pi-n-worktrees"), false)? else {
        return Ok(0);
    };
    let mut candidates = Vec::new();
    for entry in fs::read_dir(&bucket).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if Uuid::parse_str(&id).is_err() {
            continue;
        }
        let Some(path) = real_child_path(&parent, &bucket.join(&id), false)? else {
            continue;
        };
        if is_settled_orphan_publication_dir(&path, min_age) {
            candidates.push((id, path));
        }
    }
    if candidates.is_empty() {
        return Ok(0);
    }
    let known_runs: BTreeSet<String> = store
        .runs()?
        .into_iter()
        .chain(
            store
                .pending_cleanups()?
                .into_iter()
                .map(|task| task.run_id),
        )
        .collect();
    let protected_sources = store.cleanup_sources()?;
    let mut removed = 0usize;
    for (id, path) in candidates {
        if known_runs.contains(&id) {
            continue;
        }
        if protected_sources
            .iter()
            .any(|source| crate::workspace::scope_contains(source, &path))
        {
            continue;
        }
        if !is_settled_orphan_publication_dir(&path, min_age) {
            continue;
        }
        crate::workspace_cleanup::remove_tree(&path).map_err(|error| error.to_string())?;
        removed += 1;
    }
    Ok(removed)
}
