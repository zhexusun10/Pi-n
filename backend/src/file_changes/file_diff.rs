//! Unified per-file diff extraction for the Changes panel.
//! Mirrors `pi-gpui`'s read-only diff model (`hunk`, `context`, `added`, `removed`,
//! binary detection, and bounded line rendering) while honoring Pi^n's shadow
//! repositories, isolated worktrees, and path-safety boundaries.

use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Component, Path},
};

/// Lines returned per file; the rest is summarized so huge generated files
/// stay responsive in the browser.
pub const MAX_DIFF_LINES_PER_FILE: usize = 1_500;
/// Untracked/newly added files larger than this are marked binary/unpreviewable
/// without reading megabytes into memory.
pub const MAX_UNTRACKED_DIFF_BYTES: u64 = 512 * 1024;
const UNIFIED_CONTEXT_LINES: usize = 3;
const EMPTY_TREE_SHA1: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const EMPTY_TREE_SHA256: &str = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DiffLineKind {
    Hunk,
    Context,
    Added,
    Removed,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileDiffLine {
    pub kind: DiffLineKind,
    pub text: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileDiffResult {
    pub run_id: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub binary: bool,
    pub truncated: bool,
    pub hidden_lines: usize,
    pub lines: Vec<FileDiffLine>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ParsedFileDiff {
    pub old_path: Option<String>,
    pub binary: bool,
    pub truncated: bool,
    pub hidden_lines: usize,
    pub lines: Vec<FileDiffLine>,
}

pub fn validate_relative_diff_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err("必须提供有效的文件路径。".into());
    }
    let normalized = trimmed.replace('\\', "/");
    if normalized.starts_with('/') || normalized == ".git" || normalized.starts_with(".git/") {
        return Err("文件路径不合法。".into());
    }
    let rel = Path::new(&normalized);
    if rel.is_absolute() {
        return Err("文件路径不合法。".into());
    }
    for component in rel.components() {
        match component {
            Component::Normal(_) => {}
            Component::CurDir | Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("文件路径包含非法路径片段。".into());
            }
        }
    }
    if crate::path_identity::is_runtime_metadata_path(rel) {
        return Err("不允许读取内部元数据路径。".into());
    }
    Ok(normalized)
}

/// Parse `git diff --no-color --no-ext-diff` output for a single file.
pub fn parse_unified_diff(output: &str, max_lines: usize) -> ParsedFileDiff {
    let mut parsed = ParsedFileDiff::default();
    let mut in_hunk = false;
    let mut saw_header = false;
    let mut is_combined = false;
    let mut combined_cols: usize = 0;

    for line in output.lines() {
        if line.starts_with("diff --git ") {
            saw_header = true;
            in_hunk = false;
            is_combined = false;
            combined_cols = 0;
            continue;
        }
        if line.starts_with("diff --cc ") || line.starts_with("diff --combined ") {
            saw_header = true;
            in_hunk = false;
            is_combined = true;
            combined_cols = 2;
            continue;
        }
        if !saw_header {
            continue;
        }
        if line.starts_with("@@") {
            in_hunk = true;
            if is_combined {
                let at_count = line.bytes().take_while(|byte| *byte == b'@').count();
                combined_cols = at_count.saturating_sub(1).max(2);
            }
            push_bounded_line(&mut parsed, DiffLineKind::Hunk, line, max_lines);
            continue;
        }
        if !in_hunk {
            if let Some(from) = line.strip_prefix("rename from ") {
                parsed.old_path = Some(from.to_string());
            } else if line.starts_with("Binary files ") || line == "GIT binary patch" {
                parsed.binary = true;
            }
            continue;
        }
        if is_combined {
            if line.starts_with('\\') || line.len() < combined_cols {
                continue;
            }
            let prefix = &line.as_bytes()[..combined_cols];
            if !prefix
                .iter()
                .all(|byte| matches!(*byte, b'+' | b'-' | b' '))
            {
                continue;
            }
            let text = &line[combined_cols..];
            let kind = if prefix.iter().all(|byte| *byte == b' ') {
                DiffLineKind::Context
            } else if prefix.contains(&b'+') {
                DiffLineKind::Added
            } else {
                DiffLineKind::Removed
            };
            push_bounded_line(&mut parsed, kind, text, max_lines);
            continue;
        }
        let Some(first) = line.as_bytes().first().copied() else {
            continue;
        };
        let (kind, text) = match first {
            b'+' => (DiffLineKind::Added, &line[1..]),
            b'-' => (DiffLineKind::Removed, &line[1..]),
            b' ' => (DiffLineKind::Context, &line[1..]),
            // "\ No newline at end of file" or unexpected metadata
            _ => continue,
        };
        push_bounded_line(&mut parsed, kind, text, max_lines);
    }

    parsed
}

fn push_bounded_line(
    parsed: &mut ParsedFileDiff,
    kind: DiffLineKind,
    text: &str,
    max_lines: usize,
) {
    if parsed.lines.len() < max_lines {
        parsed.lines.push(FileDiffLine {
            kind,
            text: text.to_string(),
        });
    } else {
        parsed.truncated = true;
        parsed.hidden_lines += 1;
    }
}

