use crate::{
    cleanup::{self, Manifest, Target},
    model::{Config, EventKind, Execution, Graph, Node},
    runtime::Runtime,
};
use std::{collections::BTreeSet, fs, path::PathBuf};
use uuid::Uuid;

#[path = "cleanup_bench.rs"]
mod bench;

fn setup() -> (tempfile::TempDir, PathBuf, Runtime) {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("user.txt"), "keep user files").unwrap();
    crate::workspace::git(&source, &["init", "-q"]).unwrap();
    let config: Config = serde_json::from_value(
        serde_json::json!({"repository": source, "model":"test", "maxParallel":1}),
    )
    .unwrap();
    let mut runtime = Runtime::open(&temp.path().join("data")).unwrap();
    runtime.create(graph(), config).unwrap();
    runtime.set_route("serial").unwrap();
    // This fixture allocates its current-format workspaces under its own temp
    // parent. Record that ownership explicitly before testing deletion/restart.
    runtime
        .store
        .remember_cleanup_targets(
            &runtime.state.run_id,
            &BTreeSet::from([Target::Workspace {
                parent: temp.path().canonicalize().unwrap(),
                bucket: ".pi-n-worktrees".into(),
                owner: runtime.state.run_id.clone(),
                checkout: None,
            }]),
        )
        .unwrap();
    (temp, source, runtime)
}

#[test]
fn deferred_cleanup_preserves_generation_source_and_active_writer_guards() {
    let (temp, _source, mut runtime) = setup();
    let workspace = temp
        .path()
        .join(".pi-n-worktrees")
        .join(&runtime.state.run_id);
    directory(&workspace);
    let manifest = cleanup::manifest(&runtime.root, &runtime.store, &runtime.state, false).unwrap();
    runtime
        .store
        .enqueue_cleanup(&runtime.state.run_id, &manifest)
        .unwrap();
    runtime.emit(EventKind::Paused { paused: true }).unwrap();
    runtime
        .retry_cleanup_deferred(&runtime.state.run_id)
        .unwrap();
    assert!(
        workspace.is_dir(),
        "a later event cancels the old cleanup generation"
    );
    assert!(runtime.store.detached_workspaces().unwrap().is_empty());

    let adopted = workspace.join("adopted-source");
    fs::create_dir(&adopted).unwrap();
    fs::write(adopted.join("user.txt"), "protected source").unwrap();
    runtime.store.remember_cleanup_source(&adopted).unwrap();
    runtime.defer_cleanup_worktrees().unwrap();
    assert_eq!(
        fs::read_to_string(adopted.join("user.txt")).unwrap(),
        "protected source"
    );
    assert!(runtime.store.detached_workspaces().unwrap().is_empty());

    runtime
        .emit(EventKind::Started {
            execution: execution(&runtime, &Uuid::new_v4().to_string()),
            message_sequences: None,
            fresh_restart: false,
        })
        .unwrap();
    assert!(runtime
        .defer_cleanup_worktrees()
        .unwrap_err()
        .contains("Run is active"));
    assert!(workspace.is_dir());
    assert!(runtime.store.detached_workspaces().unwrap().is_empty());
}

#[test]
fn cleanup_retries_keep_undelivered_private_results() {
    for deferred in [false, true] {
        let (temp, source, mut runtime) = setup();
        runtime.set_route("graph").unwrap();
        runtime
            .emit(EventKind::WorkspaceIsolationSelected { isolated: true })
            .unwrap();
        let id = Uuid::new_v4().to_string();
        runtime
            .emit(EventKind::Started {
                execution: execution(&runtime, &id),
                message_sequences: None,
                fresh_restart: false,
            })
            .unwrap();
        runtime
            .emit(EventKind::Finished {
                execution_id: id,
                head: "undelivered-result".into(),
                output: String::new(),
                output_bytes: 0,
                metrics: None,
            })
            .unwrap();
        let workspace = temp
            .path()
            .join(".pi-n-worktrees")
            .join(&runtime.state.run_id);
        directory(&workspace);
        runtime.cleanup_worktrees().unwrap();
        assert!(workspace.is_dir());
        let manifest =
            cleanup::manifest(&runtime.root, &runtime.store, &runtime.state, false).unwrap();
        runtime
            .store
            .enqueue_cleanup(&runtime.state.run_id, &manifest)
            .unwrap();
        if deferred {
            runtime
                .retry_cleanup_deferred(&runtime.state.run_id)
                .unwrap();
        } else {
            runtime.retry_cleanup(&runtime.state.run_id).unwrap();
        }
        assert!(workspace.join("nested/dependencies/file").is_file());
        assert!(runtime.store.detached_workspaces().unwrap().is_empty());
        assert!(runtime
            .store
            .cleanup_task(&runtime.state.run_id)
            .unwrap()
            .is_none());
        assert!(!runtime
            .store
            .owned_cleanup_targets(&runtime.state.run_id)
            .unwrap()
            .is_empty());
        assert!(source.join("user.txt").is_file());
    }
}

#[test]
fn workspace_cleanup_refuses_active_mergers_and_result_processes() {
    for result_process in [false, true] {
        let (temp, _source, mut runtime) = setup();
        runtime.set_route("graph").unwrap();
        let workspace = temp
            .path()
            .join(".pi-n-worktrees")
            .join(&runtime.state.run_id);
        directory(&workspace);
        if result_process {
            let input = crate::environment::CompositeResult {
                domain: crate::environment::Domain {
                    platform: "fixture".into(),
                    arch: "fixture".into(),
                    baseline: "base".into(),
                    policy: "policy".into(),
                    contract: "contract".into(),
                },
                code_ref: String::new(),
                environment_ref: String::new(),
                launch_ref: String::new(),
                resource_refs: vec![],
                layout: None,
                generation: Uuid::new_v4().to_string(),
                selected_from: vec![],
                inheritance: None,
            };
            runtime
                .emit(EventKind::ResultExecutionStarted {
                    input,
                    args: vec![],
                })
                .unwrap();
        } else {
            let mut merger = execution(&runtime, &Uuid::new_v4().to_string());
            merger.node = "merge:task".into();
            merger.worktree = workspace.to_string_lossy().into_owned();
            runtime
                .emit(EventKind::MergerStarted { execution: merger })
                .unwrap();
        }
        assert!(runtime.active());
        // The ordinary entry may retain the workspace without queueing. A
        // persisted/recovered task must independently check all writer kinds.
        let _ = runtime.defer_cleanup_worktrees();
        assert!(workspace.join("nested/dependencies/file").is_file());
        let manifest =
            cleanup::manifest(&runtime.root, &runtime.store, &runtime.state, false).unwrap();
        runtime
            .store
            .enqueue_cleanup(&runtime.state.run_id, &manifest)
            .unwrap();
        let result = runtime.retry_cleanup_deferred(&runtime.state.run_id);
        assert!(
            result.is_err(),
            "cleanup retry accepted an active non-node writer: result_process={result_process}"
        );
        assert!(workspace.join("nested/dependencies/file").is_file());
        assert!(runtime.store.detached_workspaces().unwrap().is_empty());
    }
}

fn graph() -> Graph {
    Graph {
        original_goal: "cleanup".into(),
        nodes: vec![Node {
            id: "task".into(),
            task: "test".into(),
        }],
        edges: vec![],
    }
}

fn execution(runtime: &Runtime, id: &str) -> Execution {
    Execution {
        id: id.into(),
        node: "task".into(),
        revision: 1,
        attempt: 1,
        session_id: id.into(),
        worktree: runtime.state.config.as_ref().unwrap().repository.clone(),
        before: "base".into(),
        workspace_lineage: vec![],
        after: None,
        input: None,
        result: None,
        status: "running".into(),
        output: String::new(),
        output_bytes: 0,
        pid: None,
        started_at: crate::model::now(),
        completed_at: None,
        metrics: None,
    }
}

fn failed_execution(runtime: &mut Runtime, id: &str) {
    runtime
        .emit(EventKind::Started {
            execution: execution(runtime, id),
            message_sequences: None,
            fresh_restart: false,
        })
        .unwrap();
    runtime
        .emit(EventKind::Failed {
            node: "task".into(),
            execution_id: Some(id.into()),
            error: "test".into(),
            output_bytes: 0,
            metrics: None,
        })
        .unwrap();
}

fn directory(path: &std::path::Path) {
    fs::create_dir_all(path.join("nested/dependencies")).unwrap();
    fs::write(path.join("nested/dependencies/file"), "owned").unwrap();
}

#[test]
fn deletion_removes_sessions_mergers_planning_and_planner_sessions_only_for_its_owner() {
    let (_temp, source, mut runtime) = setup();
    let id = runtime.state.run_id.clone();
    let node = Uuid::new_v4().to_string();
    let merger = Uuid::new_v4().to_string();
    failed_execution(&mut runtime, &node);
    runtime
        .emit(EventKind::MergerStarted {
            execution: execution(&runtime, &merger),
        })
        .unwrap();
    runtime
        .emit(EventKind::MergerFailed {
            execution_id: merger.clone(),
            error: "test".into(),
            output_bytes: 0,
            metrics: None,
        })
        .unwrap();
    runtime
        .emit(EventKind::PublicationFailed {
            error: "test".into(),
        })
        .unwrap();
    let mut owned = vec![
        runtime.root.join("sessions").join(&node),
        runtime.root.join("mergers").join(&merger),
        runtime.root.join("planner-sessions").join(&id),
    ];
    for key in ["runId", "revisionRunId"] {
        let planning = runtime
            .root
            .join("planning")
            .join(Uuid::new_v4().to_string());
        directory(&planning);
        fs::write(
            planning.join("request.json"),
            serde_json::json!({key: id}).to_string(),
        )
        .unwrap();
        owned.push(planning);
    }
    let unrelated = runtime
        .root
        .join("sessions")
        .join(Uuid::new_v4().to_string());
    for path in owned.iter().chain([&unrelated]) {
        directory(path);
    }
    runtime.delete_run(&id).unwrap();
    assert!(owned.iter().all(|path| !path.exists()));
    assert!(unrelated.join("nested/dependencies/file").is_file());
    assert_eq!(
        fs::read_to_string(source.join("user.txt")).unwrap(),
        "keep user files"
    );
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
}

