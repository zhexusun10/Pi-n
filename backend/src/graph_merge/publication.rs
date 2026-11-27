//! Git is an internal composition channel. Publication delivers files only:
//! never import an object, move a ref, or replace the user's Git index.
mod atomic_files;

use super::compose_graph_scoped;
use crate::workspace::{self, git, repository_git};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeSet, HashSet},
    fs::{self, OpenOptions},
    hash::{Hash, Hasher},
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct PublishOptions {
    /// When true, concurrent source edits whose paths are strictly disjoint
    /// from this publication's changed paths are preserved in place instead of
    /// failing delivery.
    pub(crate) reconcile_disjoint_source_changes: bool,
    /// When true and delivery has not yet entered `applying`, retry pre-apply
    /// source-file/index drift against a fresh attempt journal (reusing
    /// retained composition/Merger work without rerunning nodes). Branch
    /// switches, HEAD moves, unrelated merges and in-flight `applying`
    /// recoveries still fail closed.
    pub(crate) retry_pre_apply_source_changes: bool,
}

impl PublishOptions {
    pub(crate) fn concurrent_friendly() -> Self {
        Self {
            reconcile_disjoint_source_changes: true,
            retry_pre_apply_source_changes: true,
        }
    }
}

enum AttemptError {
    RetryablePreApply(String),
    Fatal(String),
}

impl AttemptError {
    fn into_message(self) -> String {
        match self {
            Self::RetryablePreApply(message) | Self::Fatal(message) => message,
        }
    }
}

impl From<String> for AttemptError {
    fn from(message: String) -> Self {
        Self::Fatal(message)
    }
}

impl From<&str> for AttemptError {
    fn from(message: &str) -> Self {
        Self::Fatal(message.into())
    }
}

const SOURCE_LEASE_RETRY_BACKOFFS: [Duration; 4] = [
    Duration::from_millis(50),
    Duration::from_millis(100),
    Duration::from_millis(150),
    Duration::from_millis(200),
];

const PRE_APPLY_RETRY_BACKOFFS: [Duration; 2] = [
    Duration::from_millis(150),
    Duration::from_millis(350),
];

#[derive(Serialize, Deserialize)]
struct Prepared {
    source_head: String,
    input: String,
    result: String,
}

/// A separate namespace prevents a new worker from resuming an older journal
/// whose delivery policy installed a commit into the user's repository.
pub fn publication_workspace(repository: &Path, heads: &[String]) -> Result<PathBuf, String> {
    let mut sorted = heads.to_vec();
    sorted.sort();
    sorted.dedup();
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    sorted.hash(&mut hash);
    let result = hash.finish();
    workspace::shadow_repo_dir(repository)?.hash(&mut hash);
    let owner = uuid::Uuid::from_u128(((hash.finish() as u128) << 64) | result as u128);
    Ok(workspace::workspaces_parent(&workspace::data_root())
        .join(".pi-n-worktrees")
        .join(owner.to_string())
        .join(format!("publication-files-{result:016x}")))
}

