//! Verification of file changes inferred from bash commands.
//!
//! A bash transcript can only say that a command *named* a path (`rm x`,
//! `sed -i … x`, `cat > x`). Whether the path changed is a property of the
//! tree, so these rows are checked against the execution's Git baseline (its
//! `before` snapshot, or the real `HEAD` for Serial/source-direct work):
//!
//! - a bash `rm` stays only if Git still sees a difference (a temporary file
//!   that was created and removed, or an ignored cache, leaves no row);
//! - a bash write lead (`bash-candidate`) becomes a row only if Git sees a
//!   tracked difference or a new non-ignored file at that path, with Git's own
//!   status and line counts, so clicking the row always has content;
//! - a directory target expands to the files Git reports below it.
//!
//! Precise `write`/`edit`/Git rows always win over a verified lead. Without a
//! usable Git baseline a deletion stays as parsed and a lead is dropped: a
//! guess is not worth attributing a change to the wrong agent.
//!
//! While an execution runs, rows are verified on every read (bounded, deadlined
//! and briefly cached). Once it settles they are **frozen** exactly once: the
//! verified rows replace the leads durably, so a later `git commit`, checkout or
//! unrelated edit cannot make this conversation's history drift or vanish.

use super::{
    file_diff::{path_baseline, BaselineOutcome, PathBaseline},
    is_candidate, merge_file_item_into, untracked_additions, FileChangeItem, FileChangeSummary,
};
use crate::model::{Execution, Snapshot};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{mpsc, Mutex, OnceLock},
    time::{Duration, Instant},
};

/// Source of a row whose path Git confirmed (or a frozen, final bash row).
/// Counts are absolute against the baseline, like `git` rows, never deltas.
pub(crate) const VERIFIED_SOURCE: &str = "bash-verified";

/// Paths verified per execution per read. A script that names thousands of
/// literals must not turn one poll into thousands of Git pathspecs. Deletions
/// are checked first; leads beyond the limit are dropped, deletions kept.
const MAX_VERIFIED_PATHS: usize = 400;
/// A wedged repository must not hold a file-change read forever.
const BASELINE_DEADLINE: Duration = Duration::from_secs(5);
/// Live polls repeat while a tool runs; identical questions share an answer.
const LIVE_CACHE_TTL: Duration = Duration::from_secs(2);
const LIVE_CACHE_ENTRIES: usize = 32;

/// Where and against what one execution's bash rows are verified.
#[derive(Clone, Debug)]
pub struct VerifyTarget {
    pub execution_id: String,
    pub root: PathBuf,
    /// The execution's baseline commit; empty for Serial/source-direct work.
    pub before: String,
    pub after: Option<String>,
}

pub(super) fn target_for(exec: &Execution, repository: &Path) -> VerifyTarget {
    let worktree = PathBuf::from(&exec.worktree);
    VerifyTarget {
        execution_id: exec.id.clone(),
        root: if !exec.worktree.is_empty() && worktree.exists() {
            worktree
        } else {
            repository.to_path_buf()
        },
        before: exec.before.clone(),
        after: exec.after.clone().filter(|sha| !sha.is_empty()),
    }
}

fn fallback_target(repository: &Path) -> VerifyTarget {
    VerifyTarget {
        execution_id: String::new(),
        root: repository.to_path_buf(),
        before: String::new(),
        after: None,
    }
}

/// Rows that are still a bash claim rather than Git-confirmed or frozen.
pub(super) fn is_unverified(item: &FileChangeItem) -> bool {
    is_candidate(item)
        || (item.source.as_deref() == Some("bash")
            && item.status == "deleted"
            && item.old_path.is_none())
}

fn covers(target: &str, path: &str) -> bool {
    path == target
        || path
            .strip_prefix(target)
            .is_some_and(|rest| rest.starts_with('/'))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// A running execution: answer now, never persist the answer.
    Live,
    /// A settled execution: the answer is final; transient Git failure aborts.
    Freeze,
}