#[cfg(feature = "fixture")]
#[test]
fn completed_git_graphs_keep_shared_private_history_until_the_last_conversation_is_deleted() {
    let (_temp, source, mut runtime) = setup();
    crate::workspace::git(&source, &["add", "-A"]).unwrap();
    crate::workspace::git(&source, &["commit", "-q", "-m", "base"]).unwrap();
    let source_head = crate::workspace::snapshot_repository(&source).unwrap();
    let config = runtime.state.config.clone().unwrap();
    let mut ids = Vec::new();
    for _ in 0..2 {
        if !ids.is_empty() {
            runtime.create(graph(), config.clone()).unwrap();
        }
        runtime.set_route("graph").unwrap();
        runtime.approve().unwrap();
        runtime
            .emit(EventKind::PublicationStarted {
                repository: source.to_string_lossy().into(),
                heads: vec![runtime.state.base.clone()],
            })
            .unwrap();
        runtime
            .emit(EventKind::PublicationCompleted {
                head: source_head.clone(),
            })
            .unwrap();
        ids.push(runtime.state.run_id.clone());
    }
    let shadow = crate::workspace::shadow_repo_dir(&source).unwrap();
    let target = Target::Shadow {
        root: crate::workspace::data_root(),
        name: shadow.file_name().unwrap().to_string_lossy().into(),
        source: None,
    };
    assert!(
        runtime.store.shadow_repo_in_use(&shadow).unwrap(),
        "offline GC must retain completed Git Graph history"
    );
    assert!(runtime
        .store
        .cleanup_target_is_shared(&ids[1], &target)
        .unwrap());
    let moved = source.with_extension("moved");
    fs::rename(&source, &moved).unwrap();
    assert!(
        runtime.store.shadow_repo_in_use(&shadow).unwrap(),
        "recorded ownership must survive a missing source binding"
    );
    fs::rename(moved, &source).unwrap();
    runtime.delete_run(&ids[0]).unwrap();
    assert!(
        shadow.is_dir(),
        "deleting one completed conversation must not delete another's source history"
    );
    runtime.delete_run(&ids[1]).unwrap();
    assert!(!shadow.exists());
    assert!(source.join("user.txt").exists());
}

#[test]
fn shared_node_sessions_survive_until_their_last_run_is_deleted() {
    let (_temp, _source, mut runtime) = setup();
    let first = runtime.state.run_id.clone();
    let node = Uuid::new_v4().to_string();
    failed_execution(&mut runtime, &node);
    let session = runtime.root.join("sessions").join(&node);
    directory(&session);
    runtime
        .create(graph(), runtime.state.config.clone().unwrap())
        .unwrap();
    let second = runtime.state.run_id.clone();
    failed_execution(&mut runtime, &node);
    runtime.delete_run(&first).unwrap();
    assert!(session.is_dir());
    runtime.delete_run(&second).unwrap();
    assert!(!session.exists());
}

#[test]
fn plain_folder_shadow_snapshot_is_reclaimed_when_the_project_has_no_other_run() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("plain source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("user.txt"), "keep user files").unwrap();
    let config: Config = serde_json::from_value(
        serde_json::json!({"repository": source, "model":"test", "maxParallel":1}),
    )
    .unwrap();
    let mut runtime = Runtime::open(&temp.path().join("data")).unwrap();
    runtime.create(graph(), config).unwrap();
    let id = runtime.state.run_id.clone();
    let node = Uuid::new_v4().to_string();
    failed_execution(&mut runtime, &node);
    // A failed plain-folder Run keeps its lazily materialized snapshot, so a
    // deleted failed Run must not leak it into the data directory.
    let shadow = crate::workspace::shadow_repo_dir(&source).unwrap();
    assert!(!crate::workspace::materialize_shadow_repo(&source, &[])
        .unwrap()
        .is_empty());
    assert!(shadow.join("objects").is_dir());
    runtime.delete_run(&id).unwrap();
    assert!(
        !shadow.exists(),
        "a deleted failed Run must reclaim its shadow snapshot"
    );
    assert_eq!(
        fs::read_to_string(source.join("user.txt")).unwrap(),
        "keep user files"
    );
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
}

#[test]
fn shared_plain_folder_shadow_snapshot_survives_until_the_last_run_is_deleted() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("plain source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("user.txt"), "keep user files").unwrap();
    let config: Config = serde_json::from_value(
        serde_json::json!({"repository": source, "model":"test", "maxParallel":1}),
    )
    .unwrap();
    let mut runtime = Runtime::open(&temp.path().join("data")).unwrap();
    runtime.create(graph(), config.clone()).unwrap();
    let first = runtime.state.run_id.clone();
    let node = Uuid::new_v4().to_string();
    failed_execution(&mut runtime, &node);
    let shadow = crate::workspace::shadow_repo_dir(&source).unwrap();
    assert!(!crate::workspace::materialize_shadow_repo(&source, &[])
        .unwrap()
        .is_empty());
    runtime.create(graph(), config).unwrap();
    let second = runtime.state.run_id.clone();
    runtime.delete_run(&first).unwrap();
    assert!(
        shadow.exists(),
        "another Conversation still shares this snapshot"
    );
    runtime.delete_run(&second).unwrap();
    assert!(
        !shadow.exists(),
        "the last Conversation reclaims the shared snapshot"
    );
    assert_eq!(
        fs::read_to_string(source.join("user.txt")).unwrap(),
        "keep user files"
    );
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
}

#[test]
fn deleting_a_run_releases_a_snapshot_only_completed_runs_still_record() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("plain source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("user.txt"), "keep user files").unwrap();
    let config: Config = serde_json::from_value(
        serde_json::json!({"repository": source, "model":"test", "maxParallel":1}),
    )
    .unwrap();
    let mut runtime = Runtime::open(&temp.path().join("data")).unwrap();
    runtime.create(graph(), config.clone()).unwrap();
    let completed = runtime.state.run_id.clone();
    let node = Uuid::new_v4().to_string();
    failed_execution(&mut runtime, &node);
    let shadow = crate::workspace::shadow_repo_dir(&source).unwrap();
    assert!(!crate::workspace::materialize_shadow_repo(&source, &[])
        .unwrap()
        .is_empty());
    runtime.create(graph(), config).unwrap();
    let doomed = runtime.state.run_id.clone();
    // A completed Conversation handed its result to the source, so it no longer
    // pins the snapshot: deleting the last unfinished Run releases it even
    // though the completed Run still records the same target.
    let mut finished = runtime.store.load(&completed).unwrap();
    runtime
        .store
        .append(
            &mut finished,
            EventKind::PublicationCompleted {
                head: "deadbeef".into(),
            },
        )
        .unwrap();
    runtime.delete_run(&doomed).unwrap();
    assert!(
        !shadow.exists(),
        "completed Runs must not pin a released snapshot"
    );
    assert_eq!(
        fs::read_to_string(source.join("user.txt")).unwrap(),
        "keep user files"
    );
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
}

#[test]
fn missing_source_cleans_recorded_workspaces_and_preserves_retired_layouts() {
    for moved in [false, true] {
        for operation in ["delete", "clear", "reset"] {
            let (temp, source, mut runtime) = setup();
            let id = runtime.state.run_id.clone();
            let mut owned = Vec::new();
            let mut unrelated = Vec::new();
            for bucket in [".pi-n-worktrees", ".pi-n-workspaces"] {
                let path = temp.path().join(bucket).join(&id);
                let other = temp.path().join(bucket).join(Uuid::new_v4().to_string());
                directory(&path);
                directory(&other);
                if bucket == ".pi-n-worktrees" {
                    owned.push(path);
                } else {
                    unrelated.push(path);
                }
                unrelated.push(other);
            }
            let moved_source = temp.path().join("moved-source");
            if moved {
                fs::rename(&source, &moved_source).unwrap();
            } else {
                fs::remove_dir_all(&source).unwrap();
            }
            match operation {
                "delete" => runtime.delete_run(&id).unwrap(),
                "clear" => runtime.clear_history().unwrap(),
                _ => {
                    runtime.reset_workspace().unwrap();
                }
            }
            assert!(
                owned.iter().all(|path| !path.exists()),
                "{operation}, moved={moved}"
            );
            assert!(unrelated
                .iter()
                .all(|path| path.join("nested/dependencies/file").is_file()));
            if moved {
                assert_eq!(
                    fs::read_to_string(moved_source.join("user.txt")).unwrap(),
                    "keep user files"
                );
            }
            assert!(runtime.store.pending_cleanups().unwrap().is_empty());
        }
    }
}

#[test]
fn unresolved_cleanup_preserves_unregistered_paths_and_remains_queued() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("already-missing-source");
    let runtime = Runtime::open_lazy(&temp.path().join("data")).unwrap();
    let id = Uuid::new_v4().to_string();
    let root = runtime.root.clone();
    let owned: Vec<_> = [".pi-n-worktrees", ".pi-n-workspaces"]
        .iter()
        .map(|bucket| temp.path().join(bucket).join(&id))
        .collect();
    for path in &owned {
        directory(path);
    }
    runtime
        .store
        .delete_run_with_cleanup(
            &id,
            Some(&Manifest {
                unresolved_repository: Some(source.to_string_lossy().into_owned()),
                ..Default::default()
            }),
        )
        .unwrap();
    drop(runtime);
    let runtime = Runtime::open_lazy(&root).unwrap();
    runtime.retry_deleted_cleanups().unwrap();
    assert!(owned.iter().all(|path| path.exists()));
    assert_eq!(runtime.store.pending_cleanups().unwrap().len(), 1);
}

#[test]
fn missing_source_prefers_recorded_physical_parent_over_a_dangling_alias_parent() {
    let (temp, source, mut runtime) = setup();
    let alias_parent = temp.path().join("alias-parent");
    fs::create_dir(&alias_parent).unwrap();
    let alias = alias_parent.join("source-alias");
    crate::path_safety::directory_link(&source, &alias);
    runtime.state.config.as_mut().unwrap().repository = alias.to_string_lossy().into_owned();
    let id = runtime.state.run_id.clone();
    let actual = temp.path().join(".pi-n-worktrees").join(&id);
    let decoy = alias_parent.join(".pi-n-worktrees").join(&id);
    directory(&actual);
    directory(&decoy);
    fs::remove_dir_all(source).unwrap();
    runtime.delete_run(&id).unwrap();
    assert!(!actual.exists());
    assert!(decoy.join("nested/dependencies/file").is_file());
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
}

#[test]
fn missing_source_refuses_redirected_recorded_workspace_roots_before_deletion() {
    let bucket = ".pi-n-worktrees";
    let (temp, source, mut runtime) = setup();
    fs::remove_dir_all(source).unwrap();
    let id = runtime.state.run_id.clone();
    let outside = temp.path().join("outside");
    directory(&outside.join(&id));
    crate::path_safety::directory_link(&outside, &temp.path().join(bucket));
    assert!(runtime.delete_run(&id).unwrap_err().contains("Refusing"));
    assert!(runtime.store.contains_run(&id).unwrap());
    assert!(outside.join(&id).join("nested/dependencies/file").is_file());
}

