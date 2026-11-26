use super::*;

#[test]
fn deleting_and_clearing_runs_invalidates_cached_services() {
    let temp = tempfile::TempDir::new().unwrap();
    let runtime = Runtime::open_lazy(temp.path()).unwrap();
    let root = runtime.root.clone();
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": temp.path(), "model":"test", "maxParallel":1
    }))
    .unwrap();
    for id in ["first", "second", "third"] {
        let mut state = Snapshot {
            run_id: id.into(),
            ..Default::default()
        };
        runtime
            .store
            .append(
                &mut state,
                EventKind::Created {
                    graph: Graph::default(),
                    config: config.clone(),
                    planning_id: None,
                    planning: None,
                },
            )
            .unwrap();
    }
    let primary = Arc::new(Service {
        runtime: Mutex::new(runtime),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: temp.path().join("unused"),
    });
    let first = service_for_run(&primary, "first", false).unwrap();
    let same = service_for_run(&primary, "first", false).unwrap();
    assert!(Arc::ptr_eq(&first, &same));
    service_for_run(&primary, "second", false).unwrap();
    service_for_run(&primary, "third", false).unwrap();
    assert!(HOT_SERVICES.get().unwrap().lock().unwrap().len() <= 2);
    delete_run("first".into(), &first).unwrap();
    // External references deliberately keep the stale service alive. Lookup
    // still must consult the DB instead of resurrecting the deleted Run.
    assert!(service_for_run(&primary, "first", false).is_err());
    clear_history(&primary).unwrap();
    assert!(service_for_run(&primary, "second", false).is_err());
    assert!(HOT_SERVICES
        .get()
        .unwrap()
        .lock()
        .unwrap()
        .iter()
        .all(|(path, _, _)| *path != root));
}

#[cfg(not(feature = "fixture"))]
#[test]
fn rejected_run_deletion_preserves_its_parked_services() {
    struct Cleanup(String);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            crate::engine::stop_lingering_for_run(&self.0);
        }
    }

    let (_temp, _source, primary, ids) = workspace_deletion_fixture();
    let target = service_for_run(&primary, &ids[0], false).unwrap();
    let _cleanup = Cleanup(ids[0].clone());
    let tree = crate::engine::park_test_shell(&ids[0], &Uuid::new_v4().to_string());
    target.runtime.lock().unwrap().state.phase = "planning".into();
    assert!(delete_run(ids[0].clone(), &target).is_err());
    assert!(
        tree.has_live_members(),
        "a rejected deletion must preserve the Run's services"
    );
    assert!(target
        .runtime
        .lock()
        .unwrap()
        .store
        .contains_run(&ids[0])
        .unwrap());

    target.runtime.lock().unwrap().state.phase = "draft".into();
    delete_run(ids[0].clone(), &target).unwrap();
    assert!(
        !tree.has_live_members(),
        "committed deletion must stop services"
    );
    let root = primary.runtime.lock().unwrap().root.clone();
    invalidate_service_cache(&root, None);
}

fn workspace_deletion_fixture() -> (tempfile::TempDir, PathBuf, Arc<Service>, Vec<String>) {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("project unicode");
    let other = temp.path().join("project unicode-other");
    fs::create_dir_all(source.join("child")).unwrap();
    fs::create_dir(&other).unwrap();
    fs::write(source.join("user.txt"), "published source").unwrap();
    let runtime = Runtime::open_lazy(&temp.path().join("data")).unwrap();
    let mut ids = Vec::new();
    for repository in [&source, &source, &other] {
        let id = Uuid::new_v4().to_string();
        let mut state = Snapshot {
            run_id: id.clone(),
            ..Default::default()
        };
        let config = serde_json::from_value(serde_json::json!({
            "repository": repository, "model": "test", "maxParallel": 1
        }))
        .unwrap();
        runtime
            .store
            .append(
                &mut state,
                EventKind::Created {
                    graph: Graph::default(),
                    config,
                    planning_id: None,
                    planning: None,
                },
            )
            .unwrap();
        runtime
            .store
            .append(
                &mut state,
                EventKind::Output {
                    execution_id: format!("{id}-output"),
                    text: "retained transcript".into(),
                },
            )
            .unwrap();
        let target = crate::cleanup::Target::data("sessions", &id);
        runtime
            .store
            .remember_cleanup_targets(&id, &BTreeSet::from([target]))
            .unwrap();
        let session = runtime.root.join("sessions").join(&id);
        fs::create_dir_all(&session).unwrap();
        fs::write(session.join("history.jsonl"), "owned conversation").unwrap();
        ids.push(id);
    }
    let primary = Arc::new(Service {
        runtime: Mutex::new(runtime),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: temp.path().join("unused"),
    });
    (temp, source, primary, ids)
}