/// Run `work` on a helper thread and give up after `deadline`. A wedged Git
/// process keeps running in the background until it ends, but the read returns.
fn within_deadline<T: Send + 'static>(
    deadline: Duration,
    work: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    let (sender, receiver) = mpsc::channel();
    std::thread::Builder::new()
        .name("file-change-baseline".into())
        .spawn(move || {
            let _ = sender.send(work());
        })
        .ok()?;
    receiver.recv_timeout(deadline).ok()
}

type LiveKey = (PathBuf, String, Option<String>, Vec<String>);
type LiveEntries = Vec<(Instant, LiveKey, PathBaseline)>;
static LIVE: OnceLock<Mutex<LiveEntries>> = OnceLock::new();

fn live_cached(key: &LiveKey) -> Option<PathBaseline> {
    let mut entries = LIVE.get_or_init(Default::default).lock().ok()?;
    entries.retain(|(at, _, _)| at.elapsed() < LIVE_CACHE_TTL);
    entries
        .iter()
        .find(|(_, cached, _)| cached == key)
        .map(|(_, _, baseline)| baseline.clone())
}

fn live_store(key: LiveKey, baseline: PathBaseline) {
    let Ok(mut entries) = LIVE.get_or_init(Default::default).lock() else {
        return;
    };
    entries.retain(|(at, _, _)| at.elapsed() < LIVE_CACHE_TTL);
    if entries.len() >= LIVE_CACHE_ENTRIES {
        entries.remove(0);
    }
    entries.push((Instant::now(), key, baseline));
}

fn baseline_for(target: &VerifyTarget, paths: &[String], mode: Mode) -> BaselineOutcome {
    let key: LiveKey = (
        target.root.clone(),
        target.before.clone(),
        target.after.clone(),
        paths.to_vec(),
    );
    if mode == Mode::Live {
        if let Some(baseline) = live_cached(&key) {
            return BaselineOutcome::Ready(baseline);
        }
    }
    let owned = key.clone();
    let outcome = within_deadline(BASELINE_DEADLINE, move || {
        path_baseline(&owned.0, &owned.1, owned.2.as_deref(), &owned.3)
    })
    .unwrap_or(BaselineOutcome::Failed);
    if mode == Mode::Live {
        if let BaselineOutcome::Ready(baseline) = &outcome {
            live_store(key, baseline.clone());
        }
    }
    outcome
}

/// Add verified rows beneath precise ones: a precise row keeps its counts and
/// only gains provenance.
fn overlay_rows(kept: &mut BTreeMap<String, FileChangeItem>, rows: Vec<FileChangeItem>) {
    for row in rows {
        match kept.get_mut(&row.path) {
            Some(existing) => {
                for node in row.nodes {
                    if !existing.nodes.contains(&node) {
                        existing.nodes.push(node);
                    }
                }
                for id in row.execution_ids {
                    if !existing.execution_ids.contains(&id) {
                        existing.execution_ids.push(id);
                    }
                }
                existing.is_running |= row.is_running;
            }
            None => {
                kept.insert(row.path.clone(), row);
            }
        }
    }
}