#[test]
fn physical_workspace_ownership_survives_source_removal_and_restart() {
    let (temp, source, runtime) = setup();
    let id = runtime.state.run_id.clone();
    let root = runtime.root.clone();
    let workspace = temp.path().join(".pi-n-worktrees").join(&id);
    directory(&workspace);
    fs::remove_dir_all(source).unwrap();
    drop(runtime);
    let mut runtime = Runtime::open(&root).unwrap();
    runtime.delete_run(&id).unwrap();
    assert!(!workspace.exists());
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
}

#[test]
fn committed_deletion_keeps_cleanup_on_failure_and_retries_after_restart() {
    let (temp, _source, mut runtime) = setup();
    let id = runtime.state.run_id.clone();
    let root = runtime.root.clone();
    let session_id = Uuid::new_v4().to_string();
    let session = root.join("sessions").join(&session_id);
    directory(&session);
    let manifest = Manifest {
        targets: BTreeSet::from([Target::data("sessions", &session_id)]),
        ..Default::default()
    };
    runtime
        .store
        .delete_run_with_cleanup(&id, Some(&manifest))
        .unwrap();
    fs::remove_dir_all(&session).unwrap();
    let outside = temp.path().join("outside");
    directory(&outside);
    crate::path_safety::directory_link(&outside, &session);
    assert!(runtime.retry_cleanup(&id).unwrap_err().contains("Refusing"));
    let task = runtime.store.cleanup_task(&id).unwrap().unwrap();
    assert_eq!(task.attempts, 1);
    assert!(task.last_error.unwrap().contains("Refusing"));
    assert!(outside.join("nested/dependencies/file").is_file());
    let mut stale = runtime.state.clone();
    assert!(runtime
        .store
        .append(&mut stale, EventKind::Paused { paused: true })
        .unwrap_err()
        .contains("deleted"));
    assert!(runtime
        .store
        .append_batch(
            &mut stale,
            vec![EventKind::Output {
                execution_id: session_id,
                text: "late".into()
            }]
        )
        .unwrap_err()
        .contains("deleted"));
    crate::path_safety::remove_directory_link(&session);
    directory(&session);
    drop(runtime);
    let runtime = Runtime::open_lazy(&root).unwrap();
    runtime.retry_deleted_cleanups().unwrap();
    assert!(!session.exists());
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
}

#[test]
fn failed_completed_run_cleanup_is_durable_and_stale_generations_are_cancelled() {
    let (temp, _source, mut runtime) = setup();
    runtime
        .emit(EventKind::PublicationCompleted {
            head: "published".into(),
        })
        .unwrap();
    let id = runtime.state.run_id.clone();
    let workspace = temp.path().join(".pi-n-worktrees").join(&id);
    directory(&workspace);
    let outside = temp.path().join("outside");
    directory(&outside);
    let root = temp.path().join(".pi-n-worktrees");
    fs::remove_dir_all(&root).unwrap();
    crate::path_safety::directory_link(&outside, &root);
    assert!(runtime.cleanup_worktrees().is_err());
    assert!(runtime
        .store
        .cleanup_task(&id)
        .unwrap()
        .unwrap()
        .last_error
        .is_some());
    assert!(outside.join("nested/dependencies/file").is_file());
    crate::path_safety::remove_directory_link(&root);
    directory(&workspace);
    runtime.retry_cleanup(&id).unwrap();
    assert!(!workspace.exists());
    assert!(runtime.store.completed_workspace_runs().unwrap().is_empty());
    directory(&workspace);
    let manifest = cleanup::manifest(&runtime.root, &runtime.store, &runtime.state, false).unwrap();
    runtime.store.enqueue_cleanup(&id, &manifest).unwrap();
    runtime.emit(EventKind::Paused { paused: true }).unwrap();
    runtime.retry_cleanup(&id).unwrap();
    assert!(
        workspace.is_dir(),
        "a follow-up invalidates old cleanup authorization"
    );
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
}

#[test]
fn retired_partitioner_directories_are_preserved() {
    let (_temp, _source, mut runtime) = setup();
    let path = runtime
        .root
        .join("partition-workers")
        .join(Uuid::new_v4().to_string());
    directory(&path);
    fs::write(
        path.join(".pi-n-partition-worker.json"),
        r#"{"kind":"pi-n-partition-worker","version":1}"#,
    )
    .unwrap();
    let id = runtime.state.run_id.clone();
    runtime.delete_run(&id).unwrap();
    runtime.retry_deleted_cleanups().unwrap();
    assert!(path.join("nested/dependencies/file").is_file());
}

#[test]
fn forged_planner_marker_cannot_authorize_another_checkout() {
    let (temp, _source, mut runtime) = setup();
    let id = runtime.state.run_id.clone();
    let attempt = Uuid::new_v4().to_string();
    let outside = temp
        .path()
        .join(".pi-n-workspaces")
        .join(Uuid::new_v4().to_string())
        .join(Uuid::new_v4().to_string());
    directory(&outside);
    let planning = runtime.root.join("planning").join(attempt);
    directory(&planning);
    fs::write(
        planning.join("request.json"),
        serde_json::json!({"runId":id}).to_string(),
    )
    .unwrap();
    fs::write(
        planning.join("planner-workspace"),
        outside.to_string_lossy().as_bytes(),
    )
    .unwrap();
    runtime.delete_run(&id).unwrap();
    assert!(!planning.exists());
    assert!(outside.join("nested/dependencies/file").is_file());
}