#[test]
fn workspace_size_limit_applies_only_to_compile_with_isolated_parallel_nodes() {
    let (_temp, source, primary, ids) = workspace_deletion_fixture();
    let repository = source
        .join("child")
        .join("..")
        .to_string_lossy()
        .into_owned();
    let oversized = |path: &std::path::Path| crate::workspace::check_workspace_size(path, 0);

    // Adding/opening a workspace and polling binding status must not enforce
    // or warn on workspace size, because Direct mode does not isolate copies.
    assert!(
        detect_repository(Some(repository.clone()))
            .unwrap()
            .is_some(),
        "directory inspection accepts workspaces regardless of size"
    );
    let status = repository_status(repository.clone()).unwrap();
    assert_eq!(status["valid"], true);
    assert_eq!(status["sizeLimitExceeded"], false);
    assert_eq!(status["missing"], false);
    assert!(status["error"].is_null());

    // Direct mode never scans workspace size, even with isolation enabled.
    let mut isolated_config: Config = serde_json::from_value(serde_json::json!({
        "repository": repository, "model": "mock/model", "maxParallel": 1, "isolateParallelNodes": true
    }))
    .unwrap();
    assert!(validate_run_admission_with_size_check(
        std::path::Path::new(&repository),
        &isolated_config,
        Some("serial"),
        |_| panic!("Direct mode must not scan workspace size"),
    )
    .is_ok());

    // Pre-route Auto mode defers size checking until routing chooses graph.
    assert!(validate_run_admission_with_size_check(
        std::path::Path::new(&repository),
        &isolated_config,
        Some("auto"),
        |_| panic!("Auto mode must not scan workspace size before routing"),
    )
    .is_ok());

    // Compile mode WITH `isolateParallelNodes` enabled enforces the size limit
    // and instructs the user that disabling isolation resolves it.
    let err = validate_run_admission_with_size_check(
        std::path::Path::new(&repository),
        &isolated_config,
        Some("graph"),
        oversized,
    )
    .unwrap_err();
    assert!(err.contains("15GB"));
    assert!(err.contains("并行节点独立工作区"));

    // Compile mode with `isolateParallelNodes` disabled skips size scanning.
    isolated_config.isolate_parallel_nodes = false;
    assert!(validate_run_admission_with_size_check(
        std::path::Path::new(&repository),
        &isolated_config,
        Some("graph"),
        |_| panic!("shared-source Compile mode must not scan workspace size"),
    )
    .is_ok());

    // Manual Graph IR creation and draft edits obey the same isolation gate:
    // creating with isolation off skips scanning, but flipping isolation on
    // while editing that draft enforces the size limit before committing.
    let draft_service = service_for_run(&primary, "draft-size-gate", true).unwrap();
    let draft_graph = crate::model::Graph {
        original_goal: "manual graph".into(),
        nodes: vec![crate::model::Node {
            id: "a".into(),
            task: "work".into(),
        }],
        edges: vec![],
    };
    let created = save_graph_with_size_check(
        draft_graph.clone(),
        isolated_config.clone(),
        None,
        &draft_service,
        |_| panic!("shared-source manual graph must not scan workspace size"),
    )
    .unwrap();
    let mut enabled_config = isolated_config.clone();
    enabled_config.isolate_parallel_nodes = true;
    let draft_err = save_graph_with_size_check(
        draft_graph,
        enabled_config,
        Some(created.run_id),
        &draft_service,
        oversized,
    )
    .unwrap_err();
    assert!(draft_err.contains("15GB"));
    assert!(draft_err.contains("并行节点独立工作区"));

    // Missing bindings still report an explicit error.
    fs::remove_dir_all(&source).unwrap();
    let status = repository_status(repository).unwrap();
    assert_eq!(status["valid"], false);
    assert_eq!(status["missing"], true);
    assert_eq!(status["sizeLimitExceeded"], false);
    let _ = ids;
    let root = primary.runtime.lock().unwrap().root.clone();
    invalidate_service_cache(&root, None);
}