fn verify_inner(
    summary: FileChangeSummary,
    targets: &[VerifyTarget],
    fallback: &VerifyTarget,
    mode: Mode,
) -> Option<FileChangeSummary> {
    let FileChangeSummary {
        files,
        is_running,
        active_file_path,
        ..
    } = summary;

    let target_of = |item: &FileChangeItem| -> usize {
        item.execution_ids
            .iter()
            .find_map(|id| targets.iter().position(|target| &target.execution_id == id))
            .unwrap_or(targets.len())
    };
    let target_at = |index: usize| targets.get(index).unwrap_or(fallback);

    let mut deletions: HashMap<usize, Vec<String>> = HashMap::new();
    let mut leads: HashMap<usize, Vec<String>> = HashMap::new();
    for item in files.iter().filter(|item| is_unverified(item)) {
        let bucket = if is_candidate(item) {
            &mut leads
        } else {
            &mut deletions
        };
        bucket
            .entry(target_of(item))
            .or_default()
            .push(item.path.clone());
    }
    let indexes: HashSet<usize> = deletions.keys().chain(leads.keys()).copied().collect();
    let mut checked: HashMap<usize, HashSet<String>> = HashMap::new();
    let mut baselines: HashMap<usize, BaselineOutcome> = HashMap::new();
    for index in indexes {
        let mut first = deletions.remove(&index).unwrap_or_default();
        let mut second = leads.remove(&index).unwrap_or_default();
        first.sort();
        second.sort();
        let mut seen = HashSet::new();
        let mut ordered: Vec<String> = first
            .into_iter()
            .chain(second)
            .filter(|path| seen.insert(path.clone()))
            .collect();
        ordered.truncate(MAX_VERIFIED_PATHS);
        let outcome = baseline_for(target_at(index), &ordered, mode);
        if mode == Mode::Freeze && matches!(outcome, BaselineOutcome::Failed) {
            return None;
        }
        checked.insert(index, ordered.into_iter().collect());
        baselines.insert(index, outcome);
    }

    let mut kept: BTreeMap<String, FileChangeItem> = BTreeMap::new();
    let mut verified: Vec<FileChangeItem> = Vec::new();
    for item in files {
        if !is_unverified(&item) {
            merge_file_item_into(&mut kept, item);
            continue;
        }
        let index = target_of(&item);
        let target = target_at(index);
        let baseline = match baselines.get(&index) {
            Some(BaselineOutcome::Ready(baseline))
                if checked
                    .get(&index)
                    .is_some_and(|paths| paths.contains(&item.path)) =>
            {
                Some(baseline)
            }
            _ => None,
        };
        let Some(baseline) = baseline else {
            // No usable Git answer: keep an `rm` as parsed, drop an unverifiable
            // lead. A frozen unverifiable `rm` is final, so it is not rechecked.
            if !is_candidate(&item) {
                let mut item = item;
                if mode == Mode::Freeze {
                    item.source = Some(VERIFIED_SOURCE.into());
                }
                merge_file_item_into(&mut kept, item);
            }
            continue;
        };
        let running = item.is_running && mode == Mode::Live;
        for (path, change) in baseline
            .changes
            .iter()
            .filter(|(path, _)| covers(&item.path, path))
        {
            let mut row = change.clone();
            row.path = path.clone();
            row.source = Some(VERIFIED_SOURCE.into());
            row.nodes = item.nodes.clone();
            row.execution_ids = item.execution_ids.clone();
            row.is_running = running;
            verified.push(row);
        }
        for path in baseline
            .untracked
            .iter()
            .filter(|path| covers(&item.path, path) && !baseline.changes.contains_key(*path))
        {
            verified.push(FileChangeItem {
                path: path.clone(),
                old_path: None,
                status: "added".into(),
                additions: untracked_additions(&target.root.join(path)).unwrap_or(0),
                deletions: 0,
                is_running: running,
                nodes: item.nodes.clone(),
                execution_ids: item.execution_ids.clone(),
                source: Some(VERIFIED_SOURCE.into()),
            });
        }
    }
    overlay_rows(&mut kept, verified);
    let active = active_file_path.filter(|path| kept.contains_key(path));
    let running = (is_running && active.is_some()) || kept.values().any(|item| item.is_running);
    Some(FileChangeSummary::from_files(
        kept.into_values().collect(),
        running,
        active,
    ))
}

/// Read-time check for a running execution (and any not yet frozen row).
pub fn verify_bash_changes(
    summary: FileChangeSummary,
    targets: &[VerifyTarget],
    fallback: &VerifyTarget,
) -> FileChangeSummary {
    if !summary.files.iter().any(is_unverified) {
        return summary;
    }
    verify_inner(summary.clone(), targets, fallback, Mode::Live).unwrap_or(summary)
}