#[test]
fn deletion_and_cleanup_manifest_rollback_together_on_database_failure() {
    let (temp, _source, mut runtime) = setup();
    let id = runtime.state.run_id.clone();
    let workspace = temp.path().join(".pi-n-worktrees").join(&id);
    directory(&workspace);
    let db = rusqlite::Connection::open(runtime.root.join("events.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER deny_deletion BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
    assert!(runtime
        .delete_run(&id)
        .unwrap_err()
        .contains("test failure"));
    assert!(workspace.is_dir());
    assert!(runtime.store.contains_run(&id).unwrap());
    assert!(!runtime.store.run_was_deleted(&id).unwrap());
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
}

#[test]
fn workspace_batch_deletion_is_atomic_and_cascades_database_and_owned_files() {
    let (temp, source, mut runtime) = setup();
    let mut ids = Vec::new();
    let mut directories = Vec::new();
    for index in 0..2 {
        if index > 0 {
            runtime
                .create(graph(), runtime.state.config.clone().unwrap())
                .unwrap();
        }
        let id = runtime.state.run_id.clone();
        let node = Uuid::new_v4().to_string();
        failed_execution(&mut runtime, &node);
        runtime
            .emit(EventKind::Output {
                execution_id: node.clone(),
                text: "retained history\n".into(),
            })
            .unwrap();
        let session = runtime.root.join("sessions").join(node);
        let workspace = temp.path().join(".pi-n-worktrees").join(&id);
        runtime
            .store
            .remember_cleanup_targets(
                &id,
                &BTreeSet::from([Target::Workspace {
                    parent: temp.path().canonicalize().unwrap(),
                    bucket: ".pi-n-worktrees".into(),
                    owner: id.clone(),
                    checkout: None,
                }]),
            )
            .unwrap();
        directory(&session);
        directory(&workspace);
        directories.extend([session, workspace]);
        ids.push(id);
    }
    let db = rusqlite::Connection::open(runtime.root.join("events.sqlite")).unwrap();
    db.execute_batch(&format!("CREATE TRIGGER deny_second BEFORE DELETE ON events WHEN OLD.run_id='{}' BEGIN SELECT RAISE(ABORT,'batch failure'); END;", ids[1])).unwrap();
    assert!(runtime
        .delete_runs(&ids)
        .unwrap_err()
        .contains("batch failure"));
    for id in &ids {
        assert!(runtime.store.contains_run(id).unwrap());
        assert!(!runtime.store.run_was_deleted(id).unwrap());
    }
    assert!(directories.iter().all(|path| path.is_dir()));
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
    assert_eq!(runtime.state.run_id, ids[1]);
    db.execute_batch("DROP TRIGGER deny_second").unwrap();
    runtime.delete_runs(&ids).unwrap();
    for id in &ids {
        for table in [
            "events",
            "checkpoints",
            "execution_logs",
            "run_owned_directories",
            "cleanup_tasks",
            "workspace_cleanup_done",
        ] {
            let rows: i64 = db
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE run_id=?1"),
                    [id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(rows, 0, "{table} retained a deleted conversation");
        }
        assert!(
            runtime.store.run_was_deleted(id).unwrap(),
            "stale-writer tombstones must survive"
        );
    }
    assert!(runtime.state.run_id.is_empty());
    assert!(directories.iter().all(|path| !path.exists()));
    assert_eq!(
        fs::read_to_string(source.join("user.txt")).unwrap(),
        "keep user files"
    );
}

#[test]
fn workspace_batch_rejects_active_conversations_before_deleting_any_history() {
    let (_temp, _source, mut runtime) = setup();
    let first = runtime.state.run_id.clone();
    runtime
        .create(graph(), runtime.state.config.clone().unwrap())
        .unwrap();
    let second = runtime.state.run_id.clone();
    runtime.state.phase = "launching_result".into();
    assert!(runtime
        .delete_runs(&[first.clone(), second.clone()])
        .unwrap_err()
        .contains("running"));
    assert!(runtime.store.contains_run(&first).unwrap());
    assert!(runtime.store.contains_run(&second).unwrap());
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
}

#[cfg(windows)]
#[test]
fn locked_session_files_leave_retryable_cleanup_not_orphaned_ownership() {
    use std::os::windows::fs::OpenOptionsExt;
    let (_temp, _source, mut runtime) = setup();
    let id = runtime.state.run_id.clone();
    let node = Uuid::new_v4().to_string();
    failed_execution(&mut runtime, &node);
    let session = runtime.root.join("sessions").join(&node);
    directory(&session);
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(session.join("nested/dependencies/file"))
        .unwrap();
    runtime.delete_run(&id).unwrap();
    assert!(!runtime.store.contains_run(&id).unwrap());
    assert!(runtime
        .store
        .cleanup_task(&id)
        .unwrap()
        .unwrap()
        .last_error
        .is_some());
    drop(locked);
    runtime.retry_deleted_cleanups().unwrap();
    assert!(!session.exists());
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
}

#[cfg(windows)]
#[test]
fn cleanup_removes_read_blocked_windows_junctions() {
    // Reproduces the `INetCache\Content.IE5` artifact: a junction carrying an
    // explicit `Everyone:(DENY)(RD)` ACE. `fs::remove_dir_all` cannot list it
    // and fails with access denied (os error 5), so the cleanup was retried
    // forever. The owned tree must still be removed without touching the
    // junction target.
    let (temp, _source, mut runtime) = setup();
    let id = runtime.state.run_id.clone();
    let workspace = temp.path().join(".pi-n-worktrees").join(&id);
    let target = temp.path().join("outside-target");
    directory(&workspace);
    directory(&target);
    let link = workspace.join("Content.IE5");
    crate::path_safety::directory_link(&target, &link);
    let output = std::process::Command::new("icacls")
        .arg(&link)
        .arg("/deny")
        .arg("*S-1-1-0:(RD)")
        .output()
        .unwrap();
    assert!(output.status.success(), "could not apply the deny ACE");
    runtime.delete_run(&id).unwrap();
    assert!(!workspace.exists());
    assert!(
        target.join("nested/dependencies/file").is_file(),
        "cleanup must unlink the junction, never recurse into its target"
    );
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
}

#[test]
fn cleanup_unlinks_directory_links_without_following_their_targets() {
    let (temp, _source, mut runtime) = setup();
    let id = runtime.state.run_id.clone();
    let workspace = temp.path().join(".pi-n-worktrees").join(&id);
    let outside = temp.path().join("outside-target");
    directory(&outside);
    directory(&workspace);
    crate::path_safety::directory_link(&outside, &workspace.join("link"));
    runtime.delete_run(&id).unwrap();
    assert!(!workspace.exists());
    assert!(
        outside.join("nested/dependencies/file").is_file(),
        "cleanup must unlink a directory link, never recurse into its target"
    );
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
}

#[cfg(windows)]
#[test]
fn cleanup_reports_locked_child_and_retries_after_restart() {
    use std::os::windows::fs::OpenOptionsExt;

    let (temp, _source, mut runtime) = setup();
    let id = runtime.state.run_id.clone();
    let root = runtime.root.clone();
    let workspace = temp.path().join(".pi-n-worktrees").join(&id);
    directory(&workspace);
    let file = workspace
        .join("nested/dependencies/file")
        .canonicalize()
        .unwrap();
    let directory = file.parent().unwrap();
    let mut permissions = fs::metadata(directory).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(directory, permissions).unwrap();
    let lock = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&file)
        .unwrap();

    runtime.delete_run(&id).unwrap();
    let task = runtime.store.cleanup_task(&id).unwrap().unwrap();
    let error = task.last_error.unwrap();
    assert!(
        error.contains(&file.to_string_lossy().to_string()),
        "{error}"
    );
    assert!(error.contains("Cannot "), "{error}");
    drop(runtime);

    let runtime = Runtime::open_lazy(&root).unwrap();
    runtime.retry_deleted_cleanups().unwrap();
    assert!(runtime.store.cleanup_task(&id).unwrap().is_some());
    drop(lock);
    runtime.retry_deleted_cleanups().unwrap();
    assert!(!workspace.exists());
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
}

#[cfg(windows)]
#[test]
fn cleanup_removes_readonly_directories_instead_of_retrying_forever() {
    let (temp, _source, mut runtime) = setup();
    let id = runtime.state.run_id.clone();
    let workspace = temp.path().join(".pi-n-worktrees").join(&id);
    directory(&workspace);
    for path in [&workspace, &workspace.join("nested/dependencies")] {
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(path, permissions).unwrap();
    }
    runtime.delete_run(&id).unwrap();
    assert!(!workspace.exists());
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
}

#[cfg(windows)]
#[test]
fn cleanup_removes_readonly_files_instead_of_retrying_forever() {
    let (temp, _source, mut runtime) = setup();
    let id = runtime.state.run_id.clone();
    let workspace = temp.path().join(".pi-n-worktrees").join(&id);
    directory(&workspace);
    let file = workspace.join("nested/dependencies/file");
    let mut permissions = fs::metadata(&file).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&file, permissions).unwrap();
    runtime.delete_run(&id).unwrap();
    assert!(!workspace.exists());
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
}

#[test]
fn workspace_adopted_as_source_is_not_erased_even_after_all_history_is_cleared() {
    let (temp, _source, mut runtime) = setup();
    let original = runtime.state.run_id.clone();
    let workspace = temp.path().join(".pi-n-worktrees").join(&original);
    let adopted = workspace.join("adopted-project");
    directory(&adopted);
    crate::workspace::git(&adopted, &["init", "-q"]).unwrap();
    let mut config = runtime.state.config.clone().unwrap();
    config.repository = adopted.to_string_lossy().into_owned();
    runtime.create(graph(), config).unwrap();
    runtime.clear_history().unwrap();
    assert!(adopted.join("nested/dependencies/file").is_file());
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
}

#[test]
fn intermediate_publication_retires_idle_slots_for_4_to_1_and_keeps_hot_slots_for_8_to_4() {
    // Case 1: 4 -> 1 fan-in. After the 4 parallel nodes deliver via intermediate
    // PublicationCompleted, the next batch is 1 shared-source node so all 4
    // idle private slots (plus their `.pi-n-git` and `.pi-n-state`) are
    // retired asynchronously, while any failed/unreleased slot is preserved.
    let (_temp, source, mut runtime) = setup();
    let fan_in_graph = Graph {
        original_goal: "4-to-1".into(),
        nodes: ["a", "b", "c", "d", "sink"]
            .into_iter()
            .map(|id| Node {
                id: id.into(),
                task: id.into(),
            })
            .collect(),
        edges: ["a", "b", "c", "d"]
            .into_iter()
            .map(|from| crate::model::Edge {
                from: from.into(),
                to: "sink".into(),
                feedback: false,
            })
            .collect(),
    };
    let mut config = runtime.state.config.clone().unwrap();
    config.isolate_parallel_nodes = true;
    config.max_parallel = 4;
    runtime.create(fan_in_graph, config).unwrap();
    runtime.set_route("graph").unwrap();
    runtime.approve().unwrap();

    let run_id = runtime.state.run_id.clone();
    let run_root = crate::workspace::workspaces_parent(&runtime.root)
        .join(".pi-n-worktrees")
        .join(&run_id);
    let mut heads = Vec::new();
    let mut slots = Vec::new();
    for node in ["a", "b", "c", "d"] {
        let exec_id = Uuid::new_v4().to_string();
        let slot = run_root.join(format!("{node}-1"));
        directory(&slot);
        let digest = crate::workspace_state::slot_digest(&slot).unwrap();
        let git_meta = run_root.join(".pi-n-git").join(format!("{digest}.git"));
        let state_meta = run_root.join(".pi-n-state").join(&digest);
        directory(&git_meta);
        directory(&state_meta);
        let mut exec = execution(&runtime, &exec_id);
        exec.node = node.into();
        exec.worktree = slot.to_string_lossy().into_owned();
        runtime
            .emit(EventKind::Started {
                execution: exec,
                message_sequences: None,
                fresh_restart: false,
            })
            .unwrap();
        let head = format!("head-{node}");
        runtime
            .emit(EventKind::Finished {
                execution_id: exec_id,
                head: head.clone(),
                output: String::new(),
                output_bytes: 0,
                metrics: None,
            })
            .unwrap();
        heads.push(head);
        slots.push((slot, git_meta, state_meta));
    }
    runtime
        .emit_outputs(vec![
            EventKind::BatchHandoffRequested {
                recovery_execution_ids: vec![],
            },
            EventKind::PublicationStarted {
                repository: source.to_string_lossy().into_owned(),
                heads,
            },
            EventKind::PublicationCompleted {
                head: "pub-4-to-1".into(),
            },
        ])
        .unwrap();
    assert_eq!(runtime.state.phase, "running");
    // Whole-run cleanup must still wait for `sink`, but idle slots retire now.
    runtime.defer_cleanup_worktrees().unwrap();
    assert!(run_root.is_dir());
    runtime.retire_idle_workspace_slots().unwrap();
    for (slot, git_meta, state_meta) in &slots {
        assert!(!slot.exists(), "idle slot {} should be retired", slot.display());
        assert!(!git_meta.exists(), "slot git metadata should be retired");
        assert!(!state_meta.exists(), "slot state metadata should be retired");
    }
    crate::cleanup::detached::drain(&runtime.root, &runtime.store).unwrap();
    assert!(runtime.store.detached_workspaces().unwrap().is_empty());

    // Case 2: 8 -> 4. After 8 nodes deliver, 4 downstream nodes are immediately
    // ready as a private batch, so 4 hot slots are preserved and 4 excess slots
    // are retired.
    let (_temp2, source2, mut runtime2) = setup();
    let parents: Vec<String> = (1..=8).map(|i| format!("p{i}")).collect();
    let children: Vec<String> = (1..=4).map(|i| format!("c{i}")).collect();
    let mut nodes: Vec<Node> = parents
        .iter()
        .chain(&children)
        .map(|id| Node {
            id: id.clone(),
            task: id.clone(),
        })
        .collect();
    let mut edges = Vec::new();
    for (idx, p) in parents.iter().enumerate() {
        edges.push(crate::model::Edge {
            from: p.clone(),
            to: children[idx % 4].clone(),
            feedback: false,
        });
    }
    let mut config2 = runtime2.state.config.clone().unwrap();
    config2.isolate_parallel_nodes = true;
    config2.max_parallel = 4;
    runtime2
        .create(
            Graph {
                original_goal: "8-to-4".into(),
                nodes: std::mem::take(&mut nodes),
                edges,
            },
            config2,
        )
        .unwrap();
    runtime2.set_route("graph").unwrap();
    runtime2.approve().unwrap();
    let run_id2 = runtime2.state.run_id.clone();
    let run_root2 = crate::workspace::workspaces_parent(&runtime2.root)
        .join(".pi-n-worktrees")
        .join(&run_id2);
    let mut heads2 = Vec::new();
    let mut slot_paths2 = Vec::new();
    for node in &parents {
        let exec_id = Uuid::new_v4().to_string();
        let slot = run_root2.join(format!("{node}-1"));
        directory(&slot);
        let mut exec = execution(&runtime2, &exec_id);
        exec.node = node.clone();
        exec.worktree = slot.to_string_lossy().into_owned();
        runtime2
            .emit(EventKind::Started {
                execution: exec,
                message_sequences: None,
                fresh_restart: false,
            })
            .unwrap();
        let head = format!("head-{node}");
        runtime2
            .emit(EventKind::Finished {
                execution_id: exec_id,
                head: head.clone(),
                output: String::new(),
                output_bytes: 0,
                metrics: None,
            })
            .unwrap();
        heads2.push(head);
        slot_paths2.push(slot);
    }
    runtime2
        .emit_outputs(vec![
            EventKind::BatchHandoffRequested {
                recovery_execution_ids: vec![],
            },
            EventKind::PublicationStarted {
                repository: source2.to_string_lossy().into_owned(),
                heads: heads2,
            },
            EventKind::PublicationCompleted {
                head: "pub-8-to-4".into(),
            },
        ])
        .unwrap();
    runtime2.retire_idle_workspace_slots().unwrap();
    let surviving = slot_paths2.iter().filter(|slot| slot.is_dir()).count();
    assert_eq!(surviving, 4, "8 -> 4 should retain 4 hot slots and retire 4 excess slots");
    assert_eq!(runtime2.store.detached_workspaces().unwrap().len(), 4);
    crate::cleanup::detached::drain(&runtime2.root, &runtime2.store).unwrap();
    assert!(runtime2.store.detached_workspaces().unwrap().is_empty());
}

#[test]
fn prune_shadow_unreachable_cleans_stale_cache_refs_and_dead_views_while_keeping_live_history() {
    let (_temp, source, runtime) = setup();
    crate::workspace::git(&source, &["init", "-q"]).unwrap();
    crate::workspace::git(&source, &["config", "user.name", "Pi^n"]).unwrap();
    crate::workspace::git(&source, &["config", "user.email", "pi-n@example.com"]).unwrap();
    fs::write(source.join("main.txt"), "v1").unwrap();
    crate::workspace::git(&source, &["add", "main.txt"]).unwrap();
    crate::workspace::git(&source, &["commit", "-q", "-m", "v1"]).unwrap();

    let live_head = crate::workspace::materialize_shadow_repo(&source, &[]).unwrap();
    let shadow = crate::workspace::shadow_repo_dir(&source).unwrap();
    let shadow_text = shadow.to_str().unwrap();

    // Create a second commit only referenced by a stale cache ref.
    fs::write(source.join("main.txt"), "v2").unwrap();
    let stale_head = crate::workspace::materialize_shadow_repo(&source, &[]).unwrap();
    assert_ne!(live_head, stale_head);

    let run_id = runtime.state.run_id.clone();
    crate::workspace::git(
        &shadow,
        &[
            "--git-dir",
            shadow_text,
            "update-ref",
            &format!("refs/pi-n/runs/{run_id}/nodes/a"),
            &live_head,
        ],
    )
    .unwrap();
    crate::workspace::git(
        &shadow,
        &[
            "--git-dir",
            shadow_text,
            "update-ref",
            "refs/pi-n/inputs/stale-cache",
            &stale_head,
        ],
    )
    .unwrap();
    // Point HEAD back to live_head so stale_head is only kept by the cache ref.
    crate::workspace::git(
        &shadow,
        &["--git-dir", shadow_text, "update-ref", "HEAD", &live_head],
    )
    .unwrap();
    let dead_view = shadow.join("agent-views").join(&stale_head);
    fs::create_dir_all(&dead_view).unwrap();
    fs::write(dead_view.join("view.json"), "{}").unwrap();
    let live_view = shadow.join("agent-views").join(&live_head);
    fs::create_dir_all(&live_view).unwrap();
    fs::write(live_view.join("view.json"), "{}").unwrap();

    let protected = BTreeSet::from([live_head.clone()]);
    crate::workspace::prune_shadow_unreachable(&shadow, &protected).unwrap();

    // Live run ref, protected commit and live view remain intact.
    let kept = crate::workspace::git(
        &shadow,
        &[
            "--git-dir",
            shadow_text,
            "rev-parse",
            &format!("refs/pi-n/runs/{run_id}/nodes/a"),
        ],
    )
    .unwrap();
    assert_eq!(kept, live_head);
    assert!(live_view.is_dir());

    // Stale cache ref and dead view are reclaimed.
    assert!(crate::workspace::git(
        &shadow,
        &[
            "--git-dir",
            shadow_text,
            "rev-parse",
            "--verify",
            "refs/pi-n/inputs/stale-cache",
        ],
    )
    .is_err());
    assert!(!dead_view.exists());
}

#[test]
fn prune_shadow_unreachable_with_views_reclaims_completed_run_views_while_keeping_commits() {
    let (_temp, source, mut runtime) = setup();
    crate::workspace::git(&source, &["init", "-q"]).unwrap();
    crate::workspace::git(&source, &["config", "user.name", "Pi^n"]).unwrap();
    crate::workspace::git(&source, &["config", "user.email", "pi-n@example.com"]).unwrap();
    fs::write(source.join("main.txt"), "v1").unwrap();
    crate::workspace::git(&source, &["add", "main.txt"]).unwrap();
    crate::workspace::git(&source, &["commit", "-q", "-m", "v1"]).unwrap();

    let completed_head = crate::workspace::materialize_shadow_repo(&source, &[]).unwrap();
    fs::write(source.join("main.txt"), "v2").unwrap();
    let latest_head = crate::workspace::materialize_shadow_repo(&source, &[]).unwrap();
    assert_ne!(completed_head, latest_head);

    // Mark the current Run completed referencing `completed_head`.
    runtime.state.phase = "completed".into();
    runtime.state.base = completed_head.clone();
    runtime
        .emit(EventKind::PublicationCompleted {
            head: completed_head.clone(),
        })
        .unwrap();

    let shadow = crate::workspace::shadow_repo_dir(&source).unwrap();
    let shadow_text = shadow.to_str().unwrap();
    let completed_view = shadow.join("agent-views").join(&completed_head);
    let latest_view = shadow.join("agent-views").join(&latest_head);
    assert!(completed_view.is_dir());
    assert!(latest_view.is_dir());

    let reader = crate::store::Store::open_reader(&runtime.root.join("events.sqlite")).unwrap();
    let (protected, retained_views) =
        crate::cleanup::shadow_retention_for_repository(&reader, "", Some(&source)).unwrap();
    assert!(protected.contains(&completed_head));
    assert!(!retained_views.contains(&completed_head));

    crate::workspace::prune_shadow_unreachable_for_source_with_views(
        &shadow,
        Some(&source),
        &protected,
        Some(&retained_views),
    )
    .unwrap();

    // Historical Git commit remains reachable for diffs, while its bulky
    // `agent-views` directory is reclaimed; shadow HEAD view stays warm.
    assert!(crate::workspace::git(
        &shadow,
        &[
            "--git-dir",
            shadow_text,
            "cat-file",
            "-e",
            &format!("{completed_head}^{{commit}}"),
        ],
    )
    .is_ok());
    assert!(!completed_view.exists());
    assert!(latest_view.is_dir());
}

#[test]
fn periodic_gc_and_run_deletion_prune_completed_run_agent_views_while_keeping_active_views() {
    let (_temp, source, mut runtime) = setup();
    crate::workspace::git(&source, &["init", "-q"]).unwrap();
    crate::workspace::git(&source, &["config", "user.name", "Pi^n"]).unwrap();
    crate::workspace::git(&source, &["config", "user.email", "pi-n@example.com"]).unwrap();
    fs::write(source.join("main.txt"), "v1").unwrap();
    crate::workspace::git(&source, &["add", "main.txt"]).unwrap();
    crate::workspace::git(&source, &["commit", "-q", "-m", "v1"]).unwrap();

    let completed_head = crate::workspace::materialize_shadow_repo(&source, &[]).unwrap();
    fs::write(source.join("main.txt"), "v2").unwrap();
    let active_head = crate::workspace::materialize_shadow_repo(&source, &[]).unwrap();
    fs::write(source.join("main.txt"), "v3").unwrap();
    let latest_head = crate::workspace::materialize_shadow_repo(&source, &[]).unwrap();

    // Completed Run references `completed_head`; active Run references `active_head`.
    let root = runtime.root.clone();
    runtime.state.phase = "completed".into();
    runtime.state.base = completed_head.clone();
    runtime
        .emit(EventKind::PublicationCompleted {
            head: completed_head.clone(),
        })
        .unwrap();
    drop(runtime);

    let mut active_runtime = crate::runtime::Runtime::open(&root).unwrap();
    active_runtime.state.run_id = Uuid::new_v4().to_string();
    active_runtime
        .emit(EventKind::Created {
            graph: graph(),
            config: serde_json::from_value(serde_json::json!({
                "repository": source, "model": "test", "maxParallel": 1
            }))
            .unwrap(),
            planning_id: None,
            planning: None,
        })
        .unwrap();
    active_runtime
        .emit(EventKind::Approved {
            base: active_head.clone(),
        })
        .unwrap();

    let created_shadow = crate::workspace::shadow_repo_dir(&source).unwrap();
    let shadow_dir = root.join("shadow_repos");
    fs::create_dir_all(&shadow_dir).unwrap();
    let shadow = shadow_dir.join(created_shadow.file_name().unwrap());
    fs::rename(&created_shadow, &shadow).unwrap();
    let completed_view = shadow.join("agent-views").join(&completed_head);
    let active_view = shadow.join("agent-views").join(&active_head);
    let latest_view = shadow.join("agent-views").join(&latest_head);
    assert!(completed_view.is_dir());
    assert!(active_view.is_dir());
    assert!(latest_view.is_dir());

    let reader = crate::store::Store::open_reader(&root.join("events.sqlite")).unwrap();
    // Guarded abort skips pruning when Graph/Planner work is active.
    assert_eq!(
        crate::cleanup::prune_retained_shadow_views_with_guard(&root, &reader, || true)
            .unwrap(),
        0
    );
    assert!(completed_view.is_dir());

    // Normal GC sweep reclaims completed Run's view while keeping active Run's view
    // and shadow HEAD view.
    let removed =
        crate::cleanup::prune_retained_shadow_views_with_guard(&root, &reader, || false)
            .unwrap();
    assert_eq!(removed, 1);
    assert!(!completed_view.exists());
    assert!(active_view.is_dir());
    assert!(latest_view.is_dir());

    // Deleting a sibling Run via `prune_shadow_run_refs_for_source_with_views` also
    // prunes recorded completed views without deleting active, HEAD, or in-flight
    // uncommitted views that have not yet been written to SQLite.
    fs::create_dir_all(&completed_view).unwrap();
    fs::write(source.join("main.txt"), "v4-inflight").unwrap();
    let inflight_head = crate::workspace::materialize_shadow_repo(&source, &[]).unwrap();
    fs::write(source.join("main.txt"), "v5-head").unwrap();
    let newest_head = crate::workspace::materialize_shadow_repo(&source, &[]).unwrap();
    let created_shadow_after = crate::workspace::shadow_repo_dir(&source).unwrap();
    let shadow_text = shadow.to_str().unwrap();
    // Copy the uncommitted commit + view into the relocated test shadow and pin
    // it under a live Run ref without recording it in SQLite yet.
    crate::workspace::git(
        &shadow,
        &[
            "--git-dir",
            shadow_text,
            "fetch",
            "-q",
            created_shadow_after.to_str().unwrap(),
            &format!("{inflight_head}:refs/pi-n/runs/{}/node-a", Uuid::new_v4()),
            &format!("{newest_head}:refs/heads/inflight-head"),
        ],
    )
    .unwrap();
    let inflight_view = shadow.join("agent-views").join(&inflight_head);
    fs::create_dir_all(&inflight_view).unwrap();
    let deleted_run = Uuid::new_v4().to_string();
    let (protected, retained_views) =
        crate::cleanup::shadow_retention_for_repository(&reader, &deleted_run, Some(&source))
            .unwrap();
    assert!(!protected.contains(&inflight_head));
    assert!(!retained_views.contains(&inflight_head));
    crate::workspace::prune_shadow_run_refs_for_source_with_views(
        &shadow,
        Some(&source),
        &deleted_run,
        &protected,
        Some(&retained_views),
        true,
    )
    .unwrap();
    assert!(!completed_view.exists());
    assert!(active_view.is_dir());
    assert!(latest_view.is_dir());
    assert!(
        inflight_view.is_dir(),
        "uncommitted in-flight view must survive sibling Run deletion"
    );

    crate::workspace::prune_shadow_unreachable_for_source_with_views(
        &shadow,
        Some(&source),
        &protected,
        Some(&retained_views),
    )
    .unwrap();
    assert!(
        inflight_view.is_dir(),
        "uncommitted in-flight view must survive unreachable pruning"
    );
}

#[test]
fn intermediate_publication_retires_installed_publication_dirs_and_keeps_incomplete_journals() {
    let (_temp, source, mut runtime) = setup();
    let fan_in = Graph {
        original_goal: "pub-cleanup".into(),
        nodes: ["a", "sink"]
            .into_iter()
            .map(|id| Node {
                id: id.into(),
                task: id.into(),
            })
            .collect(),
        edges: vec![crate::model::Edge {
            from: "a".into(),
            to: "sink".into(),
            feedback: false,
        }],
    };
    let mut config = runtime.state.config.clone().unwrap();
    config.isolate_parallel_nodes = true;
    runtime.create(fan_in, config).unwrap();
    runtime.set_route("graph").unwrap();
    runtime.approve().unwrap();

    let run_id = runtime.state.run_id.clone();
    let run_root = crate::workspace::workspaces_parent(&runtime.root)
        .join(".pi-n-worktrees")
        .join(&run_id);

    // 1. Installed publication workspace + journal + view -> should be retired.
    let done_pub = run_root.join("publication-files-0123456789abcdef");
    let done_journal = run_root.join("publication-files-0123456789abcdef.publication");
    let done_view = run_root.join("publication-view-fedcba9876543210");
    directory(&done_pub);
    fs::create_dir_all(done_journal.join("00000000")).unwrap();
    fs::write(done_journal.join("00000000/prepared.json"), "{}").unwrap();
    fs::write(done_journal.join("00000000/installed"), "pub-1").unwrap();
    directory(&done_view);
    let done_digest = crate::workspace_state::slot_digest(&done_pub).unwrap();
    let done_git = run_root.join(".pi-n-git").join(format!("{done_digest}.git"));
    let done_state = run_root.join(".pi-n-state").join(&done_digest);
    directory(&done_git);
    directory(&done_state);

    // 2. Uninstalled publication journal -> must NOT be retired.
    let pending_pub = run_root.join("publication-files-aaaaaaaaaaaaaaaa");
    let pending_journal = run_root.join("publication-files-aaaaaaaaaaaaaaaa.publication");
    directory(&pending_pub);
    fs::create_dir_all(pending_journal.join("00000000")).unwrap();
    fs::write(pending_journal.join("00000000/prepared.json"), "{}").unwrap();

    // 3. Publication workspace owned by a failed merger -> must NOT be retired.
    let failed_pub = run_root.join("publication-files-bbbbbbbbbbbbbbbb");
    directory(&failed_pub);
    let mut merger = execution(&runtime, &Uuid::new_v4().to_string());
    merger.node = "merge:publication".into();
    merger.worktree = failed_pub.to_string_lossy().into_owned();
    let merger_id = merger.id.clone();
    runtime
        .emit(EventKind::MergerStarted { execution: merger })
        .unwrap();
    runtime
        .emit(EventKind::MergerFailed {
            execution_id: merger_id,
            error: "conflict".into(),
            output_bytes: 0,
            metrics: None,
        })
        .unwrap();

    // Finish `a` and complete an intermediate publication.
    let exec_id = Uuid::new_v4().to_string();
    let mut exec = execution(&runtime, &exec_id);
    exec.node = "a".into();
    exec.worktree = source.to_string_lossy().into_owned();
    runtime
        .emit(EventKind::Started {
            execution: exec,
            message_sequences: None,
            fresh_restart: false,
        })
        .unwrap();
    runtime
        .emit(EventKind::Finished {
            execution_id: exec_id,
            head: "head-a".into(),
            output: String::new(),
            output_bytes: 0,
            metrics: None,
        })
        .unwrap();
    runtime
        .emit_outputs(vec![
            EventKind::BatchHandoffRequested {
                recovery_execution_ids: vec![],
            },
            EventKind::PublicationStarted {
                repository: source.to_string_lossy().into_owned(),
                heads: vec!["head-a".into()],
            },
            EventKind::PublicationCompleted {
                head: "pub-1".into(),
            },
        ])
        .unwrap();

    runtime.retire_idle_workspace_slots().unwrap();
    assert!(!done_pub.exists());
    assert!(!done_journal.exists());
    assert!(!done_view.exists());
    assert!(!done_git.exists());
    assert!(!done_state.exists());
    assert!(
        !run_root.join(".pi-n-git").exists(),
        "empty .pi-n-git shell should be removed"
    );
    assert!(
        !run_root.join(".pi-n-state").exists(),
        "empty .pi-n-state shell should be removed"
    );
    assert!(pending_pub.is_dir(), "uninstalled publication workspace must stay");
    assert!(pending_journal.is_dir(), "uninstalled journal must stay");
    assert!(failed_pub.is_dir(), "failed merger workspace must stay");
    crate::cleanup::detached::drain(&runtime.root, &runtime.store).unwrap();
    assert!(runtime.store.detached_workspaces().unwrap().is_empty());
}

#[test]
fn manual_graph_revision_shrinks_excess_idle_slots() {
    let (_temp, source, mut runtime) = setup();
    let initial = Graph {
        original_goal: "shrink".into(),
        nodes: ["p1", "p2", "p3", "p4", "c1", "c2", "c3", "c4"]
            .into_iter()
            .map(|id| Node {
                id: id.into(),
                task: id.into(),
            })
            .collect(),
        edges: [("p1", "c1"), ("p2", "c2"), ("p3", "c3"), ("p4", "c4")]
            .into_iter()
            .map(|(from, to)| crate::model::Edge {
                from: from.into(),
                to: to.into(),
                feedback: false,
            })
            .collect(),
    };
    let mut config = runtime.state.config.clone().unwrap();
    config.isolate_parallel_nodes = true;
    config.max_parallel = 4;
    runtime.create(initial, config).unwrap();
    runtime.set_route("graph").unwrap();
    runtime.approve().unwrap();

    let run_id = runtime.state.run_id.clone();
    let run_root = crate::workspace::workspaces_parent(&runtime.root)
        .join(".pi-n-worktrees")
        .join(&run_id);
    let mut heads = Vec::new();
    let mut slots = Vec::new();
    for node in ["p1", "p2", "p3", "p4"] {
        let exec_id = Uuid::new_v4().to_string();
        let slot = run_root.join(format!("{node}-1"));
        directory(&slot);
        let mut exec = execution(&runtime, &exec_id);
        exec.node = node.into();
        exec.worktree = slot.to_string_lossy().into_owned();
        runtime
            .emit(EventKind::Started {
                execution: exec,
                message_sequences: None,
                fresh_restart: false,
            })
            .unwrap();
        let head = format!("head-{node}");
        runtime
            .emit(EventKind::Finished {
                execution_id: exec_id,
                head: head.clone(),
                output: String::new(),
                output_bytes: 0,
                metrics: None,
            })
            .unwrap();
        heads.push(head);
        slots.push(slot);
    }
    runtime
        .emit_outputs(vec![
            EventKind::BatchHandoffRequested {
                recovery_execution_ids: vec![],
            },
            EventKind::PublicationStarted {
                repository: source.to_string_lossy().into_owned(),
                heads,
            },
            EventKind::PublicationCompleted {
                head: "pub-1".into(),
            },
        ])
        .unwrap();
    // With 4 ready children (c1..c4), all 4 slots are kept hot.
    runtime.retire_idle_workspace_slots().unwrap();
    assert_eq!(slots.iter().filter(|s| s.is_dir()).count(), 4);

    // Manually revise the graph down to a single remaining child `c1`.
    let narrowed = Graph {
        original_goal: "shrink".into(),
        nodes: ["p1", "p2", "p3", "p4", "c1"]
            .into_iter()
            .map(|id| Node {
                id: id.into(),
                task: id.into(),
            })
            .collect(),
        edges: ["p1", "p2", "p3", "p4"]
            .into_iter()
            .map(|from| crate::model::Edge {
                from: from.into(),
                to: "c1".into(),
                feedback: false,
            })
            .collect(),
    };
    runtime
        .revise_graph(narrowed, crate::model::PlanningSummary::default())
        .unwrap();
    assert_eq!(
        slots.iter().filter(|s| s.is_dir()).count(),
        0,
        "narrowing next batch from 4 to 1 should retire all 4 idle slots"
    );
    crate::cleanup::detached::drain(&runtime.root, &runtime.store).unwrap();
}

#[test]
fn completed_run_prunes_stale_environment_snapshots_while_keeping_published_result() {
    let (_temp, source, mut runtime) = setup();
    runtime.set_route("graph").unwrap();
    runtime.approve().unwrap();

    let fixture_probe = source.join("fixture-shell");
    fs::write(&fixture_probe, "#!/bin/sh\n").unwrap();
    let policy: crate::environment::EnvironmentConfig = serde_json::from_value(serde_json::json!({
        "mode": "native-workspace",
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "scopes": [".venv"],
        "layout": "fixed",
        "launch": {
            "entry": &fixture_probe,
            "path": [source.to_string_lossy()],
            "shell": &fixture_probe
        },
        "baseline": [&fixture_probe],
        "discovery": true,
        "bestEffort": true
    }))
    .unwrap();
    runtime
        .emit(EventKind::EnvironmentPolicyResolved {
            environment: Some(policy.clone()),
            reason: "test".into(),
        })
        .unwrap();

    let env_dir = runtime
        .root
        .join("environments")
        .join(&runtime.state.run_id);
    let store =
        crate::environment::Environments::new(&runtime.root, &runtime.state.run_id, &policy)
            .unwrap();
    let work_a = source.parent().unwrap().join("env-work-a");
    fs::create_dir_all(work_a.join(".venv")).unwrap();
    fs::write(work_a.join(".venv/stale.txt"), "historical-input-content").unwrap();
    let files = crate::workspace_files::Files::environment(
        &env_dir.join("files"),
        &policy.scopes,
        &policy.caches,
    )
    .unwrap()
    .with_project_index(false);
    let historical_env_ref = Uuid::new_v4().to_string();
    files
        .capture(&work_a, &historical_env_ref, "head-input", &[])
        .unwrap();
    fs::write(work_a.join(".venv/stale.txt"), "stale-blob-content").unwrap();
    let stale_env_ref = Uuid::new_v4().to_string();
    files
        .capture(&work_a, &stale_env_ref, "head-stale", &[])
        .unwrap();

    fs::write(work_a.join(".venv/stale.txt"), "kept-blob-content").unwrap();
    let kept_env_ref = Uuid::new_v4().to_string();
    files
        .capture(&work_a, &kept_env_ref, "head-kept", &[])
        .unwrap();
    assert_ne!(stale_env_ref, kept_env_ref);

    let launch_ref = store.launch(&policy.launch).unwrap();
    let mut stale_launch = policy.launch.clone();
    stale_launch.variables.insert("UNUSED".into(), "1".into());
    let stale_launch_ref = store.launch(&stale_launch).unwrap();
    assert_ne!(launch_ref, stale_launch_ref);

    let composite = crate::environment::CompositeResult {
        domain: crate::environment::Domain {
            platform: std::env::consts::OS.into(),
            arch: std::env::consts::ARCH.into(),
            baseline: "base".into(),
            policy: "policy".into(),
            contract: "native-workspace-v4".into(),
        },
        code_ref: "head-kept".into(),
        environment_ref: kept_env_ref.clone(),
        launch_ref: launch_ref.clone(),
        resource_refs: vec![],
        layout: Some(work_a.to_string_lossy().into_owned()),
        generation: Uuid::new_v4().to_string(),
        selected_from: vec![],
        inheritance: None,
    };
    let descriptor = crate::environment::ResultDescriptor {
        schema: 2,
        run_id: runtime.state.run_id.clone(),
        result: composite.clone(),
        config: policy.clone(),
        workspace: work_a.to_string_lossy().into_owned(),
        entries: vec![crate::environment::ResultEntry {
            name: "default".into(),
            result: composite,
            workspace: work_a.to_string_lossy().into_owned(),
        }],
        default_entry: Some("default".into()),
    };

    let mut historical_launch = policy.launch.clone();
    historical_launch
        .variables
        .insert("HISTORY".into(), "input".into());
    let historical_launch_ref = store.launch(&historical_launch).unwrap();
    let historical = crate::environment::CompositeResult {
        environment_ref: historical_env_ref.clone(),
        launch_ref: historical_launch_ref.clone(),
        ..descriptor.result.clone()
    };
    let exec_id = Uuid::new_v4().to_string();
    let mut exec = execution(&runtime, &exec_id);
    exec.node = "task".into();
    exec.input = Some(historical);
    runtime
        .emit(EventKind::Started {
            execution: exec,
            message_sequences: None,
            fresh_restart: false,
        })
        .unwrap();
    runtime
        .emit(EventKind::Finished {
            execution_id: exec_id,
            head: "head-kept".into(),
            output: String::new(),
            output_bytes: 0,
            metrics: None,
        })
        .unwrap();
    runtime
        .emit(EventKind::ResultPublished { descriptor })
        .unwrap();
    runtime
        .emit(EventKind::PublicationCompleted {
            head: "head-kept".into(),
        })
        .unwrap();

    // A bad retained launch must prevent E deletion as well as L deletion.
    let launch_path = env_dir.join("launches").join(format!("{launch_ref}.json"));
    let launch_bytes = fs::read(&launch_path).unwrap();
    fs::write(&launch_path, "damaged").unwrap();
    assert_eq!(runtime.prune_stale_environment_snapshots().unwrap(), 0);
    let stale_version = env_dir
        .join("files/versions")
        .join(format!("{stale_env_ref}.json"));
    assert!(stale_version.is_file());
    fs::write(&launch_path, launch_bytes).unwrap();

    // A bad retained E must prevent launch pruning too.
    let kept_version = env_dir
        .join("files/versions")
        .join(format!("{kept_env_ref}.json"));
    let version_bytes = fs::read(&kept_version).unwrap();
    fs::write(&kept_version, "damaged").unwrap();
    assert!(runtime.prune_stale_environment_snapshots().is_err());
    assert!(env_dir
        .join("launches")
        .join(format!("{stale_launch_ref}.json"))
        .is_file());
    assert!(stale_version.is_file());
    fs::write(&kept_version, version_bytes).unwrap();

    // Case A: current published result stays intact; stale version, blob and launch are pruned.
    let removed = runtime.prune_stale_environment_snapshots().unwrap();
    assert!(removed >= 2);
    assert!(env_dir
        .join("files/versions")
        .join(format!("{kept_env_ref}.json"))
        .is_file());
    assert!(!env_dir
        .join("files/versions")
        .join(format!("{stale_env_ref}.json"))
        .exists());
    assert!(env_dir
        .join("launches")
        .join(format!("{launch_ref}.json"))
        .is_file());
    assert!(!env_dir
        .join("launches")
        .join(format!("{stale_launch_ref}.json"))
        .exists());

    assert!(env_dir
        .join("files/versions")
        .join(format!("{historical_env_ref}.json"))
        .is_file());
    assert!(env_dir
        .join("launches")
        .join(format!("{historical_launch_ref}.json"))
        .is_file());
    files
        .validate(std::slice::from_ref(&historical_env_ref))
        .unwrap();
    store.load_launch(&historical_launch_ref).unwrap();

    // Case B: later source work cannot turn recorded input/publication evidence
    // into garbage. Replace the descriptor so the earlier publication survives
    // only in events, then replay the Run before sweeping again.
    runtime
        .emit(EventKind::ExecutionBatchStarted {
            nodes: vec!["task".into()],
            isolated: false,
            resumed: false,
        })
        .unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.phase, "completed");
    let mut newer_descriptor = runtime.state.published_result.clone().unwrap();
    let input = runtime
        .state
        .executions
        .last()
        .unwrap()
        .input
        .clone()
        .unwrap();
    newer_descriptor.result = input.clone();
    for entry in &mut newer_descriptor.entries {
        entry.result = input.clone();
    }
    runtime
        .emit(EventKind::ResultPublished {
            descriptor: newer_descriptor,
        })
        .unwrap();
    runtime.state = runtime.store.load(&runtime.state.run_id).unwrap();
    assert_eq!(runtime.prune_stale_environment_snapshots().unwrap(), 0);
    assert!(env_dir
        .join("files/versions")
        .join(format!("{kept_env_ref}.json"))
        .exists());
    files.validate(std::slice::from_ref(&kept_env_ref)).unwrap();
    files
        .validate(std::slice::from_ref(&historical_env_ref))
        .unwrap();
    store.load_launch(&historical_launch_ref).unwrap();
    store.load_launch(&launch_ref).unwrap();
    let restored = source
        .parent()
        .unwrap()
        .join("historical-environment-restored");
    fs::create_dir_all(&restored).unwrap();
    files
        .materialize(
            &restored,
            std::slice::from_ref(&historical_env_ref),
            None,
            false,
        )
        .unwrap();
    assert_eq!(
        fs::read_to_string(restored.join(".venv/stale.txt")).unwrap(),
        "historical-input-content"
    );
}