#[test]
fn workspace_deletion_uses_backend_ownership_and_invalidates_every_affected_service() {
    let (_temp, source, primary, ids) = workspace_deletion_fixture();
    let first = service_for_run(&primary, &ids[0], false).unwrap();
    let second = service_for_run(&primary, &ids[1], false).unwrap();
    let unrelated = service_for_run(&primary, &ids[2], false).unwrap();
    unrelated.driving.store(true, Ordering::SeqCst);
    let result = dispatch(
        &primary,
        "delete_workspace",
        serde_json::json!({
            "repository": source.join("child").join(".."),
        }),
    )
    .unwrap();
    let mut expected = ids[..2].to_vec();
    expected.sort();
    assert_eq!(result, serde_json::json!(expected));
    for (id, stale) in ids[..2].iter().zip([first, second]) {
        assert!(service_for_run(&primary, id, false).is_err());
        assert!(stale.runtime.lock().unwrap().state.run_id.is_empty());
        assert!(!primary
            .runtime
            .lock()
            .unwrap()
            .root
            .join("sessions")
            .join(id)
            .exists());
        assert_eq!(
            primary
                .runtime
                .lock()
                .unwrap()
                .store
                .log_bytes(id, &format!("{id}-output"))
                .unwrap(),
            0
        );
    }
    let runtime = primary.runtime.lock().unwrap();
    assert_eq!(runtime.store.runs().unwrap(), vec![ids[2].clone()]);
    assert!(runtime.root.join("sessions").join(&ids[2]).exists());
    assert_eq!(
        runtime
            .store
            .log_bytes(&ids[2], &format!("{}-output", ids[2]))
            .unwrap(),
        "retained transcript".len()
    );
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
    let root = runtime.root.clone();
    drop(runtime);
    assert_eq!(
        fs::read_to_string(source.join("user.txt")).unwrap(),
        "published source"
    );
    assert_eq!(
        dispatch(
            &primary,
            "delete_workspace",
            serde_json::json!({"repository": source})
        )
        .unwrap(),
        serde_json::json!([])
    );
    unrelated.driving.store(false, Ordering::SeqCst);
    invalidate_service_cache(&root, None);
}

#[test]
fn workspace_deletion_rejects_active_runs_without_partially_removing_other_conversations() {
    let (_temp, source, primary, ids) = workspace_deletion_fixture();
    let active = service_for_run(&primary, &ids[1], false).unwrap();
    active.planning.store(true, Ordering::SeqCst);
    assert!(
        delete_workspace(source.to_string_lossy().into_owned(), &primary)
            .unwrap_err()
            .contains("active")
    );
    {
        let runtime = primary.runtime.lock().unwrap();
        for id in &ids {
            assert!(runtime.store.contains_run(id).unwrap());
            assert!(!runtime.store.run_was_deleted(id).unwrap());
            assert!(runtime.root.join("sessions").join(id).is_dir());
        }
        assert!(runtime.store.pending_cleanups().unwrap().is_empty());
    }
    for repository in ["", "  ", "relative-project"] {
        assert!(delete_workspace(repository.into(), &primary).is_err());
    }
    active.planning.store(false, Ordering::SeqCst);
    let root = primary.runtime.lock().unwrap().root.clone();
    invalidate_service_cache(&root, None);
}

#[test]
fn startup_recovers_historical_deleted_owners_without_cleanup_tasks() {
    let (_temp, source, primary, ids) = workspace_deletion_fixture();
    let merger_id = Uuid::new_v4().to_string();
    let root = {
        let runtime = primary.runtime.lock().unwrap();
        let merger = runtime.root.join("mergers").join(&merger_id);
        fs::create_dir_all(&merger).unwrap();
        fs::write(merger.join("output.jsonl"), "orphaned merger history").unwrap();
        runtime
            .store
            .remember_cleanup_targets(
                &ids[0],
                &BTreeSet::from([crate::cleanup::Target::data("mergers", &merger_id)]),
            )
            .unwrap();
        // Reproduce an older deletion that removed SQL history, but left
        // physical ownership behind without a durable filesystem task.
        for id in &ids[..2] {
            runtime.store.delete_run(id).unwrap();
        }
        assert!(runtime.store.pending_cleanups().unwrap().is_empty());
        let owners = runtime.store.orphaned_cleanup_owners().unwrap();
        assert!(ids[..2].iter().all(|id| owners.contains(id)));
        assert!(merger.is_dir());
        runtime.root.clone()
    };
    recover_cleanup_tasks(&primary).unwrap();
    let runtime = primary.runtime.lock().unwrap();
    for id in &ids[..2] {
        assert!(runtime.store.run_was_deleted(id).unwrap());
        assert!(runtime.store.owned_cleanup_targets(id).unwrap().is_empty());
        assert!(!root.join("sessions").join(id).exists());
    }
    assert!(!root.join("mergers").join(merger_id).exists());
    assert!(runtime.store.orphaned_cleanup_owners().unwrap().is_empty());
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
    assert!(runtime.store.contains_run(&ids[2]).unwrap());
    assert!(root.join("sessions").join(&ids[2]).exists());
    assert_eq!(
        fs::read_to_string(source.join("user.txt")).unwrap(),
        "published source"
    );
}