/// Verify a Run/execution summary against each execution's own baseline.
/// Called per read, outside the Run mutex, on the already-merged rows.
pub fn verify_snapshot_changes(summary: FileChangeSummary, state: &Snapshot) -> FileChangeSummary {
    if !summary.files.iter().any(is_unverified) {
        return summary;
    }
    let repository = state
        .config
        .as_ref()
        .map(|config| PathBuf::from(&config.repository))
        .unwrap_or_default();
    let targets: Vec<VerifyTarget> = state
        .executions
        .iter()
        .chain(state.mergers.iter())
        .map(|exec| target_for(exec, &repository))
        .collect();
    verify_bash_changes(summary, &targets, &fallback_target(&repository))
}

/// The log rows of a settled execution with its frozen verification applied.
pub(super) fn apply_frozen(
    log: &FileChangeSummary,
    frozen: &[FileChangeItem],
) -> FileChangeSummary {
    let mut kept = BTreeMap::new();
    for item in log.files.iter().filter(|item| !is_unverified(item)) {
        merge_file_item_into(&mut kept, item.clone());
    }
    overlay_rows(&mut kept, frozen.to_vec());
    let active = log
        .active_file_path
        .clone()
        .filter(|path| kept.contains_key(path));
    FileChangeSummary::from_files(
        kept.into_values().collect(),
        log.is_running && active.is_some(),
        active,
    )
}