#[test]
fn serial_runs_do_not_record_shadow_repo_ownership_when_shadow_exists() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("data");
    let source = temp.path().join("source");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("hello.txt"), "hi\n").unwrap();

    // Ensure a shadow repo already exists for `source` before the serial run starts.
    let _ = crate::workspace::materialize_shadow_repo(&source, &[]).unwrap();
    assert!(crate::workspace::shadow_repo_dir(&source).unwrap().is_dir());

    let mut runtime = Runtime::open(&root).unwrap();
    runtime.state.run_id = Uuid::new_v4().to_string();
    let cfg: Config = serde_json::from_value(serde_json::json!({
        "repository": source.to_string_lossy(),
        "model": "test",
        "maxParallel": 1
    }))
    .unwrap();
    runtime
        .emit(EventKind::PlanningStarted {
            goal: "direct question".into(),
            config: cfg.clone(),
            plan_type: None,
            planning: crate::model::PlanningSummary::default(),
        })
        .unwrap();
    runtime
        .emit(EventKind::Routed {
            plan_type: "serial".into(),
            images: None,
        })
        .unwrap();
    runtime
        .emit(EventKind::Created {
            graph: graph(),
            config: cfg,
            planning_id: None,
            planning: None,
        })
        .unwrap();
    runtime.emit(EventKind::Approved { base: "".into() }).unwrap();

    let owned = runtime
        .store
        .owned_cleanup_targets(&runtime.state.run_id)
        .unwrap();
    assert!(
        !owned
            .iter()
            .any(|target| matches!(target, Target::Shadow { .. })),
        "serial run must not record Target::Shadow ownership: {owned:?}"
    );

    // Batched serial creation (`emit_outputs`) must also observe `Routed("serial")`
    // within the same batch before recording targets for `Created`/`Approved`.
    drop(runtime);
    let mut batched = Runtime::open(&root).unwrap();
    batched.state.run_id = Uuid::new_v4().to_string();
    let batched_cfg: Config = serde_json::from_value(serde_json::json!({
        "repository": source.to_string_lossy(),
        "model": "test",
        "maxParallel": 1
    }))
    .unwrap();
    batched
        .emit_outputs(vec![
            EventKind::PlanningStarted {
                goal: "batched direct".into(),
                config: batched_cfg.clone(),
                plan_type: None,
                planning: crate::model::PlanningSummary::default(),
            },
            EventKind::Routed {
                plan_type: "serial".into(),
                images: None,
            },
            EventKind::Created {
                graph: graph(),
                config: batched_cfg,
                planning_id: None,
                planning: None,
            },
            EventKind::Approved { base: "".into() },
        ])
        .unwrap();
    let batched_owned = batched
        .store
        .owned_cleanup_targets(&batched.state.run_id)
        .unwrap();
    assert!(
        !batched_owned
            .iter()
            .any(|target| matches!(target, Target::Shadow { .. })),
        "batched serial run must not record Target::Shadow ownership: {batched_owned:?}"
    );
}