fn run_snapshot_git(repo_or_worktree: &Path, args: &[&str]) -> Result<String, String> {
    crate::workspace::repository_git(repo_or_worktree, args)
        .or_else(|_| crate::workspace::git(repo_or_worktree, args))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WorkingTreeGit {
    Direct,
    Shadow,
    None,
}

fn detect_working_tree_git(path: &Path) -> WorkingTreeGit {
    if !path.exists() {
        return WorkingTreeGit::None;
    }
    if path.join(".git").exists() || crate::workspace::private_git_dir(path).is_some() {
        return WorkingTreeGit::Direct;
    }
    if crate::workspace::shadow_repo_if_exists(path)
        .ok()
        .flatten()
        .is_some()
    {
        return WorkingTreeGit::Shadow;
    }
    if crate::workspace::git(path, &["rev-parse", "--is-inside-work-tree"])
        .is_ok_and(|out| out.trim() == "true")
    {
        return WorkingTreeGit::Direct;
    }
    WorkingTreeGit::None
}

fn run_working_tree_git_mode(
    mode: WorkingTreeGit,
    repo_or_worktree: &Path,
    args: &[&str],
) -> Result<String, String> {
    match mode {
        WorkingTreeGit::Direct => crate::workspace::git(repo_or_worktree, args),
        WorkingTreeGit::Shadow => crate::workspace::repository_git(repo_or_worktree, args),
        WorkingTreeGit::None => Err("Not a Git workspace".into()),
    }
}

fn compute_git_file_diff_with(
    repo_or_worktree: &Path,
    before: &str,
    after: Option<&str>,
    path: &str,
    old_path: Option<&str>,
    runner: impl FnOnce(&Path, &[&str]) -> Result<String, String>,
) -> Option<ParsedFileDiff> {
    if before.is_empty() || !repo_or_worktree.exists() {
        return None;
    }
    let after = after.filter(|sha| !sha.is_empty());
    if after == Some(before) {
        return None;
    }

    let mut args = vec![
        "-c",
        "core.quotePath=false",
        "--literal-pathspecs",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        before,
    ];
    if let Some(after_sha) = after {
        args.push(after_sha);
    }
    args.push("--");
    if let Some(old) = old_path.filter(|old| !old.is_empty() && *old != path) {
        args.push(old);
    }
    args.push(path);

    let output = runner(repo_or_worktree, &args).ok()?;
    if output.trim().is_empty() {
        return None;
    }
    let parsed = parse_unified_diff(&output, MAX_DIFF_LINES_PER_FILE);
    if parsed.binary || !parsed.lines.is_empty() || output.contains("rename from ") {
        Some(parsed)
    } else {
        None
    }
}

/// Compute unified diff for `path` (and optional `old_path`) between `before`
/// and optional `after` (or live working tree when `after` is `None`).
pub fn compute_git_file_diff(
    repo_or_worktree: &Path,
    before: &str,
    after: Option<&str>,
    path: &str,
    old_path: Option<&str>,
) -> Option<ParsedFileDiff> {
    compute_git_file_diff_with(
        repo_or_worktree,
        before,
        after,
        path,
        old_path,
        run_snapshot_git,
    )
}

/// Whether `repo_or_worktree` has a physical working-tree Git repository
/// (standard `.git`, subdirectory of a Git worktree, private slot Git dir, or
/// existing shadow repository).
pub fn has_working_tree_git(repo_or_worktree: &Path) -> bool {
    detect_working_tree_git(repo_or_worktree) != WorkingTreeGit::None
}

/// Whether `path` exists in the physical working tree's `HEAD` (never an
/// external shadow snapshot on a standard Git repository).
pub fn path_exists_in_working_tree_head(repo_or_worktree: &Path, path: &str) -> bool {
    let mode = detect_working_tree_git(repo_or_worktree);
    if mode == WorkingTreeGit::None {
        return false;
    }
    // `HEAD:./<path>` resolves relative to `repo_or_worktree` even when it is
    // a subdirectory of a Git repository.
    let spec = format!("HEAD:./{path}");
    run_working_tree_git_mode(mode, repo_or_worktree, &["cat-file", "-e", &spec]).is_ok()
}

/// `HEAD`, or the empty tree on an unborn repository. `None` outside Git.
fn head_base(mode: WorkingTreeGit, repo_or_worktree: &Path) -> Option<String> {
    match run_working_tree_git_mode(
        mode,
        repo_or_worktree,
        &["rev-parse", "--verify", "--quiet", "HEAD"],
    ) {
        Ok(_) => Some("HEAD".to_string()),
        Err(_) => {
            run_working_tree_git_mode(mode, repo_or_worktree, &["rev-parse", "--git-dir"]).ok()?;
            let format = run_working_tree_git_mode(
                mode,
                repo_or_worktree,
                &["rev-parse", "--show-object-format=storage"],
            )
            .unwrap_or_default();
            Some(if format.trim() == "sha256" {
                EMPTY_TREE_SHA256.to_string()
            } else {
                EMPTY_TREE_SHA1.to_string()
            })
        }
    }
}

/// What Git says about a bounded set of paths relative to a baseline.
#[derive(Clone, Debug)]
pub(super) struct PathBaseline {
    /// Tracked differences keyed by path (no rename detection).
    pub changes: std::collections::BTreeMap<String, super::FileChangeItem>,
    /// Untracked, non-ignored files below the requested paths (live tree only).
    pub untracked: Vec<String>,
}

/// Why a baseline may be missing matters: a workspace without Git will never
/// have one, while a failed Git call is transient and must not be frozen into
/// a durable result.
#[derive(Clone, Debug)]
pub(super) enum BaselineOutcome {
    NoGit,
    Failed,
    Ready(PathBaseline),
}

const BASELINE_PATH_CHUNK: usize = 200;
const BASELINE_UNTRACKED_LIMIT: usize = 2_000;

/// Compare `paths` with the baseline: the execution's `before` snapshot when it
/// has one (to `after`, or the live tree), otherwise the real working-tree
/// `HEAD`. Ignored paths never appear. `None` means no usable Git baseline,
/// which callers must treat as unknown rather than as "unchanged".
pub(super) fn path_baseline(
    root: &Path,
    before: &str,
    after: Option<&str>,
    paths: &[String],
) -> BaselineOutcome {
    match path_baseline_inner(root, before, after, paths) {
        Ok(Some(baseline)) => BaselineOutcome::Ready(baseline),
        Ok(None) => BaselineOutcome::NoGit,
        Err(()) => BaselineOutcome::Failed,
    }
}

fn path_baseline_inner(
    root: &Path,
    before: &str,
    after: Option<&str>,
    paths: &[String],
) -> Result<Option<PathBaseline>, ()> {
    if paths.is_empty() || !root.exists() {
        return Ok(None);
    }
    let after = after.filter(|sha| !sha.is_empty());
    let explicit = !before.is_empty();
    let mode = if explicit {
        None
    } else {
        match detect_working_tree_git(root) {
            WorkingTreeGit::None => return Ok(None),
            mode => Some(mode),
        }
    };
    let run = |args: &[&str]| match mode {
        Some(mode) => run_working_tree_git_mode(mode, root, args),
        None => run_snapshot_git(root, args),
    };
    let base = match mode {
        Some(mode) => head_base(mode, root).ok_or(())?,
        None => before.to_string(),
    };
    if after == Some(base.as_str()) {
        return Ok(Some(PathBaseline {
            changes: Default::default(),
            untracked: Vec::new(),
        }));
    }
    let mut changes = std::collections::BTreeMap::new();
    let mut untracked = Vec::new();
    for chunk in paths.chunks(BASELINE_PATH_CHUNK) {
        let mut args = vec![
            "-c",
            "core.quotePath=false",
            // A read-only probe must not start a user's fsmonitor daemon.
            "-c",
            "core.fsmonitor=false",
            "--literal-pathspecs",
            "diff",
            "--raw",
            "--no-abbrev",
            "--numstat",
            "-z",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            "--relative",
            base.as_str(),
        ];
        if let Some(after) = after {
            args.push(after);
        }
        args.push("--");
        args.extend(chunk.iter().map(String::as_str));
        let output = run(&args).map_err(|_| ())?;
        let mut parsed = super::git_diff::parse(&output, "", "").ok_or(())?;
        if after.is_none() {
            super::stamp_working_tree_versions(root, &mut parsed);
        }
        changes.extend(parsed);
        if after.is_none() {
            let mut args = vec![
                "-c",
                "core.quotePath=false",
                "-c",
                "core.fsmonitor=false",
                "--literal-pathspecs",
                "ls-files",
                "--others",
                "--exclude-standard",
                "-z",
                "--",
            ];
            args.extend(chunk.iter().map(String::as_str));
            let output = run(&args).map_err(|_| ())?;
            untracked.extend(
                output
                    .split('\0')
                    .filter(|path| !path.is_empty())
                    .take(BASELINE_UNTRACKED_LIMIT.saturating_sub(untracked.len()))
                    .map(str::to_string),
            );
        }
    }
    Ok(Some(PathBaseline { changes, untracked }))
}

/// Compute working-tree diff against `HEAD` (or the empty tree on an unborn
/// repo). Standard Git repositories and their subdirectories compare against
/// the user's real `HEAD` instead of Pi^n's shadow snapshot `HEAD`.
pub fn compute_head_file_diff(
    repo_or_worktree: &Path,
    path: &str,
    old_path: Option<&str>,
) -> Option<ParsedFileDiff> {
    let mode = detect_working_tree_git(repo_or_worktree);
    if mode == WorkingTreeGit::None {
        return None;
    }
    let base = head_base(mode, repo_or_worktree)?;
    compute_git_file_diff_with(repo_or_worktree, &base, None, path, old_path, |dir, args| {
        run_working_tree_git_mode(mode, dir, args)
    })
}

#[derive(Clone, Debug)]
enum TranscriptOp {
    Write(String),
    Edit(Vec<(String, String)>),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DiffOp<'a> {
    Context(&'a str),
    Removed(&'a str),
    Added(&'a str),
}

fn split_text_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        Vec::new()
    } else {
        text.lines().collect()
    }
}

fn build_line_diff_ops<'a>(old_lines: &[&'a str], new_lines: &[&'a str]) -> Vec<DiffOp<'a>> {
    let mut prefix = 0;
    while prefix < old_lines.len()
        && prefix < new_lines.len()
        && old_lines[prefix] == new_lines[prefix]
    {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < (old_lines.len() - prefix)
        && suffix < (new_lines.len() - prefix)
        && old_lines[old_lines.len() - 1 - suffix] == new_lines[new_lines.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let mid_old = &old_lines[prefix..old_lines.len() - suffix];
    let mid_new = &new_lines[prefix..new_lines.len() - suffix];
    if mid_old.is_empty() && mid_new.is_empty() {
        return Vec::new();
    }

    let mut ops = Vec::with_capacity(old_lines.len().max(new_lines.len()) + 8);
    for line in &old_lines[..prefix] {
        ops.push(DiffOp::Context(line));
    }

    if mid_old.is_empty() {
        for line in mid_new {
            ops.push(DiffOp::Added(line));
        }
    } else if mid_new.is_empty() {
        for line in mid_old {
            ops.push(DiffOp::Removed(line));
        }
    } else if mid_old.len().saturating_mul(mid_new.len()) <= 64_000 {
        let (m, n) = (mid_old.len(), mid_new.len());
        let mut dp = vec![vec![0u32; n + 1]; m + 1];
        for i in (0..m).rev() {
            for j in (0..n).rev() {
                dp[i][j] = if mid_old[i] == mid_new[j] {
                    dp[i + 1][j + 1] + 1
                } else {
                    dp[i + 1][j].max(dp[i][j + 1])
                };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < m && j < n {
            if mid_old[i] == mid_new[j] {
                ops.push(DiffOp::Context(mid_old[i]));
                i += 1;
                j += 1;
            } else if dp[i + 1][j] >= dp[i][j + 1] {
                ops.push(DiffOp::Removed(mid_old[i]));
                i += 1;
            } else {
                ops.push(DiffOp::Added(mid_new[j]));
                j += 1;
            }
        }
        while i < m {
            ops.push(DiffOp::Removed(mid_old[i]));
            i += 1;
        }
        while j < n {
            ops.push(DiffOp::Added(mid_new[j]));
            j += 1;
        }
    } else {
        for line in mid_old {
            ops.push(DiffOp::Removed(line));
        }
        for line in mid_new {
            ops.push(DiffOp::Added(line));
        }
    }

    for line in &old_lines[old_lines.len() - suffix..] {
        ops.push(DiffOp::Context(line));
    }
    ops
}

fn append_text_diff_hunks(
    parsed: &mut ParsedFileDiff,
    old_text: &str,
    new_text: &str,
    max_lines: usize,
) {
    let old_lines = split_text_lines(old_text);
    let new_lines = split_text_lines(new_text);
    let ops = build_line_diff_ops(&old_lines, &new_lines);
    if ops.is_empty() {
        return;
    }

    // Track 1-based line numbers before each op so hunk headers match unified diff format.
    let mut positions = Vec::with_capacity(ops.len());
    let (mut old_no, mut new_no) = (1usize, 1usize);
    for op in &ops {
        positions.push((old_no, new_no));
        match op {
            DiffOp::Context(_) => {
                old_no += 1;
                new_no += 1;
            }
            DiffOp::Removed(_) => old_no += 1,
            DiffOp::Added(_) => new_no += 1,
        }
    }

    let change_indices: Vec<usize> = ops
        .iter()
        .enumerate()
        .filter_map(|(idx, op)| (!matches!(op, DiffOp::Context(_))).then_some(idx))
        .collect();
    if change_indices.is_empty() {
        return;
    }

    // Merge nearby changes whose context windows touch or overlap.
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for idx in change_indices {
        let start = idx.saturating_sub(UNIFIED_CONTEXT_LINES);
        let end = (idx + UNIFIED_CONTEXT_LINES + 1).min(ops.len());
        if let Some(last) = ranges.last_mut() {
            if start <= last.1 {
                last.1 = last.1.max(end);
                continue;
            }
        }
        ranges.push((start, end));
    }

    for (start, end) in ranges {
        let slice = &ops[start..end];
        let old_count = slice
            .iter()
            .filter(|op| matches!(op, DiffOp::Context(_) | DiffOp::Removed(_)))
            .count();
        let new_count = slice
            .iter()
            .filter(|op| matches!(op, DiffOp::Context(_) | DiffOp::Added(_)))
            .count();
        let (old_start, new_start) = positions[start];
        let header = format!(
            "@@ -{},{} +{},{} @@",
            if old_count == 0 {
                old_start.saturating_sub(1)
            } else {
                old_start
            },
            old_count,
            if new_count == 0 {
                new_start.saturating_sub(1)
            } else {
                new_start
            },
            new_count
        );
        push_bounded_line(parsed, DiffLineKind::Hunk, &header, max_lines);
        for op in slice {
            match op {
                DiffOp::Context(text) => {
                    push_bounded_line(parsed, DiffLineKind::Context, text, max_lines)
                }
                DiffOp::Removed(text) => {
                    push_bounded_line(parsed, DiffLineKind::Removed, text, max_lines)
                }
                DiffOp::Added(text) => {
                    push_bounded_line(parsed, DiffLineKind::Added, text, max_lines)
                }
            }
        }
    }
}

fn append_added_content(parsed: &mut ParsedFileDiff, content: &str, max_lines: usize) {
    if content.as_bytes().iter().take(8_000).any(|byte| *byte == 0) {
        parsed.binary = true;
        return;
    }
    let lines = split_text_lines(content);
    if lines.is_empty() {
        return;
    }
    let header = format!("@@ -0,0 +1,{} @@", lines.len());
    push_bounded_line(parsed, DiffLineKind::Hunk, &header, max_lines);
    for line in lines {
        push_bounded_line(parsed, DiffLineKind::Added, line, max_lines);
    }
}

fn extract_tool_op(
    tool_name: &str,
    args: &serde_json::Value,
    target_path: &str,
    worktree: &str,
    repository: &str,
) -> Option<TranscriptOp> {
    match tool_name {
        "write" => {
            let raw_path = args["path"].as_str().unwrap_or_default();
            let norm = crate::file_changes::normalize_workspace_path(raw_path, worktree, repository)?;
            if norm != target_path {
                return None;
            }
            let content = args["content"].as_str()?.to_string();
            Some(TranscriptOp::Write(content))
        }
        "edit" => {
            let raw_path = args["path"].as_str().unwrap_or_default();
            let norm = crate::file_changes::normalize_workspace_path(raw_path, worktree, repository)?;
            if norm != target_path {
                return None;
            }
            let mut edits = Vec::new();
            if let Some(items) = args["edits"].as_array() {
                for item in items {
                    let old_t = item["oldText"]
                        .as_str()
                        .or_else(|| item["old_text"].as_str())
                        .unwrap_or_default();
                    let new_t = item["newText"]
                        .as_str()
                        .or_else(|| item["new_text"].as_str())
                        .unwrap_or_default();
                    if old_t != new_t {
                        edits.push((old_t.to_string(), new_t.to_string()));
                    }
                }
            } else {
                let old_t = args["oldText"]
                    .as_str()
                    .or_else(|| args["old_text"].as_str());
                let new_t = args["newText"]
                    .as_str()
                    .or_else(|| args["new_text"].as_str());
                if let (Some(old_t), Some(new_t)) = (old_t, new_t) {
                    if old_t != new_t {
                        edits.push((old_t.to_string(), new_t.to_string()));
                    }
                }
            }
            (!edits.is_empty()).then_some(TranscriptOp::Edit(edits))
        }
        _ => None,
    }
}

/// Reconstructs per-file unified diffs from execution / planning JSONL
/// transcripts when Git snapshots are unavailable (serial runs, source-direct
/// graph nodes, already-committed changes, plain folders, or reclaimed slots).
pub struct TranscriptDiffAccumulator {
    target_path: String,
    committed: Vec<TranscriptOp>,
}

impl TranscriptDiffAccumulator {
    pub fn new(target_path: impl Into<String>) -> Self {
        Self {
            target_path: target_path.into(),
            committed: Vec::new(),
        }
    }

    pub fn feed_jsonl(
        &mut self,
        jsonl: &str,
        worktree: &str,
        repository: &str,
        is_running: bool,
    ) {
        let mut settled_ids = HashSet::<String>::new();
        let mut pending_ops = HashMap::<String, TranscriptOp>::new();
        let mut pending_order = Vec::<String>::new();
        let mut process_alive = is_running;

        let record_pending = |id: String,
                              op: TranscriptOp,
                              pending_ops: &mut HashMap<String, TranscriptOp>,
                              pending_order: &mut Vec<String>| {
            if !pending_ops.contains_key(&id) {
                pending_order.push(id.clone());
            }
            pending_ops.insert(id, op);
        };

        for raw_line in jsonl.lines() {
            let line = raw_line.trim();
            if line.is_empty() || (!line.contains("\"tool") && !line.contains("\"pi_n_process")) {
                continue;
            }
            let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            let Some(event_type) = event["type"].as_str() else {
                continue;
            };

            match event_type {
                "tool_execution_start" | "tool_execution_update" => {
                    let id = event["toolCallId"].as_str().unwrap_or_default().to_string();
                    if id.is_empty() || settled_ids.contains(&id) {
                        continue;
                    }
                    let tool_name = event["toolName"].as_str().unwrap_or_default();
                    let args = &event["args"];
                    if let Some(op) = extract_tool_op(
                        tool_name,
                        args,
                        &self.target_path,
                        worktree,
                        repository,
                    ) {
                        record_pending(id, op, &mut pending_ops, &mut pending_order);
                    }
                }
                "message_update" => {
                    let sub = &event["assistantMessageEvent"];
                    if sub["type"] == "toolcall_end" {
                        let tc = &sub["toolCall"];
                        let id = tc["id"].as_str().unwrap_or_default().to_string();
                        if id.is_empty() || settled_ids.contains(&id) {
                            continue;
                        }
                        let tool_name = tc["name"].as_str().unwrap_or_default();
                        let args = &tc["arguments"];
                        if let Some(op) = extract_tool_op(
                            tool_name,
                            args,
                            &self.target_path,
                            worktree,
                            repository,
                        ) {
                            record_pending(id, op, &mut pending_ops, &mut pending_order);
                        }
                    }
                }
                "tool_execution_end" => {
                    let id = event["toolCallId"].as_str().unwrap_or_default();
                    if !id.is_empty() {
                        settled_ids.insert(id.to_string());
                    }
                    let exit_code = event["result"]["details"]["exitCode"].as_i64();
                    let is_error = event["isError"].as_bool().unwrap_or(false)
                        || event["result"]["isError"].as_bool().unwrap_or(false)
                        || exit_code.is_some_and(|code| code != 0);
                    if let Some(op) = pending_ops.remove(id) {
                        if !is_error {
                            self.committed.push(op);
                        }
                    } else if !is_error {
                        let tool_name = event["toolName"].as_str().unwrap_or_default();
                        if let Some(op) = extract_tool_op(
                            tool_name,
                            &event["args"],
                            &self.target_path,
                            worktree,
                            repository,
                        ) {
                            self.committed.push(op);
                        }
                    }
                }
                "message" | "message_end" => {
                    let msg = &event["message"];
                    if msg["role"] == "assistant" {
                        if let Some(parts) = msg["content"].as_array() {
                            for part in parts {
                                if part["type"] == "toolCall" {
                                    let id = part["id"].as_str().unwrap_or_default().to_string();
                                    if !id.is_empty() && settled_ids.contains(&id) {
                                        continue;
                                    }
                                    let tool_name = part["name"].as_str().unwrap_or_default();
                                    let args = &part["arguments"];
                                    if !id.is_empty() {
                                        if let Some(op) = extract_tool_op(
                                            tool_name,
                                            args,
                                            &self.target_path,
                                            worktree,
                                            repository,
                                        ) {
                                            record_pending(
                                                id,
                                                op,
                                                &mut pending_ops,
                                                &mut pending_order,
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    } else if msg["role"] == "toolResult" {
                        let id = msg["toolCallId"].as_str().unwrap_or_default();
                        if !id.is_empty() {
                            settled_ids.insert(id.to_string());
                        }
                        let exit_code = msg["details"]["exitCode"].as_i64();
                        let is_error = msg["isError"].as_bool().unwrap_or(false)
                            || exit_code.is_some_and(|code| code != 0);
                        if let Some(op) = pending_ops.remove(id) {
                            if !is_error {
                                self.committed.push(op);
                            }
                        }
                    }
                }
                "pi_n_process_exited" => {
                    process_alive = false;
                    pending_ops.clear();
                    pending_order.clear();
                }
                "pi_n_process_started" | "pi_n_session_resumed" => {
                    process_alive = is_running;
                }
                _ => {}
            }
        }

        if process_alive {
            for id in pending_order {
                if let Some(op) = pending_ops.remove(&id) {
                    self.committed.push(op);
                }
            }
        }
    }

    pub fn finish(self, max_lines: usize) -> Option<ParsedFileDiff> {
        if self.committed.is_empty() {
            return None;
        }
        let mut parsed = ParsedFileDiff::default();
        let mut written_doc: Option<String> = None;

        for op in self.committed {
            match op {
                TranscriptOp::Write(content) => {
                    // A full write supersedes any earlier partial edits to this
                    // path; subsequent edits that match will fold into it.
                    parsed = ParsedFileDiff::default();
                    written_doc = Some(content);
                }
                TranscriptOp::Edit(edits) => {
                    if let Some(mut doc) = written_doc.take() {
                        let mut unmatched = Vec::new();
                        for (old_text, new_text) in edits {
                            if !old_text.is_empty() && doc.contains(&old_text) {
                                doc = doc.replacen(&old_text, &new_text, 1);
                            } else {
                                unmatched.push((old_text, new_text));
                            }
                        }
                        if unmatched.is_empty() {
                            written_doc = Some(doc);
                        } else {
                            append_added_content(&mut parsed, &doc, max_lines);
                            for (old_text, new_text) in unmatched {
                                append_text_diff_hunks(&mut parsed, &old_text, &new_text, max_lines);
                            }
                        }
                    } else {
                        for (old_text, new_text) in edits {
                            append_text_diff_hunks(&mut parsed, &old_text, &new_text, max_lines);
                        }
                    }
                }
            }
        }

        if let Some(doc) = written_doc {
            append_added_content(&mut parsed, &doc, max_lines);
        }

        if parsed.binary || !parsed.lines.is_empty() {
            Some(parsed)
        } else {
            None
        }
    }
}

pub fn compute_transcript_file_diff(
    jsonl: &str,
    target_path: &str,
    worktree: &str,
    repository: &str,
    is_running: bool,
    max_lines: usize,
) -> Option<ParsedFileDiff> {
    let mut acc = TranscriptDiffAccumulator::new(target_path);
    acc.feed_jsonl(jsonl, worktree, repository, is_running);
    acc.finish(max_lines)
}

/// Read an untracked or newly added file safely within `root` and format all
/// its lines as additions (or mark it binary when NUL bytes / >512 KiB).
pub fn read_added_file_diff(root: &Path, path: &str) -> Option<ParsedFileDiff> {
    use std::io::Read;
    let target = crate::path_safety::real_child_path(root, &root.join(path), true).ok()??;
    let file = fs::File::open(&target).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() {
        return None;
    }
    if metadata.len() > MAX_UNTRACKED_DIFF_BYTES {
        return Some(ParsedFileDiff {
            binary: true,
            ..Default::default()
        });
    }
    // Bound reads even if the file grows concurrently after `metadata()`.
    let mut bytes = Vec::new();
    file.take(MAX_UNTRACKED_DIFF_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_UNTRACKED_DIFF_BYTES {
        return Some(ParsedFileDiff {
            binary: true,
            ..Default::default()
        });
    }
    if bytes.iter().take(8_000).any(|byte| *byte == 0) {
        return Some(ParsedFileDiff {
            binary: true,
            ..Default::default()
        });
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut parsed = ParsedFileDiff::default();
    for line in text.lines() {
        push_bounded_line(&mut parsed, DiffLineKind::Added, line, MAX_DIFF_LINES_PER_FILE);
    }
    Some(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hunks_additions_removals_and_truncation() {
        let raw = "\
diff --git a/src/ledger.rs b/src/ledger.rs
index 1111111..2222222 100644
--- a/src/ledger.rs
+++ b/src/ledger.rs
@@ -1,3 +1,4 @@ fn apply() {
 keep
-old
+new1
+new2
\\ No newline at end of file
";
        let full = parse_unified_diff(raw, 100);
        assert!(!full.binary);
        assert!(!full.truncated);
        assert_eq!(full.hidden_lines, 0);
        assert_eq!(full.lines.len(), 5);
        assert_eq!(full.lines[0].kind, DiffLineKind::Hunk);
        assert_eq!(full.lines[1], FileDiffLine { kind: DiffLineKind::Context, text: "keep".into() });
        assert_eq!(full.lines[2], FileDiffLine { kind: DiffLineKind::Removed, text: "old".into() });
        assert_eq!(full.lines[3], FileDiffLine { kind: DiffLineKind::Added, text: "new1".into() });
        assert_eq!(full.lines[4], FileDiffLine { kind: DiffLineKind::Added, text: "new2".into() });

        let capped = parse_unified_diff(raw, 3);
        assert!(capped.truncated);
        assert_eq!(capped.hidden_lines, 2);
        assert_eq!(capped.lines.len(), 3);
    }

    #[test]
    fn detects_binary_and_rename_headers() {
        let bin = "\
diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
";
        let parsed = parse_unified_diff(bin, 100);
        assert!(parsed.binary);
        assert!(parsed.lines.is_empty());

        let ren = "\
diff --git a/old.txt b/new.txt
similarity index 100%
rename from old.txt
rename to new.txt
";
        let renamed = parse_unified_diff(ren, 100);
        assert!(!renamed.binary);
        assert_eq!(renamed.old_path.as_deref(), Some("old.txt"));
        assert!(renamed.lines.is_empty());
    }

    #[test]
    fn rejects_invalid_and_traversal_paths() {
        assert!(validate_relative_diff_path("").is_err());
        assert!(validate_relative_diff_path("../secret.txt").is_err());
        assert!(validate_relative_diff_path("a/../b.txt").is_err());
        assert!(validate_relative_diff_path("/etc/passwd").is_err());
        assert!(validate_relative_diff_path(".git/config").is_err());
        assert!(validate_relative_diff_path(".pi-n/state.json").is_err());
        assert_eq!(validate_relative_diff_path("src/ledger.rs").unwrap(), "src/ledger.rs");
    }

    #[test]
    fn computes_transcript_diff_for_edits_writes_and_errors() {
        let jsonl = [
            r#"{"type":"tool_execution_start","toolCallId":"t1","toolName":"edit","args":{"path":"src/app.ts","edits":[{"oldText":"const a = 1;\nconst b = 2;\n","newText":"const a = 1;\nconst b = 3;\nconst c = 4;\n"}]}}"#,
            r#"{"type":"tool_execution_end","toolCallId":"t1","toolName":"edit","isError":false}"#,
            r#"{"type":"tool_execution_start","toolCallId":"t2","toolName":"edit","args":{"path":"src/app.ts","edits":[{"oldText":"bad","newText":"ignored"}]}}"#,
            r#"{"type":"tool_execution_end","toolCallId":"t2","toolName":"edit","isError":true}"#,
            r#"{"type":"tool_execution_start","toolCallId":"t3","toolName":"write","args":{"path":"src/new.ts","content":"line1\nline2\n"}}"#,
            r#"{"type":"tool_execution_end","toolCallId":"t3","toolName":"write","isError":false}"#,
            r#"{"type":"tool_execution_start","toolCallId":"t4","toolName":"edit","args":{"path":"src/new.ts","oldText":"line2","newText":"line2-edited"}}"#,
            r#"{"type":"tool_execution_end","toolCallId":"t4","toolName":"edit","isError":false}"#,
        ]
        .join("\n");

        let edited = compute_transcript_file_diff(&jsonl, "src/app.ts", "/repo", "/repo", false, 100)
            .expect("edit diff should be reconstructed");
        assert!(!edited.binary);
        assert!(edited.lines.iter().any(|l| l.kind == DiffLineKind::Hunk));
        assert!(edited
            .lines
            .iter()
            .any(|l| l.kind == DiffLineKind::Context && l.text == "const a = 1;"));
        assert!(edited
            .lines
            .iter()
            .any(|l| l.kind == DiffLineKind::Removed && l.text == "const b = 2;"));
        assert!(edited
            .lines
            .iter()
            .any(|l| l.kind == DiffLineKind::Added && l.text == "const b = 3;"));
        assert!(edited
            .lines
            .iter()
            .any(|l| l.kind == DiffLineKind::Added && l.text == "const c = 4;"));
        assert!(!edited.lines.iter().any(|l| l.text == "ignored"));

        let written =
            compute_transcript_file_diff(&jsonl, "src/new.ts", "/repo", "/repo", false, 100)
                .expect("write+edit diff should be reconstructed");
        assert!(written
            .lines
            .iter()
            .any(|l| l.kind == DiffLineKind::Added && l.text == "line2-edited"));
    }

    #[test]
    fn head_diff_uses_project_git_head_even_when_shadow_head_matches_worktree() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir(&repo).unwrap();
        crate::workspace::git(&repo, &["init", "-q"]).unwrap();
        crate::workspace::git(&repo, &["config", "user.email", "test@example.com"]).unwrap();
        crate::workspace::git(&repo, &["config", "user.name", "Tester"]).unwrap();
        fs::write(repo.join("file.txt"), "before\n").unwrap();
        crate::workspace::git(&repo, &["add", "."]).unwrap();
        crate::workspace::git(&repo, &["commit", "-qm", "base"]).unwrap();

        // Modify working tree and take a Pi^n shadow snapshot so the shadow
        // repository's HEAD now matches the modified file while .git HEAD does not.
        fs::write(repo.join("file.txt"), "after\n").unwrap();
        let _snapshot = crate::workspace::snapshot_repository(&repo).unwrap();

        let diff = compute_head_file_diff(&repo, "file.txt", None)
            .expect("must diff against real .git HEAD, not shadow HEAD");
        assert!(diff
            .lines
            .iter()
            .any(|l| l.kind == DiffLineKind::Removed && l.text == "before"));
        assert!(diff
            .lines
            .iter()
            .any(|l| l.kind == DiffLineKind::Added && l.text == "after"));
    }

    #[test]
    fn head_diff_works_inside_a_git_subdirectory() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("monorepo");
        let sub = repo.join("packages/web");
        fs::create_dir_all(&sub).unwrap();
        crate::workspace::git(&repo, &["init", "-q"]).unwrap();
        crate::workspace::git(&repo, &["config", "user.email", "test@example.com"]).unwrap();
        crate::workspace::git(&repo, &["config", "user.name", "Tester"]).unwrap();
        fs::write(sub.join("app.ts"), "export const v = 1;\n").unwrap();
        crate::workspace::git(&repo, &["add", "."]).unwrap();
        crate::workspace::git(&repo, &["commit", "-qm", "base"]).unwrap();

        fs::write(sub.join("app.ts"), "export const v = 2;\n").unwrap();

        assert!(has_working_tree_git(&sub));
        assert!(path_exists_in_working_tree_head(&sub, "app.ts"));
        let diff = compute_head_file_diff(&sub, "app.ts", None)
            .expect("subdirectory workspace should diff against parent repo HEAD");
        assert!(diff
            .lines
            .iter()
            .any(|l| l.kind == DiffLineKind::Removed && l.text == "export const v = 1;"));
        assert!(diff
            .lines
            .iter()
            .any(|l| l.kind == DiffLineKind::Added && l.text == "export const v = 2;"));
    }

    #[test]
    fn parses_combined_conflict_diffs_without_leaking_prefix_columns() {
        let raw = "\
diff --cc conflict.txt
index 1111111,2222222..0000000
--- a/conflict.txt
+++ b/conflict.txt
@@@ -1,2 -1,2 +1,4 @@@
  keep
- ours
++merged
\\ No newline at end of file
";
        let parsed = parse_unified_diff(raw, 100);
        assert_eq!(parsed.lines.len(), 4);
        assert_eq!(parsed.lines[0].kind, DiffLineKind::Hunk);
        assert_eq!(
            parsed.lines[1],
            FileDiffLine {
                kind: DiffLineKind::Context,
                text: "keep".into()
            }
        );
        assert_eq!(
            parsed.lines[2],
            FileDiffLine {
                kind: DiffLineKind::Removed,
                text: "ours".into()
            }
        );
        assert_eq!(
            parsed.lines[3],
            FileDiffLine {
                kind: DiffLineKind::Added,
                text: "merged".into()
            }
        );
    }

    #[test]
    fn transcript_write_supersedes_prior_edits_without_duplicating_hunks() {
        let jsonl = [
            r#"{"type":"tool_execution_start","toolCallId":"t1","toolName":"edit","args":{"path":"src/a.ts","edits":[{"oldText":"old","newText":"mid"}]}}"#,
            r#"{"type":"tool_execution_end","toolCallId":"t1","toolName":"edit","isError":false}"#,
            r#"{"type":"tool_execution_start","toolCallId":"t2","toolName":"write","args":{"path":"src/a.ts","content":"final line\n"}}"#,
            r#"{"type":"tool_execution_end","toolCallId":"t2","toolName":"write","isError":false}"#,
        ]
        .join("\n");
        let parsed =
            compute_transcript_file_diff(&jsonl, "src/a.ts", "/repo", "/repo", false, 100)
                .expect("write should produce diff");
        assert!(!parsed.lines.iter().any(|l| l.text == "old" || l.text == "mid"));
        assert!(parsed
            .lines
            .iter()
            .any(|l| l.kind == DiffLineKind::Added && l.text == "final line"));
    }

    #[test]
    fn read_added_file_diff_bounds_size_and_rejects_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("ok.txt"), "hello\nworld\n").unwrap();
        let ok = read_added_file_diff(&root, "ok.txt").unwrap();
        assert!(!ok.binary);
        assert_eq!(ok.lines.len(), 2);

        fs::write(
            root.join("large.txt"),
            vec![b'a'; (MAX_UNTRACKED_DIFF_BYTES + 1) as usize],
        )
        .unwrap();
        let large = read_added_file_diff(&root, "large.txt").unwrap();
        assert!(large.binary);
        assert!(large.lines.is_empty());

        #[cfg(unix)]
        {
            let outside = temp.path().join("secret.txt");
            fs::write(&outside, "secret\n").unwrap();
            std::os::unix::fs::symlink(&outside, root.join("link.txt")).unwrap();
            assert!(read_added_file_diff(&root, "link.txt").is_none());
        }
    }
}