fn validate_private_paths(repository: &Path, path: &Path) -> Result<(), String> {
    let root = path
        .parent()
        .and_then(Path::parent)
        .ok_or("Invalid publication workspace layout")?;
    if !path.is_absolute()
        || !root
            .file_name()
            .is_some_and(|name| name == ".pi-n-worktrees" || name == ".pi-n-workspaces")
    {
        return Err("Publication requires an isolated Graph workspace".into());
    }
    let mut ancestor = root;
    loop {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                ancestor = ancestor
                    .parent()
                    .ok_or("Publication cache has no existing ancestor")?;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    let candidate = ancestor
        .canonicalize()
        .map_err(|e| e.to_string())?
        .join(root.strip_prefix(ancestor).map_err(|e| e.to_string())?);
    let source = repository.canonicalize().map_err(|e| e.to_string())?;
    if workspace::scope_contains(&candidate, &source)
        || workspace::scope_contains(&source, &candidate)
    {
        return Err("Publication workspace must not overlap the source directory".into());
    }
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    crate::path_safety::real_child_path(root, path, false)?;
    crate::path_safety::real_child_path(root, &path.with_extension("publication"), false)?;
    Ok(())
}

fn save_once(path: &Path, value: &[u8]) -> Result<(), String> {
    if path.exists() {
        return Err(format!(
            "Publication record already exists: {}",
            path.display()
        ));
    }
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    file.write_all(value)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(temporary, path).map_err(|e| e.to_string())
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn source_branch(repository: &Path) -> Result<String, String> {
    match git(repository, &["symbolic-ref", "-q", "HEAD"]) {
        Ok(branch) => Ok(branch),
        Err(_) => {
            git(repository, &["rev-parse", "--verify", "HEAD"])?;
            Ok("HEAD".into())
        }
    }
}

fn source_index(repository: &Path) -> Result<PathBuf, String> {
    Ok(PathBuf::from(git(
        repository,
        &["rev-parse", "--path-format=absolute", "--git-path", "index"],
    )?))
}

fn original_index(journal: &Path) -> Result<Option<Vec<u8>>, String> {
    if journal.join("index-missing").is_file() {
        return Ok(None);
    }
    read_optional(&journal.join("original-index"))?
        .map(Some)
        .ok_or_else(|| "Publication source index evidence is missing".into())
}

fn verify_source(
    repository: &Path,
    journal: &Path,
    prepared: &Prepared,
    allow_index_retry: bool,
) -> Result<(), AttemptError> {
    let branch = fs::read_to_string(journal.join("source-branch")).map_err(|e| e.to_string())?;
    if source_branch(repository)? != branch {
        return Err(AttemptError::Fatal("Source branch changed during publication; retry before checkout, or restore the captured branch to finish an interrupted checkout".into()));
    }
    if git(repository, &["rev-parse", "HEAD"])? != prepared.source_head {
        return Err(AttemptError::Fatal("Source HEAD changed during publication; retry before checkout or inspect the retained recovery state".into()));
    }
    if read_optional(&source_index(repository)?)? != original_index(journal)? {
        let message = "Source index changed during publication; refusing to overwrite or silently absorb staged work".to_string();
        return Err(if allow_index_retry {
            AttemptError::RetryablePreApply(message)
        } else {
            AttemptError::Fatal(message)
        });
    }
    if git(repository, &["rev-parse", "--verify", "MERGE_HEAD"]).is_ok() {
        return Err(AttemptError::Fatal(
            "An unrelated source merge is in progress; finish it before publication".into(),
        ));
    }
    Ok(())
}

fn installed(journal: &Path, result: &str) -> Result<bool, String> {
    match read_optional(&journal.join("installed"))? {
        Some(record) if record == result.as_bytes() => Ok(true),
        Some(_) => Err("Publication installation record does not match the prepared result".into()),
        None => Ok(false),
    }
}

fn tree(repository: &Path, commit: &str) -> Result<String, String> {
    repository_git(repository, &["rev-parse", &format!("{commit}^{{tree}}")])
}

/// An in-flight result is not yet in Runtime state, so cleanup of another Run
/// cannot discover it from protected heads. A Run-owned ref keeps it reachable
/// across concurrent GC and process restarts until delivery is recorded.
fn publication_pin(path: &Path, head: &str) -> Result<String, String> {
    let parent = path.parent().ok_or("Invalid publication workspace")?;
    let owner = parent
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let owner = uuid::Uuid::parse_str(owner).unwrap_or_else(|_| {
        // Nonstandard callers can still use an isolated custom workspace. Its
        // deterministic owner is released on successful delivery as usual.
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        parent.hash(&mut hash);
        uuid::Uuid::from_u128(hash.finish() as u128)
    });
    Ok(format!("refs/pi-n/runs/{owner}/publications/{head}"))
}

fn release_publication_pin(repository: &Path, pin: &str) -> Result<(), String> {
    repository_git(repository, &["update-ref", "-d", pin])?;
    Ok(())
}

fn record_delivery(
    repository: &Path,
    prepared: &Prepared,
    standard: bool,
    pin: &str,
) -> Result<(), String> {
    let index_lock = workspace::host_index_lock(repository)?;
    let _index_guard = index_lock.lock().map_err(|e| e.to_string())?;
    let lock = workspace::host_ref_lock(repository)?;
    let _guard = lock.lock().map_err(|e| e.to_string())?;
    if let Ok(latest) = repository_git(
        repository,
        &["rev-parse", "--verify", "refs/pi-n/published/result"],
    ) {
        if latest == prepared.result {
            if repository_git(repository, &["rev-parse", "HEAD"])? == prepared.result {
                repository_git(repository, &["read-tree", &prepared.result])?;
            }
            return release_publication_pin(repository, pin);
        }
        if repository_git(
            repository,
            &["merge-base", "--is-ancestor", &prepared.result, &latest],
        )
        .is_ok()
        {
            return release_publication_pin(repository, pin);
        }
    }
    // source is the unchanged user HEAD, not the internal result. A later
    // snapshot can bridge delivered ancestry even though user HEAD never moved.
    let source = if standard {
        &prepared.source_head
    } else {
        &prepared.input
    };
    let refs = format!("start\nupdate refs/pi-n/published/source {source}\nupdate refs/pi-n/published/composed {0}\nupdate refs/pi-n/published/result {0}\nupdate HEAD {0}\nprepare\ncommit\n", prepared.result);
    let shadow = workspace::shadow_repo_dir(repository)?;
    workspace::git_bytes(
        repository,
        &[
            "--git-dir",
            shadow.to_str().ok_or("Invalid internal repository")?,
            "--work-tree",
            repository.to_str().ok_or("Invalid source path")?,
            "update-ref",
            "--stdin",
        ],
        None,
        Some(refs.as_bytes()),
    )?;
    repository_git(repository, &["read-tree", &prepared.result])?;
    release_publication_pin(repository, pin)
}

fn is_transient_publication_capture_error(error: &str) -> bool {
    crate::runtime::is_transient_source_change_error(error)
        || error.contains("while capturing publication")
}

fn capture_publication_input(
    repository: &Path,
    journal: &Path,
    standard: bool,
    exclusions: &[String],
    wait_budget: &mut Duration,
) -> Result<(String, String), String> {
    let input_path = journal.join("input.json");
    let mut attempt = 0usize;
    let (branch, source_head, index, input) = loop {
        crate::process_control::check_current_owner_stop()?;
        crate::engine::wait_for_source_writers_with_budget(repository, wait_budget)?;
        let captured = (|| -> Result<(Option<String>, String, Option<Vec<u8>>, String), String> {
            let branch = if standard {
                Some(source_branch(repository)?)
            } else {
                None
            };
            let source_head = if standard {
                git(repository, &["rev-parse", "HEAD"])?
            } else {
                String::new()
            };
            let index = if standard {
                read_optional(&source_index(repository)?)?
            } else {
                None
            };
            let input = workspace::snapshot_repository_scoped(repository, exclusions)?;
            if let Some(branch) = &branch {
                if source_branch(repository)? != *branch {
                    return Err(
                        "Source branch changed while capturing publication; retry publication"
                            .into(),
                    );
                }
                if git(repository, &["rev-parse", "HEAD"])? != source_head {
                    return Err(
                        "Source HEAD changed while capturing publication; retry publication".into(),
                    );
                }
                if read_optional(&source_index(repository)?)? != index {
                    return Err(
                        "Source index changed while capturing publication; retry publication"
                            .into(),
                    );
                }
            }
            Ok((branch, source_head, index, input))
        })();
        match captured {
            Ok(values) => break values,
            Err(error)
                if is_transient_publication_capture_error(&error)
                    && attempt < crate::runtime::SOURCE_SNAPSHOT_RETRY_BACKOFFS.len() =>
            {
                crate::runtime::sleep_interruptible(
                    crate::runtime::SOURCE_SNAPSHOT_RETRY_BACKOFFS[attempt],
                )?;
                attempt += 1;
            }
            Err(error) => return Err(error),
        }
    };
    if let Some(branch) = branch {
        if let Some(bytes) = index {
            save_once(&journal.join("original-index"), &bytes)?;
        } else {
            save_once(&journal.join("index-missing"), b"absent\n")?;
        }
        save_once(&journal.join("source-branch"), branch.as_bytes())?;
    }
    save_once(
        &input_path,
        &serde_json::to_vec(&(source_head.clone(), input.clone())).map_err(|e| e.to_string())?,
    )?;
    Ok((source_head, input))
}

pub(super) fn publish(
    repository: &Path,
    heads: &[String],
    exclusions: &[String],
    target: Option<&Path>,
    resolve: impl FnMut(&Path) -> Result<(), String>,
) -> Result<String, String> {
    publish_with_options(
        repository,
        heads,
        exclusions,
        target,
        PublishOptions::default(),
        resolve,
    )
}

pub(super) fn publish_with_options(
    repository: &Path,
    heads: &[String],
    exclusions: &[String],
    target: Option<&Path>,
    options: PublishOptions,
    mut resolve: impl FnMut(&Path) -> Result<(), String>,
) -> Result<String, String> {
    let mut attempt = 0usize;
    let mut wait_budget = crate::engine::INITIAL_SOURCE_WRITE_WAIT;
    loop {
        crate::process_control::check_current_owner_stop()?;
        match publish_once(
            repository,
            heads,
            exclusions,
            target,
            options,
            &mut wait_budget,
            &mut resolve,
        ) {
            Ok(head) => return Ok(head),
            Err(AttemptError::RetryablePreApply(_))
                if options.retry_pre_apply_source_changes
                    && attempt < PRE_APPLY_RETRY_BACKOFFS.len() =>
            {
                crate::runtime::sleep_interruptible(PRE_APPLY_RETRY_BACKOFFS[attempt])?;
                attempt += 1;
            }
            Err(error) => return Err(error.into_message()),
        }
    }
}

fn publish_once(
    repository: &Path,
    heads: &[String],
    exclusions: &[String],
    target: Option<&Path>,
    options: PublishOptions,
    wait_budget: &mut Duration,
    resolve: &mut impl FnMut(&Path) -> Result<(), String>,
) -> Result<String, AttemptError> {
    workspace::validate_binding(repository)?;
    let default_path = publication_workspace(repository, heads)?;
    let path = target.unwrap_or(&default_path).to_path_buf();
    validate_private_paths(repository, &path)?;
    let root = path.with_extension("publication");
    let standard = workspace::is_standard_git(repository);
    let journal = select_attempt(repository, &root, standard, exclusions)?;
    crate::path_safety::real_child_path(&root, &journal, false)?;
    let prepared_path = journal.join("prepared.json");
    if prepared_path.exists() {
        let prepared: Prepared =
            serde_json::from_slice(&fs::read(prepared_path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        return deliver(
            repository,
            &path,
            &journal,
            &prepared,
            standard,
            exclusions,
            options,
            wait_budget,
        );
    }
    fs::create_dir_all(&journal).map_err(|e| e.to_string())?;
    let input_path = journal.join("input.json");
    let (source_head, input): (String, String) = if input_path.exists() {
        serde_json::from_slice(&fs::read(&input_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?
    } else {
        capture_publication_input(repository, &journal, standard, exclusions, wait_budget)?
    };
    // Only a workspace created by this attempt is guaranteed to hold exactly
    // the collected base. A pre-existing directory (even one without private
    // Git yet) can still carry unrecorded files, so it stages as usual.
    let fresh = !path.exists() && !workspace::has_private_git(&path);
    let mut inputs = heads.to_vec();
    // Earlier inputs remain owned MERGE_HEAD candidates across rebaselines.
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
            .is_none()
        {
            continue;
        }
        crate::path_safety::real_child_path(&root, &entry.path(), false)?;
        if let Some(bytes) = read_optional(&entry.path().join("input.json"))? {
            let (_, owned): (String, String) =
                serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            if !inputs.contains(&owned) {
                inputs.push(owned);
            }
        }
    }
    if !inputs.contains(&input) {
        inputs.push(input.clone());
    }
    // A clean composition needs no workspace at all: the merge is computed from
    // the recorded trees and only the composed project view is recorded. A
    // conflict or project state needing physical verification falls back to the
    // materialized path below, which also owns Merger repair.
    let virtual_result = if fresh {
        compose_virtual_publication(repository, &path, &input, &inputs, exclusions)?
    } else {
        None
    };
    let result = match virtual_result {
        Some(result) => {
            for head in heads {
                repository_git(repository, &["merge-base", "--is-ancestor", head, &result])?;
            }
            result
        }
        None => {
            if !workspace::has_private_git(&path) {
                // Composition prepares and seals the composed project view once
                // below; preparing it here first would repeat the evidence pass.
                workspace::prepare_composition(repository, &path, &input, &[])?;
            }
            let result =
                compose_graph_scoped(&path, repository, &inputs, exclusions, fresh, || {
                    resolve(&path)
                })?;
            for head in heads {
                git(&path, &["merge-base", "--is-ancestor", head, &result])?;
            }
            let metadata = workspace::private_git_dir(&path);
            let url = workspace::git_file_url(metadata.as_deref().unwrap_or(&path))?;
            let lock = workspace::host_ref_lock(repository)?;
            let _guard = lock.lock().map_err(|e| e.to_string())?;
            repository_git(
                repository,
                &[
                    "fetch",
                    "-q",
                    "--no-tags",
                    "--no-write-fetch-head",
                    "--no-auto-gc",
                    &url,
                    &format!("+{result}:{}", publication_pin(&path, &result)?),
                ],
            )?;
            repository_git(
                repository,
                &[
                    "update-ref",
                    &format!("refs/pi-n/heads/{result}"),
                    &result,
                ],
            )?;
            result
        }
    };
    let prepared = Prepared {
        source_head,
        input,
        result,
    };
    save_once(
        &prepared_path,
        &serde_json::to_vec(&prepared).map_err(|e| e.to_string())?,
    )?;
    deliver(
        repository,
        &path,
        &journal,
        &prepared,
        standard,
        exclusions,
        options,
        wait_budget,
    )
}

/// Directory that holds the composed project view of a workspace-free
/// publication. It stays a sibling of the composition workspace so it remains a
/// managed slot (private metadata and cleanup ownership), but it never receives
/// project files.
fn composition_view_path(workspace: &Path) -> Result<PathBuf, String> {
    let name = workspace
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid publication workspace")?;
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    name.hash(&mut hash);
    Ok(workspace.with_file_name(format!("publication-view-{:016x}", hash.finish())))
}

/// Compose and seal a publication that needs no workspace. Returns `None` when
/// the composition must be materialized after all.
fn compose_virtual_publication(
    repository: &Path,
    workspace: &Path,
    input: &str,
    parents: &[String],
    exclusions: &[String],
) -> Result<Option<String>, String> {
    let head = {
        // Merge-tree and commit-tree create unreachable objects. Keep cleanup's
        // ref lock throughout composition, not just while pinning the final
        // commit, so gc --prune=now cannot remove an intermediate merge.
        let lock = workspace::host_ref_lock(repository)?;
        let _guard = lock.lock().map_err(|error| error.to_string())?;
        let Some(head) = super::compose_graph_virtual(repository, input, parents)? else {
            return Ok(None);
        };
        repository_git(
            repository,
            &["update-ref", &publication_pin(workspace, &head)?, &head],
        )?;
        repository_git(
            repository,
            &["update-ref", &format!("refs/pi-n/heads/{head}"), &head],
        )?;
        head
    };
    if !crate::workspace_view::has_record(repository, input) {
        // Host-only fixture checkouts record no project view.
        return Ok(Some(head));
    }
    let view = composition_view_path(workspace)?;
    validate_private_paths(repository, &view)?;
    fs::create_dir_all(&view).map_err(|e| e.to_string())?;
    let base = crate::workspace_view::composition_base(repository, input, parents)?;
    let view_parents: Vec<String> = parents
        .iter()
        .filter(|parent| crate::workspace_view::has_record(repository, parent))
        .cloned()
        .collect();
    let view_parents = workspace::independent_heads(repository, &view_parents)?;
    match crate::workspace_view::seal_composed_view(
        repository,
        &view,
        &base,
        &view_parents,
        exclusions,
        &head,
    )? {
        Some(_) => Ok(Some(head)),
        None => {
            let lock = workspace::host_ref_lock(repository)?;
            let _guard = lock.lock().map_err(|error| error.to_string())?;
            release_publication_pin(repository, &publication_pin(workspace, &head)?)?;
            Ok(None)
        }
    }
}

fn select_attempt(
    repository: &Path,
    root: &Path,
    standard: bool,
    exclusions: &[String],
) -> Result<PathBuf, String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let latest = fs::read_dir(root)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok())
        .max()
        .unwrap_or(0);
    let current = root.join(format!("{latest:08}"));
    crate::path_safety::real_child_path(root, &current, false)?;
    let next = || {
        latest
            .checked_add(1)
            .map(|id| root.join(format!("{id:08}")))
            .ok_or_else(|| "Too many publication attempts".to_string())
    };
    if !current.join("input.json").exists() {
        return if current.join("original-index").exists()
            || current.join("source-branch").exists()
            || current.join("index-missing").exists()
        {
            next()
        } else {
            Ok(current)
        };
    }
    if let Some(bytes) = read_optional(&current.join("prepared.json"))? {
        let prepared: Prepared = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if installed(&current, &prepared.result)? {
            return Ok(current);
        }
    }
    if current.join("applying").exists() {
        return Ok(current);
    }
    let (head, input): (String, String) =
        serde_json::from_slice(&fs::read(current.join("input.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let changed_git = if standard {
        source_branch(repository)?
            != fs::read_to_string(current.join("source-branch")).map_err(|e| e.to_string())?
            || git(repository, &["rev-parse", "HEAD"])? != head
            || read_optional(&source_index(repository)?)? != original_index(&current)?
    } else {
        false
    };
    let live = workspace::live_tree_scoped(repository, exclusions)?;
    if changed_git || live != tree(repository, &input)? {
        next()
    } else {
        Ok(current)
    }
}

fn private_index_git_input(
    repository: &Path,
    index: &Path,
    args: &[&str],
    input: Option<&[u8]>,
) -> Result<String, String> {
    // Do not run source clean/smudge/EOL filters while delivering recorded
    // physical bytes, and do not mutate the shared snapshot repo's attributes.
    let metadata = index
        .parent()
        .ok_or("Missing checkout journal")?
        .join("raw-checkout.git");
    let metadata_text = metadata.to_str().ok_or("Invalid checkout Git path")?;
    let worktree = repository.to_str().ok_or("Invalid project path")?;
    if !metadata.join("HEAD").is_file() {
        fs::create_dir_all(&metadata).map_err(|e| e.to_string())?;
        let format = repository_git(repository, &["rev-parse", "--show-object-format=storage"])?;
        git(
            repository,
            &[
                "--git-dir",
                metadata_text,
                "--work-tree",
                worktree,
                "init",
                "-q",
                &format!("--object-format={format}"),
            ],
        )?;
        let objects = repository_git(
            repository,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "objects",
            ],
        )?;
        let objects = crate::native::host_path(Path::new(&objects))
            .to_string_lossy()
            .replace('\\', "/");
        fs::write(
            metadata.join("objects/info/alternates"),
            format!("{objects}\n"),
        )
        .map_err(|e| e.to_string())?;
        workspace::raw_checkout_attributes(&metadata)?;
    }
    let mut command = vec!["--git-dir", metadata_text, "--work-tree", worktree];
    command.extend_from_slice(args);
    let bytes = workspace::git_bytes(repository, &command, Some(index), input)?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

fn diff_paths(
    repository: &Path,
    before: &str,
    after: &str,
) -> Result<std::collections::BTreeSet<String>, String> {
    Ok(repository_git(
        repository,
        &[
            "diff",
            "--name-only",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            "-z",
            before,
            after,
        ],
    )?
    .split('\0')
    .filter(|path| !path.is_empty())
    .map(str::to_owned)
    .collect())
}

fn normalize_path_key(path: &str, case_insensitive: bool) -> String {
    if case_insensitive {
        path.to_lowercase()
    } else {
        path.to_string()
    }
}

fn parent_dir_key(key: &str) -> &str {
    key.rsplit_once('/').map_or("", |(parent, _)| parent)
}

/// Returns true iff `left` and `right` touch strictly disjoint paths, including
/// file-vs-directory ancestor collisions and case-insensitive aliases.
fn paths_disjoint(
    left: &BTreeSet<String>,
    right: &BTreeSet<String>,
    case_insensitive: bool,
) -> bool {
    if left.is_empty() || right.is_empty() {
        return true;
    }
    let mut left_paths = HashSet::with_capacity(left.len());
    let mut left_prefixes = HashSet::new();
    let mut left_non_ascii_parents = HashSet::new();
    for path in left {
        let key = normalize_path_key(path, case_insensitive);
        if case_insensitive && !path.is_ascii() {
            left_non_ascii_parents.insert(parent_dir_key(&key).to_string());
        }
        let mut cursor = key.as_str();
        while let Some((prefix, _)) = cursor.rsplit_once('/') {
            if !left_prefixes.insert(prefix.to_string()) {
                break;
            }
            cursor = prefix;
        }
        left_paths.insert(key);
    }
    for path in right {
        let key = normalize_path_key(path, case_insensitive);
        if left_paths.contains(&key) || left_prefixes.contains(&key) {
            return false;
        }
        if case_insensitive
            && !path.is_ascii()
            && left_non_ascii_parents.contains(parent_dir_key(&key))
        {
            // Conservatively reject potential Unicode NFC/NFD aliases within the
            // same directory on case-insensitive volumes.
            return false;
        }
        let mut cursor = key.as_str();
        while let Some((prefix, _)) = cursor.rsplit_once('/') {
            if left_paths.contains(prefix) {
                return false;
            }
            cursor = prefix;
        }
    }
    true
}

fn source_files_changed_error(
    repository: &Path,
    input: &str,
    result: &str,
    live: &str,
) -> Result<String, String> {
    let from_input = diff_paths(repository, input, live)?;
    let from_result = diff_paths(repository, result, live)?;
    let paths = from_input
        .intersection(&from_result)
        .take(8)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    Ok(format!("Source files changed during publication; private results are preserved. These paths match neither the original nor the result: {paths}. This may be an interrupted legacy file write, not a user edit. Preserve the current files and reconcile them with the retained publication before retrying."))
}

fn with_source_lease<T>(
    repository: &Path,
    journal: &Path,
    standard: bool,
    operation: impl FnOnce() -> Result<T, AttemptError>,
) -> Result<T, AttemptError> {
    let lock_path = if standard {
        source_index(repository)?.with_extension("lock")
    } else {
        workspace::shadow_repo_dir(repository)?.join("publication.lock")
    };
    let marker = format!("Pi^n publication {}\n", journal.display());
    // Only this interrupted attempt's marker may be reclaimed.
    release_owned_lock(&lock_path, marker.as_bytes())?;
    let mut attempt = 0usize;
    let mut lease = loop {
        crate::process_control::check_current_owner_stop()?;
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
        {
            Ok(file) => break file,
            Err(error)
                if error.kind() == std::io::ErrorKind::AlreadyExists
                    && attempt < SOURCE_LEASE_RETRY_BACKOFFS.len() =>
            {
                crate::runtime::sleep_interruptible(SOURCE_LEASE_RETRY_BACKOFFS[attempt])?;
                attempt += 1;
            }
            Err(error) => {
                return Err(AttemptError::Fatal(format!(
                    "Cannot acquire source Git index lease: {error}"
                )));
            }
        }
    };
    lease
        .write_all(marker.as_bytes())
        .and_then(|_| lease.sync_all())
        .map_err(|e| e.to_string())?;
    drop(lease);
    let outcome = operation();
    let released = release_owned_lock(&lock_path, marker.as_bytes());
    match outcome {
        Ok(result) => {
            released?;
            Ok(result)
        }
        Err(error) => Err(error),
    }
}

fn deliver(
    repository: &Path,
    path: &Path,
    journal: &Path,
    prepared: &Prepared,
    standard: bool,
    exclusions: &[String],
    options: PublishOptions,
    wait_budget: &mut Duration,
) -> Result<String, AttemptError> {
    let lock_path = if standard {
        source_index(repository)?.with_extension("lock")
    } else {
        workspace::shadow_repo_dir(repository)?.join("publication.lock")
    };
    let marker = format!("Pi^n publication {}\n", journal.display());
    let pin = publication_pin(path, &prepared.result)?;
    if installed(journal, &prepared.result)? {
        release_owned_lock(&lock_path, marker.as_bytes())?;
        record_delivery(repository, prepared, standard, &pin)?;
        return Ok(prepared.result.clone());
    }
    crate::engine::wait_for_source_writers_with_budget(repository, wait_budget)?;
    let applying = journal.join("applying").exists();
    if standard {
        verify_source(repository, journal, prepared, !applying)?;
    }
    with_source_lease(repository, journal, standard, || {
        let applying = journal.join("applying").exists();
        if standard {
            verify_source(repository, journal, prepared, !applying)?;
        }
        atomic_files::cleanup_temporaries(repository, journal, &prepared.input, &prepared.result)?;
        let live = workspace::live_tree_scoped(repository, exclusions)?;
        let live_tree = live.clone();
        let input_tree = tree(repository, &prepared.input)?;
        let final_tree = tree(repository, &prepared.result)?;
        let case_insensitive = crate::path_identity::case_insensitive_volume(repository);
        let mut compile_changed_cache: Option<BTreeSet<String>> = None;
        if live_tree != input_tree {
            if applying {
                let from_input = diff_paths(repository, &prepared.input, &live)?;
                let from_result = diff_paths(repository, &prepared.result, &live)?;
                let mismatched: BTreeSet<String> =
                    from_input.intersection(&from_result).cloned().collect();
                if !mismatched.is_empty() {
                    let disjoint_ok = if options.reconcile_disjoint_source_changes {
                        let compile_changed =
                            diff_paths(repository, &prepared.input, &prepared.result)?;
                        let ok = paths_disjoint(&compile_changed, &mismatched, case_insensitive);
                        compile_changed_cache = Some(compile_changed);
                        ok
                    } else {
                        false
                    };
                    if !disjoint_ok {
                        return Err(AttemptError::Fatal(source_files_changed_error(
                            repository,
                            &prepared.input,
                            &prepared.result,
                            &live,
                        )?));
                    }
                }
            } else if options.reconcile_disjoint_source_changes {
                let compile_changed = diff_paths(repository, &prepared.input, &prepared.result)?;
                let live_changed = diff_paths(repository, &prepared.input, &live)?;
                if paths_disjoint(&compile_changed, &live_changed, case_insensitive) {
                    compile_changed_cache = Some(compile_changed);
                } else {
                    return Err(AttemptError::RetryablePreApply(
                        source_files_changed_error(
                            repository,
                            &prepared.input,
                            &prepared.result,
                            &live,
                        )?,
                    ));
                }
            } else {
                return Err(AttemptError::RetryablePreApply(
                    source_files_changed_error(
                        repository,
                        &prepared.input,
                        &prepared.result,
                        &live,
                    )?,
                ));
            }
        }
        if live_tree != final_tree {
            let compile_empty = match &compile_changed_cache {
                Some(changed) => changed.is_empty(),
                None => input_tree == final_tree,
            };
            if !compile_empty {
                atomic_files::install(repository, journal, &prepared.input, &prepared.result)?;
            }
            let after_live = workspace::live_tree_scoped(repository, exclusions)?;
            if after_live != final_tree {
                let post_disjoint_ok = if options.reconcile_disjoint_source_changes {
                    let compile_changed = match compile_changed_cache {
                        Some(changed) => changed,
                        None => diff_paths(repository, &prepared.input, &prepared.result)?,
                    };
                    let remaining_diff = diff_paths(repository, &prepared.result, &after_live)?;
                    paths_disjoint(&compile_changed, &remaining_diff, case_insensitive)
                } else {
                    false
                };
                if !post_disjoint_ok {
                    return Err(AttemptError::Fatal(
                        "Source files changed while applying publication; retained checkout requires explicit recovery".into(),
                    ));
                }
            }
        }
        if standard {
            verify_source(repository, journal, prepared, false)?;
        }
        save_once(&journal.join("installed"), prepared.result.as_bytes())?;
        record_delivery(repository, prepared, standard, &pin)?;
        Ok(prepared.result.clone())
    })
}

fn release_owned_lock(path: &Path, marker: &[u8]) -> Result<(), String> {
    if read_optional(path)?.as_deref() == Some(marker) {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publication_rejects_a_private_workspace_redirected_to_source_before_composition() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        git(&source, &["init", "-q"]).unwrap();
        fs::write(source.join("base.txt"), "base").unwrap();
        git(&source, &["add", "-A"]).unwrap();
        git(&source, &["commit", "-q", "-m", "base"]).unwrap();
        let source_head = git(&source, &["rev-parse", "HEAD"]).unwrap();
        let base = workspace::snapshot_repository(&source).unwrap();
        let node = temp.path().join("node");
        workspace::prepare(&source, &node, &base, &[]).unwrap();
        fs::write(node.join("result.txt"), "node result").unwrap();
        let head = workspace::snapshot_node_for_run(
            &node,
            &source,
            "node",
            Some(&uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        let path = temp
            .path()
            .join(".pi-n-worktrees")
            .join(uuid::Uuid::new_v4().to_string())
            .join("publication");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        crate::path_safety::directory_link(&source, &path);
        assert!(publish(&source, &[head], &[], Some(&path), |_| panic!()).is_err());
        assert!(!source.join("result.txt").exists());
        assert_eq!(git(&source, &["rev-parse", "HEAD"]).unwrap(), source_head);
        crate::path_safety::remove_directory_link(&path);
    }

    #[test]
    fn interrupted_publication_survives_another_run_pruning_the_shadow() {
        interrupted_publication_survives_pruning(false);
    }

    #[test]
    fn interrupted_materialized_publication_survives_another_run_pruning_the_shadow() {
        interrupted_publication_survives_pruning(true);
    }

    fn interrupted_publication_survives_pruning(materialized: bool) {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        git(&source, &["init", "-q"]).unwrap();
        fs::write(source.join("base.txt"), "base").unwrap();
        git(&source, &["add", "-A"]).unwrap();
        git(&source, &["commit", "-qm", "base"]).unwrap();
        let original_head = git(&source, &["rev-parse", "HEAD"]).unwrap();
        let base = workspace::snapshot_repository(&source).unwrap();
        let node = temp.path().join("node");
        workspace::prepare(&source, &node, &base, &[]).unwrap();
        fs::write(node.join("result.txt"), "result").unwrap();
        let head = workspace::snapshot_node_for_run(
            &node,
            &source,
            "node",
            Some(&uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        let run_id = uuid::Uuid::new_v4().to_string();
        let path = temp
            .path()
            .join(".pi-n-worktrees")
            .join(&run_id)
            .join("publication");
        if materialized {
            fs::create_dir_all(&path).unwrap();
        }
        let lock_file = source_index(&source).unwrap().with_extension("lock");
        fs::write(&lock_file, "foreign lease").unwrap();
        assert!(publish(
            &source,
            std::slice::from_ref(&head),
            &[],
            Some(&path),
            |_| panic!("no conflict")
        )
        .is_err());
        let journal = path.with_extension("publication").join("00000000");
        let prepared: Prepared =
            serde_json::from_slice(&fs::read(journal.join("prepared.json")).unwrap()).unwrap();
        assert!(!journal.join("installed").exists());
        assert_eq!(workspace::has_private_git(&path), materialized);

        // Deleting another Run also prunes unreferenced generic head pins and
        // runs gc --prune=now. The prepared result is not yet in Runtime state.
        let other = uuid::Uuid::new_v4().to_string();
        repository_git(
            &source,
            &[
                "update-ref",
                &format!("refs/pi-n/runs/{other}/test"),
                &base,
            ],
        )
        .unwrap();
        let shadow = workspace::shadow_repo_dir(&source).unwrap();
        {
            let lock = workspace::host_ref_lock(&source).unwrap();
            let _guard = lock.lock().unwrap();
            workspace::prune_shadow_run_refs(&shadow, &other, &Default::default(), true).unwrap();
        }
        repository_git(
            &source,
            &["cat-file", "-e", &format!("{}^{{commit}}", prepared.result)],
        )
        .unwrap();
        fs::remove_file(lock_file).unwrap();
        let delivered = publish(&source, &[head], &[], Some(&path), |_| {
            panic!("no conflict")
        })
        .unwrap();
        assert_eq!(delivered, prepared.result);
        assert_eq!(fs::read(source.join("result.txt")).unwrap(), b"result");
        assert_eq!(git(&source, &["rev-parse", "HEAD"]).unwrap(), original_head);
        assert!(repository_git(
            &source,
            &[
                "for-each-ref",
                "--format=%(refname)",
                &format!("refs/pi-n/runs/{run_id}/publications/")
            ]
        )
        .unwrap()
        .is_empty());
    }

    #[test]
    fn publication_preserves_staged_paths_excluded_from_collection() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        git(&source, &["init", "-q"]).unwrap();
        fs::write(source.join("base.txt"), "base").unwrap();
        git(&source, &["add", "-A"]).unwrap();
        git(&source, &["commit", "-q", "-m", "base"]).unwrap();
        let base = workspace::snapshot_repository(&source).unwrap();
        let node = temp.path().join("node");
        workspace::prepare(&source, &node, &base, &[]).unwrap();
        fs::write(node.join("result.txt"), "result").unwrap();
        let head = workspace::snapshot_node_for_run(
            &node,
            &source,
            "node",
            Some(&uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        fs::create_dir(source.join("managed")).unwrap();
        fs::write(source.join("managed/user.txt"), "user-owned staged content").unwrap();
        git(&source, &["add", "managed/user.txt"]).unwrap();
        let index = source_index(&source).unwrap();
        let before = fs::read(&index).unwrap();
        publish(&source, &[head], &["managed".into()], None, |_| panic!()).unwrap();
        assert_eq!(git(&source, &["rev-parse", "HEAD"]).unwrap(), base);
        assert_eq!(fs::read(index).unwrap(), before);
        assert!(source.join("result.txt").exists());
        assert!(git(&source, &["diff", "--cached", "--name-only"])
            .unwrap()
            .contains("managed/user.txt"));
    }

    #[test]
    fn publication_recovers_when_previous_attempt_left_uninitialized_private_git() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("shared.txt"), "base\n").unwrap();
        let base = workspace::materialize_shadow_repo(&source, &[]).unwrap();

        let node_a = temp.path().join("node-a");
        workspace::prepare(&source, &node_a, &base, &[]).unwrap();
        fs::write(node_a.join("shared.txt"), "from a\n").unwrap();
        let head_a = workspace::snapshot_node_for_run(
            &node_a,
            &source,
            "node-a",
            Some(&uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();

        let node_b = temp.path().join("node-b");
        workspace::prepare(&source, &node_b, &base, &[]).unwrap();
        fs::write(node_b.join("shared.txt"), "from b\n").unwrap();
        let head_b = workspace::snapshot_node_for_run(
            &node_b,
            &source,
            "node-b",
            Some(&uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();

        let run_id = uuid::Uuid::new_v4().to_string();
        let path = temp
            .path()
            .join(".pi-n-worktrees")
            .join(&run_id)
            .join("publication-files-test");

        // Simulate an interrupted first attempt after creating the empty
        // publication workspace and its v4 metadata directory, before `git init`.
        fs::create_dir_all(&path).unwrap();
        let slot_digest = git2::Oid::hash_object(
            git2::ObjectType::Blob,
            path.file_name().unwrap().to_str().unwrap().as_bytes(),
        )
        .unwrap()
        .to_string();
        let metadata = path
            .parent()
            .unwrap()
            .join(".pi-n-git")
            .join(format!("{}.git", &slot_digest[..16]));
        fs::create_dir_all(&metadata).unwrap();
        fs::write(
            metadata.join("workspace-layout-v4"),
            b"project-git-separated-v4\n",
        )
        .unwrap();
        assert!(!workspace::has_private_git(&path));

        let mut resolved = false;
        let delivered = publish(&source, &[head_a, head_b], &[], Some(&path), |workspace| {
            resolved = true;
            fs::write(workspace.join("shared.txt"), "merged\n").map_err(|e| e.to_string())?;
            git(workspace, &["add", "-f", "--", "shared.txt"])?;
            Ok(())
        })
        .unwrap();
        assert!(resolved);
        assert!(workspace::has_private_git(&path));
        assert_eq!(
            fs::read_to_string(source.join("shared.txt")).unwrap(),
            "merged\n"
        );
        assert!(!delivered.is_empty());
    }

    #[test]
    fn paths_disjoint_detects_exact_ancestor_and_case_alias_overlaps() {
        let set = |items: &[&str]| -> BTreeSet<String> {
            items.iter().map(|s| (*s).to_string()).collect()
        };
        assert!(paths_disjoint(&set(&[]), &set(&["a.txt"]), false));
        assert!(paths_disjoint(
            &set(&["src/a.ts", "dir/old.txt"]),
            &set(&["README.md", "dir/new.txt"]),
            false,
        ));
        assert!(!paths_disjoint(
            &set(&["src/a.ts"]),
            &set(&["src/a.ts"]),
            false,
        ));
        assert!(!paths_disjoint(
            &set(&["foo"]),
            &set(&["foo/bar.txt"]),
            false,
        ));
        assert!(!paths_disjoint(
            &set(&["foo/bar.txt"]),
            &set(&["foo"]),
            false,
        ));
        assert!(paths_disjoint(
            &set(&["src/App.tsx"]),
            &set(&["src/app.tsx"]),
            false,
        ));
        assert!(!paths_disjoint(
            &set(&["src/App.tsx"]),
            &set(&["src/app.tsx"]),
            true,
        ));
        assert!(!paths_disjoint(
            &set(&["Dir"]),
            &set(&["dir/file.txt"]),
            true,
        ));
        assert!(paths_disjoint(
            &set(&["src/app.ts"]),
            &set(&["笔记.md"]),
            true,
        ));
    }

    #[test]
    fn concurrent_friendly_publication_preserves_disjoint_source_edits_without_failing() {
        for standard in [true, false] {
            let temp = tempfile::tempdir().unwrap();
            let source = temp.path().join("source");
            fs::create_dir(&source).unwrap();
            fs::write(source.join("shared.txt"), "base\n").unwrap();
            let (original_head, base) = if standard {
                git(&source, &["init", "-q"]).unwrap();
                git(&source, &["add", "-A"]).unwrap();
                git(&source, &["commit", "-qm", "base"]).unwrap();
                let head = git(&source, &["rev-parse", "HEAD"]).unwrap();
                let snap = workspace::snapshot_repository(&source).unwrap();
                (Some(head), snap)
            } else {
                let snap = workspace::materialize_shadow_repo(&source, &[]).unwrap();
                (None, snap)
            };

            let node_a = temp.path().join("node-a");
            workspace::prepare(&source, &node_a, &base, &[]).unwrap();
            fs::write(node_a.join("shared.txt"), "from a\n").unwrap();
            let head_a = workspace::snapshot_node_for_run(
                &node_a,
                &source,
                "node-a",
                Some(&uuid::Uuid::new_v4().to_string()),
            )
            .unwrap();

            let node_b = temp.path().join("node-b");
            workspace::prepare(&source, &node_b, &base, &[]).unwrap();
            fs::write(node_b.join("shared.txt"), "from b\n").unwrap();
            let head_b = workspace::snapshot_node_for_run(
                &node_b,
                &source,
                "node-b",
                Some(&uuid::Uuid::new_v4().to_string()),
            )
            .unwrap();

            let path = temp
                .path()
                .join(".pi-n-worktrees")
                .join(uuid::Uuid::new_v4().to_string())
                .join("publication-disjoint");
            let mut resolver_calls = 0usize;
            let delivered = publish_with_options(
                &source,
                &[head_a, head_b],
                &[],
                Some(&path),
                PublishOptions::concurrent_friendly(),
                |workspace| {
                    resolver_calls += 1;
                    // Simulate Direct mode writing a disjoint file while Compile is merging.
                    fs::write(source.join("direct-notes.txt"), "direct work\n").unwrap();
                    fs::write(workspace.join("shared.txt"), "a+b\n").map_err(|e| e.to_string())?;
                    git(workspace, &["add", "-f", "--", "shared.txt"])?;
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(resolver_calls, 1);
            assert!(!delivered.is_empty());
            assert_eq!(
                fs::read_to_string(source.join("shared.txt")).unwrap(),
                "a+b\n"
            );
            assert_eq!(
                fs::read_to_string(source.join("direct-notes.txt")).unwrap(),
                "direct work\n"
            );
            if let Some(original_head) = original_head {
                assert_eq!(git(&source, &["rev-parse", "HEAD"]).unwrap(), original_head);
            }
            // A follow-up source snapshot captures both Compile's delivery and Direct's file.
            let next_snap = workspace::snapshot_repository(&source).unwrap();
            assert_eq!(
                repository_git(&source, &["show", &format!("{next_snap}:shared.txt")]).unwrap(),
                "a+b"
            );
            assert_eq!(
                repository_git(&source, &["show", &format!("{next_snap}:direct-notes.txt")])
                    .unwrap(),
                "direct work"
            );
        }
    }

    #[test]
    fn concurrent_friendly_publication_retries_overlapping_and_index_changes_but_fails_on_branch_or_head(
    ) {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        git(&source, &["init", "-q"]).unwrap();
        fs::write(source.join("shared.txt"), "base\n").unwrap();
        git(&source, &["add", "-A"]).unwrap();
        git(&source, &["commit", "-qm", "base"]).unwrap();
        let original_head = git(&source, &["rev-parse", "HEAD"]).unwrap();
        let base = workspace::snapshot_repository(&source).unwrap();

        let node_a = temp.path().join("node-a");
        workspace::prepare(&source, &node_a, &base, &[]).unwrap();
        fs::write(node_a.join("shared.txt"), "from a\n").unwrap();
        let head_a = workspace::snapshot_node_for_run(
            &node_a,
            &source,
            "node-a",
            Some(&uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();

        let node_b = temp.path().join("node-b");
        workspace::prepare(&source, &node_b, &base, &[]).unwrap();
        fs::write(node_b.join("shared.txt"), "from b\n").unwrap();
        let head_b = workspace::snapshot_node_for_run(
            &node_b,
            &source,
            "node-b",
            Some(&uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();

        // 1. Overlapping edit during first composition triggers pre-apply retry + re-merge,
        // preserving both Direct's edit and Compile's changes.
        let path_overlap = temp
            .path()
            .join(".pi-n-worktrees")
            .join(uuid::Uuid::new_v4().to_string())
            .join("publication-overlap");
        let mut calls = 0usize;
        publish_with_options(
            &source,
            &[head_a.clone(), head_b.clone()],
            &[],
            Some(&path_overlap),
            PublishOptions::concurrent_friendly(),
            |workspace| {
                calls += 1;
                if calls == 1 {
                    fs::write(source.join("shared.txt"), "direct overlapping edit\n").unwrap();
                    fs::write(workspace.join("shared.txt"), "a+b\n").map_err(|e| e.to_string())?;
                } else {
                    fs::write(workspace.join("shared.txt"), "a+b+direct\n")
                        .map_err(|e| e.to_string())?;
                }
                git(workspace, &["add", "-f", "--", "shared.txt"])?;
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(calls, 2);
        assert_eq!(
            fs::read_to_string(source.join("shared.txt")).unwrap(),
            "a+b+direct\n"
        );

        // 2. Pre-apply `git add` (index change) on an unrelated file retries cleanly
        // without re-running Merger and keeps the staged file in the user's index.
        {
            let temp2 = tempfile::tempdir().unwrap();
            let source2 = temp2.path().join("source");
            fs::create_dir(&source2).unwrap();
            git(&source2, &["init", "-q"]).unwrap();
            fs::write(source2.join("shared.txt"), "base\n").unwrap();
            git(&source2, &["add", "-A"]).unwrap();
            git(&source2, &["commit", "-qm", "base"]).unwrap();
            let head2 = git(&source2, &["rev-parse", "HEAD"]).unwrap();
            let base2 = workspace::snapshot_repository(&source2).unwrap();

            let na = temp2.path().join("node-a");
            workspace::prepare(&source2, &na, &base2, &[]).unwrap();
            fs::write(na.join("shared.txt"), "from a\n").unwrap();
            let ha = workspace::snapshot_node_for_run(
                &na,
                &source2,
                "node-a",
                Some(&uuid::Uuid::new_v4().to_string()),
            )
            .unwrap();

            let nb = temp2.path().join("node-b");
            workspace::prepare(&source2, &nb, &base2, &[]).unwrap();
            fs::write(nb.join("shared.txt"), "from b\n").unwrap();
            let hb = workspace::snapshot_node_for_run(
                &nb,
                &source2,
                "node-b",
                Some(&uuid::Uuid::new_v4().to_string()),
            )
            .unwrap();

            let path_index = temp2
                .path()
                .join(".pi-n-worktrees")
                .join(uuid::Uuid::new_v4().to_string())
                .join("publication-index");
            let mut index_calls = 0usize;
            publish_with_options(
                &source2,
                &[ha, hb],
                &[],
                Some(&path_index),
                PublishOptions::concurrent_friendly(),
                |workspace| {
                    index_calls += 1;
                    fs::write(source2.join("staged-by-direct.txt"), "staged\n").unwrap();
                    git(&source2, &["add", "staged-by-direct.txt"])?;
                    fs::write(workspace.join("shared.txt"), "a+b\n").map_err(|e| e.to_string())?;
                    git(workspace, &["add", "-f", "--", "shared.txt"])?;
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(index_calls, 1);
            assert_eq!(
                fs::read_to_string(source2.join("shared.txt")).unwrap(),
                "a+b\n"
            );
            assert!(git(&source2, &["diff", "--cached", "--name-only"])
                .unwrap()
                .contains("staged-by-direct.txt"));
            assert_eq!(git(&source2, &["rev-parse", "HEAD"]).unwrap(), head2);
        }

        // 3. Branch switch during publication still fails closed immediately.
        {
            let temp3 = tempfile::tempdir().unwrap();
            let source3 = temp3.path().join("source");
            fs::create_dir(&source3).unwrap();
            git(&source3, &["init", "-q"]).unwrap();
            fs::write(source3.join("shared.txt"), "base\n").unwrap();
            git(&source3, &["add", "-A"]).unwrap();
            git(&source3, &["commit", "-qm", "base"]).unwrap();
            let head3 = git(&source3, &["rev-parse", "HEAD"]).unwrap();
            let base3 = workspace::snapshot_repository(&source3).unwrap();

            let na = temp3.path().join("node-a");
            workspace::prepare(&source3, &na, &base3, &[]).unwrap();
            fs::write(na.join("shared.txt"), "from a\n").unwrap();
            let ha = workspace::snapshot_node_for_run(
                &na,
                &source3,
                "node-a",
                Some(&uuid::Uuid::new_v4().to_string()),
            )
            .unwrap();

            let nb = temp3.path().join("node-b");
            workspace::prepare(&source3, &nb, &base3, &[]).unwrap();
            fs::write(nb.join("shared.txt"), "from b\n").unwrap();
            let hb = workspace::snapshot_node_for_run(
                &nb,
                &source3,
                "node-b",
                Some(&uuid::Uuid::new_v4().to_string()),
            )
            .unwrap();

            let path_branch = temp3
                .path()
                .join(".pi-n-worktrees")
                .join(uuid::Uuid::new_v4().to_string())
                .join("publication-branch");
            let branch_err = publish_with_options(
                &source3,
                &[ha, hb],
                &[],
                Some(&path_branch),
                PublishOptions::concurrent_friendly(),
                |workspace| {
                    git(&source3, &["update-ref", "refs/heads/other", &head3])?;
                    git(&source3, &["symbolic-ref", "HEAD", "refs/heads/other"])?;
                    fs::write(workspace.join("shared.txt"), "a+b\n").map_err(|e| e.to_string())?;
                    git(workspace, &["add", "-f", "--", "shared.txt"])?;
                    Ok(())
                },
            )
            .unwrap_err();
            assert!(branch_err.contains("Source branch changed"), "{branch_err}");
            assert_eq!(git(&source3, &["rev-parse", "HEAD"]).unwrap(), head3);
        }
        assert_eq!(git(&source, &["rev-parse", "HEAD"]).unwrap(), original_head);
    }

    #[test]
    fn publication_waits_for_transient_index_lock_release() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        git(&source, &["init", "-q"]).unwrap();
        fs::write(source.join("base.txt"), "base").unwrap();
        git(&source, &["add", "-A"]).unwrap();
        git(&source, &["commit", "-qm", "base"]).unwrap();
        let base = workspace::snapshot_repository(&source).unwrap();
        let node = temp.path().join("node");
        workspace::prepare(&source, &node, &base, &[]).unwrap();
        fs::write(node.join("result.txt"), "result").unwrap();
        let head = workspace::snapshot_node_for_run(
            &node,
            &source,
            "node",
            Some(&uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();

        let lock_file = source_index(&source).unwrap().with_extension("lock");
        fs::write(&lock_file, "brief direct git command").unwrap();
        let lock_to_release = lock_file.clone();
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(80));
            let _ = fs::remove_file(lock_to_release);
        });
        let delivered = publish(&source, &[head], &[], None, |_| panic!()).unwrap();
        releaser.join().unwrap();
        assert!(!delivered.is_empty());
        assert_eq!(fs::read_to_string(source.join("result.txt")).unwrap(), "result");
    }
}