#[test]
fn orphan_shadow_and_publication_pruning_reclaim_only_unreferenced_settled_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("data");
    let live_source = temp.path().join("live-source");
    let orphan_source = temp.path().join("orphan-source");
    fs::create_dir_all(&live_source).unwrap();
    fs::create_dir_all(&orphan_source).unwrap();
    fs::write(live_source.join("a.txt"), "a\n").unwrap();
    fs::write(orphan_source.join("b.txt"), "b\n").unwrap();

    let mut runtime = Runtime::open(&root).unwrap();
    runtime.state.run_id = Uuid::new_v4().to_string();
    let cfg: Config = serde_json::from_value(serde_json::json!({
        "repository": live_source.to_string_lossy(),
        "model": "test",
        "maxParallel": 1
    }))
    .unwrap();
    runtime
        .emit(EventKind::Routed {
            plan_type: "graph".into(),
            images: None,
        })
        .unwrap();
    runtime
        .emit(EventKind::Created {
            graph: graph(),
            config: cfg,
            planning_id: None,
            planning: None,
        })
        .unwrap();

    // Place both shadow repos inside this test's isolated `root/shadow_repos`.
    // Record `live_shadow` ownership and remove `live_source` so `shadow_repo_in_use`
    // exercises recorded-ownership protection without touching the process-wide data_root().
    let live_shadow_name = crate::workspace::shadow_repo_dir(&live_source)
        .unwrap()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let orphan_shadow_name = crate::workspace::shadow_repo_dir(&orphan_source)
        .unwrap()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let live_shadow = root.join("shadow_repos").join(&live_shadow_name);
    let orphan_shadow = root.join("shadow_repos").join(&orphan_shadow_name);
    fs::create_dir_all(&live_shadow).unwrap();
    fs::create_dir_all(&orphan_shadow).unwrap();
    runtime
        .store
        .remember_cleanup_targets(
            &runtime.state.run_id,
            &BTreeSet::from([Target::Shadow {
                root: root.clone(),
                name: live_shadow_name,
                source: Some(live_source.clone()),
            }]),
        )
        .unwrap();
    fs::remove_dir_all(&live_source).unwrap();

    // Recently created orphan shadow is skipped when min_age > 0, then reclaimed when min_age == 0.
    assert_eq!(
        crate::cleanup::prune_orphaned_shadow_repos(
            &root,
            &runtime.store,
            std::time::Duration::from_secs(3600)
        )
        .unwrap(),
        0
    );
    assert!(orphan_shadow.is_dir());
    assert_eq!(
        crate::cleanup::prune_orphaned_shadow_repos(
            &root,
            &runtime.store,
            std::time::Duration::ZERO
        )
        .unwrap(),
        1
    );
    assert!(!orphan_shadow.exists());
    assert!(live_shadow.is_dir(), "referenced live shadow repo must survive");

    // Set up 3 synthetic UUID roots under workspaces_parent(root)/.pi-n-worktrees:
    // 1) settled standalone publication dir -> MUST be reclaimed
    // 2) unsettled publication dir (missing `installed`) -> MUST survive
    // 3) unknown dir containing non-publication checkout -> MUST survive
    let bucket = crate::workspace::workspaces_parent(&root).join(".pi-n-worktrees");
    let settled_id = Uuid::new_v4().to_string();
    let settled_dir = bucket.join(&settled_id);
    let settled_attempt = settled_dir.join("publication-files-0123456789abcdef.publication/00000000");
    fs::create_dir_all(&settled_attempt).unwrap();
    fs::write(settled_attempt.join("prepared.json"), "{}").unwrap();
    fs::write(settled_attempt.join("installed"), "done").unwrap();
    fs::create_dir_all(settled_dir.join("publication-view-fedcba9876543210")).unwrap();
    fs::create_dir_all(settled_dir.join(".pi-n-state")).unwrap();

    let unsettled_id = Uuid::new_v4().to_string();
    let unsettled_dir = bucket.join(&unsettled_id);
    let unsettled_attempt =
        unsettled_dir.join("publication-files-aaaaaaaaaaaaaaaa.publication/00000000");
    fs::create_dir_all(&unsettled_attempt).unwrap();
    fs::write(unsettled_attempt.join("prepared.json"), "{}").unwrap();

    let foreign_id = Uuid::new_v4().to_string();
    let foreign_dir = bucket.join(&foreign_id);
    fs::create_dir_all(foreign_dir.join("publication-view-1111111111111111")).unwrap();
    fs::create_dir_all(foreign_dir.join("worker")).unwrap();

    assert_eq!(
        crate::cleanup::prune_orphaned_publication_dirs(
            &root,
            &runtime.store,
            std::time::Duration::from_secs(3600)
        )
        .unwrap(),
        0
    );
    assert!(settled_dir.is_dir());

    assert_eq!(
        crate::cleanup::prune_orphaned_publication_dirs(
            &root,
            &runtime.store,
            std::time::Duration::ZERO
        )
        .unwrap(),
        1
    );
    assert!(!settled_dir.exists(), "settled orphan publication dir must be pruned");
    assert!(unsettled_dir.is_dir(), "unsettled publication journal must survive");
    assert!(foreign_dir.is_dir(), "dir with non-publication checkout must survive");
}