/// Verify a settled execution's bash rows once and keep the answer. A transient
/// Git failure freezes nothing and is retried by the next warm read.
pub(super) fn freeze_execution(run: &str, exec: &Execution, repository: &str) {
    if exec.status == "running" {
        return;
    }
    let key = (run.to_string(), exec.id.clone());
    let (summary, token) = {
        let Ok(guard) = super::cache().lock() else {
            return;
        };
        if guard.frozen.contains_key(&key) {
            return;
        }
        let Some(log) = guard.log_changes.get(&key) else {
            return;
        };
        if !log.files.iter().any(is_unverified) {
            return;
        }
        (log.clone(), guard.log_token(&key))
    };
    let repository = Path::new(repository);
    let target = target_for(exec, repository);
    let Some(frozen) = verify_inner(
        summary,
        std::slice::from_ref(&target),
        &fallback_target(repository),
        Mode::Freeze,
    ) else {
        return;
    };
    let rows: Vec<FileChangeItem> = frozen
        .files
        .into_iter()
        .filter(|item| item.source.as_deref() == Some(VERIFIED_SOURCE))
        .collect();
    let Ok(mut guard) = super::cache().lock() else {
        return;
    };
    // A concurrent log write means this answer describes an older parse.
    if guard.log_token(&key) != token || guard.frozen.contains_key(&key) {
        return;
    }
    guard.frozen.insert(key, rows);
    guard.note_mutation(run);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::Path, process::Command};

    fn git(root: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    fn lead(path: &str, status: &str, source: &str) -> FileChangeItem {
        FileChangeItem {
            path: path.into(),
            old_path: None,
            status: status.into(),
            additions: 0,
            deletions: 0,
            is_running: false,
            nodes: vec!["task".into()],
            execution_ids: vec!["exec".into()],
            source: Some(source.into()),
        }
    }

    fn repo() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        git(root, &["init", "-q"]);
        fs::write(root.join(".gitignore"), "node_modules/\n").unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/tracked.css"), "a\nb\nc\n").unwrap();
        fs::write(root.join("src/untouched.ts"), "x\n").unwrap();
        fs::write(root.join("src/removed.ts"), "one\ntwo\n").unwrap();
        git(root, &["add", "-A"]);
        git(root, &["commit", "-q", "-m", "base"]);
        temp
    }

    fn fallback(root: &Path) -> VerifyTarget {
        VerifyTarget {
            execution_id: "exec".into(),
            root: root.to_path_buf(),
            before: String::new(),
            after: None,
        }
    }

    #[test]
    fn temporary_and_ignored_deletions_leave_no_row_but_tracked_ones_keep_content() {
        let temp = repo();
        let root = temp.path();
        fs::remove_file(root.join("src/removed.ts")).unwrap();
        let summary = FileChangeSummary::from_files(
            vec![
                lead("scripts/_shot2.mjs", "deleted", "bash"),
                lead("node_modules/.vite-shot", "deleted", "bash"),
                lead("src/removed.ts", "deleted", "bash"),
            ],
            false,
            None,
        );
        let verified = verify_bash_changes(summary, &[], &fallback(root));
        assert_eq!(verified.total_files, 1, "{:?}", verified.files);
        let row = &verified.files[0];
        assert_eq!(row.path, "src/removed.ts");
        assert_eq!((row.status.as_str(), row.deletions), ("deleted", 2));
        assert_eq!(verified.deleted_count, 1);
    }

    #[test]
    fn write_leads_keep_only_paths_that_really_differ_from_the_baseline() {
        let temp = repo();
        let root = temp.path();
        fs::write(root.join("src/tracked.css"), "a\nB\nc\nd\n").unwrap();
        fs::write(root.join("brand-new.md"), "hello\nworld\n").unwrap();
        // Another agent's edit that this command never named stays out.
        fs::write(root.join("src/untouched.ts"), "changed by someone else\n").unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules/cache.js"), "ignored\n").unwrap();
        let summary = FileChangeSummary::from_files(
            vec![
                lead("src/tracked.css", "modified", "bash-candidate"),
                lead("brand-new.md", "modified", "bash-candidate"),
                lead("src/read-only.ts", "modified", "bash-candidate"),
                lead("node_modules/cache.js", "modified", "bash-candidate"),
            ],
            false,
            None,
        );
        let verified = verify_bash_changes(summary, &[], &fallback(root));
        let rows: Vec<(&str, &str, usize, usize)> = verified
            .files
            .iter()
            .map(|file| {
                (
                    file.path.as_str(),
                    file.status.as_str(),
                    file.additions,
                    file.deletions,
                )
            })
            .collect();
        assert_eq!(
            rows,
            [
                ("brand-new.md", "added", 2, 0),
                ("src/tracked.css", "modified", 2, 1)
            ]
        );
    }

    #[test]
    fn precise_rows_win_and_directories_expand_to_their_files() {
        let temp = repo();
        let root = temp.path();
        fs::write(root.join("src/tracked.css"), "a\nB\nc\n").unwrap();
        fs::remove_dir_all(root.join("src")).unwrap_or_default();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/tracked.css"), "a\nB\nc\n").unwrap();
        let mut precise = lead("src/tracked.css", "modified", "edit");
        precise.additions = 7;
        precise.deletions = 5;
        let summary = FileChangeSummary::from_files(
            vec![
                precise,
                lead("src/tracked.css", "modified", "bash-candidate"),
                lead("src", "deleted", "bash"),
            ],
            false,
            None,
        );
        let verified = verify_bash_changes(summary, &[], &fallback(root));
        let tracked = verified
            .files
            .iter()
            .find(|file| file.path == "src/tracked.css")
            .unwrap();
        assert_eq!((tracked.additions, tracked.deletions), (7, 5));
        assert!(tracked.source.as_deref() == Some("edit"));
        let removed: Vec<&str> = verified
            .files
            .iter()
            .filter(|file| file.status == "deleted")
            .map(|file| file.path.as_str())
            .collect();
        assert_eq!(removed, ["src/removed.ts", "src/untouched.ts"]);
    }

    #[test]
    fn plain_folders_keep_deletions_and_drop_unverifiable_leads() {
        let temp = tempfile::tempdir().unwrap();
        let summary = FileChangeSummary::from_files(
            vec![
                lead("gone.txt", "deleted", "bash"),
                lead("edited.txt", "modified", "bash-candidate"),
            ],
            false,
            None,
        );
        let verified = verify_bash_changes(summary, &[], &fallback(temp.path()));
        let paths: Vec<&str> = verified
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        assert_eq!(paths, ["gone.txt"]);
    }
    #[test]
    fn bash_only_conversation_shows_real_edits_and_hides_scratch_files() {
        let temp = repo();
        let root = temp.path();
        let work = root.to_string_lossy().to_string();
        // What the agent's shell commands really did to the tree.
        fs::write(root.join("src/tracked.css"), "a\nB\nc\n").unwrap();
        fs::write(root.join("src/untouched.ts"), "someone else\n").unwrap();
        let call = |id: &str, command: &str, exit: i32| {
            let start = serde_json::json!({
                "type": "tool_execution_start", "toolCallId": id, "toolName": "bash",
                "args": { "command": command }
            });
            let end = serde_json::json!({
                "type": "tool_execution_end", "toolCallId": id, "toolName": "bash",
                "isError": false, "result": { "details": { "exitCode": exit } }
            });
            format!("{start}\n{end}")
        };
        let jsonl = [
            call(
                "t1",
                &format!(
                    "cd {work} && python3 - <<'EOF'\np='src/tracked.css'\ns=open(p).read()\nopen(p,'w').write(s.replace('b','B'))\nrm src/untouched.ts\nEOF\ncat > scripts/_shot2.mjs <<'EOF'\nconsole.log('rm src/removed.ts')\nEOF"
                ),
                0,
            ),
            // The trailing grep exits 1, which used to discard every earlier change.
            call(
                "t2",
                &format!("cd {work} && rm scripts/_shot2.mjs; rm -rf node_modules/.vite-shot; grep -c nothing README.md"),
                1,
            ),
        ]
        .join("\n");
        let parsed =
            super::super::parse_jsonl_file_changes(&jsonl, "task", "exec", &work, &work, false);
        let verified = verify_bash_changes(parsed, &[], &fallback(root));
        let rows: Vec<(&str, &str)> = verified
            .files
            .iter()
            .map(|file| (file.path.as_str(), file.status.as_str()))
            .collect();
        assert_eq!(
            rows,
            [("src/tracked.css", "modified")],
            "{:?}",
            verified.files
        );
    }

    fn bash_lines(id: &str, command: &str, exit: i32) -> String {
        let start = serde_json::json!({
            "type": "tool_execution_start", "toolCallId": id, "toolName": "bash",
            "args": { "command": command }
        });
        let end = serde_json::json!({
            "type": "tool_execution_end", "toolCallId": id, "toolName": "bash",
            "isError": false, "result": { "details": { "exitCode": exit } }
        });
        format!("{start}\n{end}\n")
    }

    fn settled_execution(id: &str, root: &Path) -> Execution {
        Execution {
            id: id.into(),
            node: "task".into(),
            revision: 1,
            attempt: 1,
            session_id: id.into(),
            worktree: root.to_string_lossy().into_owned(),
            before: String::new(),
            workspace_lineage: vec![],
            after: None,
            input: None,
            result: None,
            status: "completed".into(),
            output: String::new(),
            output_bytes: 0,
            pid: None,
            started_at: 0,
            completed_at: None,
            metrics: None,
        }
    }

    fn rows(summary: &FileChangeSummary) -> Vec<(String, String, usize, usize)> {
        summary
            .files
            .iter()
            .map(|file| {
                (
                    file.path.clone(),
                    file.status.clone(),
                    file.additions,
                    file.deletions,
                )
            })
            .collect()
    }

    #[test]
    fn leads_beyond_the_cap_are_dropped_but_deletions_stay_verified() {
        let temp = repo();
        let root = temp.path();
        fs::remove_file(root.join("src/removed.ts")).unwrap();
        fs::write(root.join("zz-new.md"), "late\n").unwrap();
        let mut files = vec![lead("src/removed.ts", "deleted", "bash")];
        files.extend(
            (0..MAX_VERIFIED_PATHS + 50)
                .map(|index| lead(&format!("a{index:04}.md"), "modified", "bash-candidate")),
        );
        files.push(lead("zz-new.md", "modified", "bash-candidate"));
        let verified = verify_bash_changes(
            FileChangeSummary::from_files(files, false, None),
            &[],
            &fallback(root),
        );
        let paths: Vec<&str> = verified.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            paths,
            ["src/removed.ts"],
            "the lead past the cap is dropped"
        );
    }

    #[test]
    fn a_wedged_call_gives_up_at_the_deadline() {
        let started = Instant::now();
        let slow = within_deadline(Duration::from_millis(50), || {
            std::thread::sleep(Duration::from_millis(1_000));
            1
        });
        assert!(slow.is_none() && started.elapsed() < Duration::from_millis(800));
        assert_eq!(within_deadline(Duration::from_secs(5), || 7), Some(7));
    }

    #[test]
    fn a_failed_git_call_is_not_frozen_and_never_counts_as_unchanged() {
        let temp = repo();
        let root = temp.path();
        let broken = VerifyTarget {
            execution_id: "exec".into(),
            root: root.to_path_buf(),
            before: "0123456789abcdef0123456789abcdef01234567".into(),
            after: None,
        };
        let summary = || {
            FileChangeSummary::from_files(
                vec![
                    lead("src/removed.ts", "deleted", "bash"),
                    lead("src/tracked.css", "modified", "bash-candidate"),
                ],
                false,
                None,
            )
        };
        assert!(
            verify_inner(summary(), &[broken.clone()], &fallback(root), Mode::Freeze).is_none()
        );
        let live = verify_inner(summary(), &[broken], &fallback(root), Mode::Live).unwrap();
        assert_eq!(
            live.files
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            ["src/removed.ts"],
            "an unanswered question keeps the deletion and drops the lead"
        );
    }

    #[test]
    fn explicit_snapshots_verify_against_their_own_before_and_after() {
        let temp = repo();
        let root = temp.path();
        let before = crate::workspace::git(root, &["rev-parse", "HEAD"]).unwrap();
        fs::write(root.join("src/tracked.css"), "a\nb\nc\nd\n").unwrap();
        git(root, &["add", "-A"]);
        git(root, &["commit", "-q", "-m", "agent"]);
        let after = crate::workspace::git(root, &["rev-parse", "HEAD"]).unwrap();
        fs::write(root.join("later-user-file.md"), "not in the snapshot\n").unwrap();
        let summary = || {
            FileChangeSummary::from_files(
                vec![
                    lead("src/tracked.css", "modified", "bash-candidate"),
                    lead("later-user-file.md", "modified", "bash-candidate"),
                ],
                false,
                None,
            )
        };
        let settled = VerifyTarget {
            execution_id: "exec".into(),
            root: root.to_path_buf(),
            before: before.clone(),
            after: Some(after),
        };
        let verified = verify_bash_changes(summary(), &[settled], &fallback(root));
        assert_eq!(
            rows(&verified),
            [("src/tracked.css".into(), "modified".into(), 1, 0)]
        );
        let running = VerifyTarget {
            execution_id: "exec".into(),
            root: root.to_path_buf(),
            before,
            after: None,
        };
        let live = verify_bash_changes(summary(), &[running], &fallback(root));
        assert_eq!(
            rows(&live),
            [
                ("later-user-file.md".into(), "added".into(), 1, 0),
                ("src/tracked.css".into(), "modified".into(), 1, 0)
            ]
        );
    }

    #[test]
    fn frozen_bash_history_survives_a_later_commit_and_a_restart() {
        let temp = repo();
        let root = temp.path();
        let work = root.to_string_lossy().to_string();
        fs::write(root.join("src/tracked.css"), "a\nB\nc\n").unwrap();
        fs::write(root.join("brand-new.md"), "hi\n").unwrap();
        fs::remove_file(root.join("src/removed.ts")).unwrap();
        let command = format!(
            "cd {work} && sed -i 's/b/B/' src/tracked.css && echo hi > brand-new.md && rm src/removed.ts && rm scratch.tmp"
        );
        let run = "frozen-bash-run";
        let execution = settled_execution("exec", root);
        crate::file_changes::invalidate_run(run);
        crate::file_changes::update_from_log_text(
            run,
            "exec",
            "task",
            &work,
            &work,
            &bash_lines("t1", &command, 0),
            false,
            true,
        );
        freeze_execution(run, &execution, &work);

        // The user commits everything afterwards: HEAD now equals the tree.
        git(root, &["add", "-A"]);
        git(root, &["commit", "-q", "-m", "user commit"]);
        let frozen = crate::file_changes::get_cached_execution_changes(run, &execution).unwrap();
        let expected = vec![
            ("brand-new.md".to_string(), "added".to_string(), 1, 0),
            ("src/removed.ts".to_string(), "deleted".to_string(), 0, 2),
            ("src/tracked.css".to_string(), "modified".to_string(), 1, 1),
        ];
        assert_eq!(rows(&frozen), expected);
        assert!(frozen
            .files
            .iter()
            .all(|file| file.source.as_deref() == Some(VERIFIED_SOURCE)));

        let data = tempfile::tempdir().unwrap();
        crate::file_changes::persist_run(data.path(), run).unwrap();
        crate::file_changes::invalidate_run(run);
        crate::file_changes::hydrate_run(data.path(), run);
        let restored = crate::file_changes::get_cached_execution_changes(run, &execution).unwrap();
        assert_eq!(rows(&restored), expected);
        crate::file_changes::invalidate_run(run);
    }

    #[test]
    fn verifies_paths_relative_to_subdirectories_and_shadow_repositories() {
        // Subdirectory of a standard Git repository: `--relative` must keep
        // paths relative to that subdirectory, not the Git toplevel.
        let temp = repo();
        let subdir = temp.path().join("src");
        fs::write(subdir.join("tracked.css"), "a\nB\nc\n").unwrap();
        fs::remove_file(subdir.join("removed.ts")).unwrap();
        let sub_summary = FileChangeSummary::from_files(
            vec![
                lead("tracked.css", "modified", "bash-candidate"),
                lead("removed.ts", "deleted", "bash"),
                lead("scratch.tmp", "deleted", "bash"),
            ],
            false,
            None,
        );
        let verified_sub = verify_bash_changes(sub_summary, &[], &fallback(&subdir));
        assert_eq!(
            rows(&verified_sub),
            [
                ("removed.ts".into(), "deleted".into(), 0, 2),
                ("tracked.css".into(), "modified".into(), 1, 1),
            ]
        );

        // Plain folder with a materialized shadow repository.
        let plain_temp = tempfile::tempdir().unwrap();
        let plain = plain_temp.path().join("plain");
        fs::create_dir_all(&plain).unwrap();
        fs::write(plain.join("a.txt"), "old\n").unwrap();
        fs::write(plain.join("b.txt"), "bye\n").unwrap();
        let _shadow_head = crate::workspace::snapshot_repository(&plain).unwrap();
        fs::write(plain.join("a.txt"), "new\n").unwrap();
        fs::remove_file(plain.join("b.txt")).unwrap();
        fs::write(plain.join("c.txt"), "added\n").unwrap();
        let plain_summary = FileChangeSummary::from_files(
            vec![
                lead("a.txt", "modified", "bash-candidate"),
                lead("b.txt", "deleted", "bash"),
                lead("c.txt", "modified", "bash-candidate"),
                lead("scratch.tmp", "deleted", "bash"),
            ],
            false,
            None,
        );
        let verified_plain = verify_bash_changes(plain_summary, &[], &fallback(&plain));
        assert_eq!(
            rows(&verified_plain),
            [
                ("a.txt".into(), "modified".into(), 1, 1),
                ("b.txt".into(), "deleted".into(), 0, 1),
                ("c.txt".into(), "added".into(), 1, 0),
            ]
        );
    }
}