#[test]
fn publication_journal_settled_fails_closed_on_non_not_found_errors() {
    let temp = tempfile::tempdir().unwrap();
    // Missing journal directory is genuinely absent -> settled.
    assert!(crate::cleanup::publication_journal_settled(
        &temp.path().join("missing.publication")
    ));

    // A regular file where a journal directory is expected triggers a non-NotFound
    // `read_dir` error (`ENOTDIR`) and must fail closed (`false`).
    let file_path = temp.path().join("not-a-dir.publication");
    fs::write(&file_path, "corrupt").unwrap();
    assert!(!crate::cleanup::publication_journal_settled(&file_path));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let locked = temp.path().join("locked.publication");
        fs::create_dir_all(&locked).unwrap();
        let original = fs::metadata(&locked).unwrap().permissions();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        // Root can still read mode 000 directories; skip assertion only when unreadable check isn't enforced.
        if fs::read_dir(&locked).is_err() {
            assert!(!crate::cleanup::publication_journal_settled(&locked));
        }
        fs::set_permissions(&locked, original).unwrap();
    }
}

#[test]
fn prune_orphaned_shadow_repos_respects_shadow_use_lock_and_abort_guard() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("data");
    fs::create_dir_all(&root).unwrap();
    let store = crate::store::Store::open(&root.join("events.sqlite")).unwrap();

    let orphan_source = temp.path().join("orphan-plain");
    fs::create_dir(&orphan_source).unwrap();
    let orphan_name = crate::workspace::shadow_repo_dir(&orphan_source)
        .unwrap()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let orphan_shadow = root.join("shadow_repos").join(&orphan_name);
    fs::create_dir_all(&orphan_shadow).unwrap();

    // Holding a shared shadow_use_lock read guard prevents background GC from
    // removing the shadow repository while a snapshot/materialization is in progress.
    {
        let shadow_lock = crate::workspace::shadow_use_lock(&orphan_shadow).unwrap();
        let _active_reader = shadow_lock.read().unwrap();
        assert_eq!(
            crate::cleanup::prune_orphaned_shadow_repos_with_guard(
                &root,
                &store,
                std::time::Duration::ZERO,
                || false,
            )
            .unwrap(),
            0
        );
        assert!(orphan_shadow.is_dir());
    }

    // Abort guard stops deletion before removing any candidate.
    assert_eq!(
        crate::cleanup::prune_orphaned_shadow_repos_with_guard(
            &root,
            &store,
            std::time::Duration::ZERO,
            || true,
        )
        .unwrap(),
        0
    );
    assert!(orphan_shadow.is_dir());

    // Once unguarded and unlocked, the idle orphan is reclaimed.
    assert_eq!(
        crate::cleanup::prune_orphaned_shadow_repos_with_guard(
            &root,
            &store,
            std::time::Duration::ZERO,
            || false,
        )
        .unwrap(),
        1
    );
    assert!(!orphan_shadow.exists());
}

#[cfg(unix)]
#[test]
fn shadow_repo_idle_detects_recent_activity_in_runs_published_packed_refs_worktrees_and_objects() {
    let temp = tempfile::tempdir().unwrap();
    let shadow = temp.path().join("shadow");
    let dirs = [
        shadow.clone(),
        shadow.join("refs"),
        shadow.join("refs/heads"),
        shadow.join("refs/pi-n"),
        shadow.join("refs/pi-n/runs"),
        shadow.join("refs/pi-n/runs/run-1"),
        shadow.join("refs/pi-n/published"),
        shadow.join("objects"),
        shadow.join("objects/ab"),
        shadow.join("worktrees"),
        shadow.join("logs"),
    ];
    for dir in &dirs {
        fs::create_dir_all(dir).unwrap();
    }
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(7200);
    let age_all = |root: &std::path::Path| {
        let mut stack = vec![root.to_path_buf()];
        let mut order = Vec::new();
        while let Some(dir) = stack.pop() {
            order.push(dir.clone());
            if let Ok(entries) = fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        stack.push(path);
                    } else if let Ok(file) = fs::OpenOptions::new().write(true).open(&path) {
                        let _ = file.set_modified(old);
                    }
                }
            }
        }
        // Backdate deepest directories first so parent mtime isn't bumped afterward.
        for dir in order.into_iter().rev() {
            if let Ok(file) = fs::File::open(&dir) {
                let _ = file.set_modified(old);
            }
        }
    };

    let min_age = std::time::Duration::from_secs(600);
    age_all(&shadow);
    assert!(crate::cleanup::shadow_repo_idle(&shadow, min_age));

    // Each of these paths must mark the shadow repo as active (not idle).
    let fresh_probes = [
        shadow.join("packed-refs"),
        shadow.join("refs/pi-n/runs/run-1/node-a"),
        shadow.join("refs/pi-n/published/result"),
        shadow.join("worktrees/slot-1"),
        shadow.join("objects/ab/cdef0123456789"),
    ];
    for probe in fresh_probes {
        age_all(&shadow);
        assert!(crate::cleanup::shadow_repo_idle(&shadow, min_age));
        fs::write(&probe, "fresh").unwrap();
        // Reset top-level shadow mtime back to `old` so detection must come
        // from the specific sub-path probe rather than top-level directory mtime.
        if let Ok(file) = fs::File::open(&shadow) {
            let _ = file.set_modified(old);
        }
        assert!(
            !crate::cleanup::shadow_repo_idle(&shadow, min_age),
            "fresh write at {} must mark shadow repo non-idle",
            probe.display()
        );
    }
}
