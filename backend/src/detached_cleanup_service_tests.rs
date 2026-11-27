use super::*;

fn fixture(retire: bool) -> (tempfile::TempDir, PathBuf, PathBuf, Arc<Service>) {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("user.txt"), "keep source").unwrap();
    let mut runtime = Runtime::open_lazy(&temp.path().join("data")).unwrap();
    let config = serde_json::from_value(serde_json::json!({
        "repository": source, "model":"test", "maxParallel":1,
    }))
    .unwrap();
    runtime
        .create(
            Graph {
                original_goal: "cleanup fixture".into(),
                nodes: vec![crate::model::Node {
                    id: "task".into(),
                    task: "task".into(),
                }],
                edges: vec![],
            },
            config,
        )
        .unwrap();
    runtime.set_route("serial").unwrap();
    runtime
        .store
        .remember_cleanup_targets(
            &runtime.state.run_id,
            &std::collections::BTreeSet::from([crate::cleanup::Target::Workspace {
                parent: temp.path().canonicalize().unwrap(),
                bucket: ".pi-n-worktrees".into(),
                owner: runtime.state.run_id.clone(),
                checkout: None,
            }]),
        )
        .unwrap();
    let workspace = temp
        .path()
        .join(".pi-n-worktrees")
        .join(&runtime.state.run_id);
    fs::create_dir_all(&workspace).unwrap();
    fs::write(workspace.join("old.txt"), "retired execution").unwrap();
    if retire {
        runtime.defer_cleanup_worktrees().unwrap();
        fs::create_dir(&workspace).unwrap();
        fs::write(workspace.join("new.txt"), "new execution").unwrap();
    } else {
        let manifest =
            crate::cleanup::manifest(&runtime.root, &runtime.store, &runtime.state, false).unwrap();
        runtime
            .store
            .enqueue_cleanup(&runtime.state.run_id, &manifest)
            .unwrap();
    }
    let root = runtime.root.clone();
    let run_id = runtime.state.run_id.clone();
    let service = Arc::new(Service {
        runtime: Mutex::new(runtime),
        driving: AtomicBool::new(true),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: temp.path().join("unused"),
    });
    remember_run_service(&root, &run_id, service.clone()).unwrap();
    (temp, source, workspace, service)
}

#[test]
fn maintenance_drains_detached_receipts_even_while_the_run_drives_new_work() {
    let (_temp, source, workspace, service) = fixture(true);
    assert_eq!(
        service
            .runtime
            .lock()
            .unwrap()
            .store
            .detached_workspaces()
            .unwrap()
            .len(),
        1
    );
    retry_cleanup_tasks(&service).unwrap();
    assert!(service
        .runtime
        .lock()
        .unwrap()
        .store
        .detached_workspaces()
        .unwrap()
        .is_empty());
    assert_eq!(
        fs::read_to_string(workspace.join("new.txt")).unwrap(),
        "new execution"
    );
    assert_eq!(
        fs::read_to_string(source.join("user.txt")).unwrap(),
        "keep source"
    );
}

#[test]
fn startup_cleanup_keeps_retained_managed_workspaces() {
    let (_temp, source, workspace, service) = fixture(false);
    {
        let mut runtime = service.runtime.lock().unwrap();
        runtime.store.finish_cleanup(&runtime.state.run_id).unwrap();
        let environment = serde_json::from_value(serde_json::json!({
            "mode": "native-workspace", "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH, "scopes": [".env"], "layout": "fixed",
            "launch": {"entry": source.join("fixture-program"), "path": [], "shell": source.join("fixture-shell")},
            "baseline": []
        })).unwrap();
        // Persist policy only: this fixture never launches a native environment.
        runtime
            .emit(EventKind::EnvironmentPolicyResolved {
                environment: Some(environment),
                reason: "retained fixture layout".into(),
            })
            .unwrap();
        runtime
            .emit(EventKind::PublicationCompleted {
                head: String::new(),
            })
            .unwrap();
        runtime.defer_cleanup_worktrees().unwrap();
        assert!(runtime
            .store
            .cleanup_task(&runtime.state.run_id)
            .unwrap()
            .is_none());
        assert!(workspace.join("old.txt").exists());
    }
    service.driving.store(false, Ordering::SeqCst);
    recover_cleanup_tasks(&service).unwrap();
    assert!(
        workspace.join("old.txt").exists(),
        "startup bypassed managed workspace retention"
    );
    {
        let mut runtime = service.runtime.lock().unwrap();
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
        // Retention cancels only opportunistic cleanup, not an explicit delete.
        let run_id = runtime.state.run_id.clone();
        runtime.delete_run(&run_id).unwrap();
    }
    assert!(!workspace.exists());
    assert_eq!(
        fs::read_to_string(source.join("user.txt")).unwrap(),
        "keep source"
    );
}

#[test]
fn maintenance_keeps_unretired_workspace_tasks_while_the_run_is_driving() {
    let (_temp, source, workspace, service) = fixture(false);
    retry_cleanup_tasks(&service).unwrap();
    let runtime = service.runtime.lock().unwrap();
    assert!(runtime
        .store
        .cleanup_task(&runtime.state.run_id)
        .unwrap()
        .is_some());
    assert!(runtime.store.detached_workspaces().unwrap().is_empty());
    assert!(workspace.join("old.txt").is_file());
    assert!(source.join("user.txt").is_file());
}

#[test]
fn automatic_lazy_unbound_run_retires_workspaces_on_completion() {
    let (_temp, source, workspace, service) = fixture(false);
    {
        let mut runtime = service.runtime.lock().unwrap();
        runtime.store.finish_cleanup(&runtime.state.run_id).unwrap();
        let environment: crate::environment::EnvironmentConfig = serde_json::from_value(serde_json::json!({
            "mode": "native-workspace",
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "scopes": [".venv", ".environments", ".agent-home"],
            "layout": "fixed",
            "launch": {
                "entry": source.join("fixture-program"),
                "path": [],
                "shell": source.join("fixture-shell")
            },
            "baseline": [],
            "discovery": true,
            "bestEffort": true
        }))
        .unwrap();
        runtime
            .emit(EventKind::EnvironmentPolicyResolved {
                environment: Some(environment),
                reason: "automatic-lazy unbound".into(),
            })
            .unwrap();
        runtime
            .emit(EventKind::PublicationCompleted {
                head: String::new(),
            })
            .unwrap();
        runtime.defer_cleanup_worktrees().unwrap();
        assert!(!workspace.exists(), "unbound automatic-lazy workspace should retire on completion");
        assert_eq!(runtime.store.detached_workspaces().unwrap().len(), 1);
    }
    service.driving.store(false, Ordering::SeqCst);
    retry_cleanup_tasks(&service).unwrap();
    let runtime = service.runtime.lock().unwrap();
    assert!(runtime.store.detached_workspaces().unwrap().is_empty());
    assert!(source.join("user.txt").is_file());
}

#[test]
fn automatic_lazy_bound_environment_retains_workspaces_until_deleted() {
    let (_temp, source, workspace, service) = fixture(false);
    {
        let mut runtime = service.runtime.lock().unwrap();
        runtime.store.finish_cleanup(&runtime.state.run_id).unwrap();
        let fixture_probe = source.join("fixture-shell");
        fs::write(&fixture_probe, "#!/bin/sh\n").unwrap();
        let mut environment: crate::environment::EnvironmentConfig = serde_json::from_value(serde_json::json!({
            "mode": "native-workspace",
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "scopes": [".venv", ".environments", ".agent-home"],
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
        let store = crate::environment::Environments::new(
            &runtime.root,
            &runtime.state.run_id,
            &environment,
        )
        .unwrap();
        let mut bound_launch = environment.launch.clone();
        let runtime_evidence = serde_json::from_value(serde_json::json!({
            "schema": 1,
            "roots": { "workspace": workspace.to_string_lossy() },
            "files": [{
                "location": "root",
                "root": "workspace",
                "path": ".venv/pyvenv.cfg",
                "blob": "b".repeat(40)
            }]
        }))
        .unwrap();
        bound_launch.environment = Some(crate::environment_discovery::Binding {
            kind: "venv".into(),
            prefix: ".venv".into(),
            root: Some("workspace".into()),
            abi: "a".repeat(40),
            runtime_evidence: Some(runtime_evidence),
        });
        let launch_ref = store.launch(&bound_launch).unwrap();
        environment.launch.environment = None;
        let composite = crate::environment::CompositeResult {
            domain: crate::environment::Domain {
                platform: std::env::consts::OS.into(),
                arch: std::env::consts::ARCH.into(),
                baseline: "base".into(),
                policy: "policy".into(),
                contract: "native-workspace-v4".into(),
            },
            code_ref: "deadbeef".into(),
            environment_ref: "envref".into(),
            launch_ref,
            resource_refs: vec![],
            layout: Some(workspace.to_string_lossy().into_owned()),
            generation: Uuid::new_v4().to_string(),
            selected_from: vec![],
            inheritance: None,
        };
        let descriptor = crate::environment::ResultDescriptor {
            schema: 2,
            run_id: runtime.state.run_id.clone(),
            result: composite.clone(),
            config: environment.clone(),
            workspace: workspace.to_string_lossy().into_owned(),
            entries: vec![crate::environment::ResultEntry {
                name: "default".into(),
                result: composite,
                workspace: workspace.to_string_lossy().into_owned(),
            }],
            default_entry: Some("default".into()),
        };
        runtime
            .emit(EventKind::EnvironmentPolicyResolved {
                environment: Some(environment),
                reason: "automatic-lazy bound".into(),
            })
            .unwrap();
        runtime
            .emit(EventKind::ResultPublished { descriptor })
            .unwrap();
        runtime
            .emit(EventKind::PublicationCompleted {
                head: "deadbeef".into(),
            })
            .unwrap();
        runtime.defer_cleanup_worktrees().unwrap();
        assert!(
            workspace.join("old.txt").is_file(),
            "bound automatic-lazy workspace must be retained"
        );
        assert!(runtime.store.detached_workspaces().unwrap().is_empty());
        let run_id = runtime.state.run_id.clone();
        runtime.delete_run(&run_id).unwrap();
    }
    assert!(!workspace.exists());
    assert!(source.join("user.txt").is_file());
}

#[test]
fn online_deletion_queues_files_and_recovers_cleanup_after_restart() {
    for command in ["delete_run", "clear_history"] {
        let (temp, source, workspace, service) = fixture(false);
        service.driving.store(false, Ordering::SeqCst);
        let (root, run_id) = {
            let mut runtime = service.runtime.lock().unwrap();
            // Exercise Compile ownership rather than the serial fixture route.
            runtime
                .emit(EventKind::Routed {
                    plan_type: "graph".into(),
                    images: None,
                })
                .unwrap();
            (runtime.root.clone(), runtime.state.run_id.clone())
        };
        // A multi-file execution tree must remain untouched by the request.
        for index in 0..64 {
            fs::write(workspace.join(format!("artifact-{index}")), "output").unwrap();
        }
        let body = serde_json::json!({"runId": run_id});
        dispatch(&service, command, body).unwrap();
        assert_eq!(fs::read_dir(&workspace).unwrap().count(), 65);
        assert!(service.runtime.try_lock().unwrap().state.run_id.is_empty());
        assert!(service_for_run(&service, &run_id, false).is_err());
        {
            let store = crate::store::Store::open(&root.join("events.sqlite")).unwrap();
            assert!(store.run_was_deleted(&run_id).unwrap());
            assert!(!store.contains_run(&run_id).unwrap());
            let task = store.cleanup_task(&run_id).unwrap().unwrap();
            assert!(task.manifest.sequence.is_none());
        }
        drop(service);

        // Reopen with no in-memory task state: new work can start before the
        // durable queue is drained, and its files/source must survive cleanup.
        let mut runtime = Runtime::open_lazy(&root).unwrap();
        runtime
            .create(
                Graph {
                    nodes: vec![crate::model::Node {
                        id: "task".into(),
                        task: "new work".into(),
                    }],
                    ..Default::default()
                },
                serde_json::from_value(serde_json::json!({
                    "repository": source, "model": "test", "maxParallel": 1
                }))
                .unwrap(),
            )
            .unwrap();
        let next_id = runtime.state.run_id.clone();
        let next_workspace = temp.path().join(".pi-n-worktrees").join(&next_id);
        fs::create_dir_all(&next_workspace).unwrap();
        fs::write(next_workspace.join("keep.txt"), "new work").unwrap();
        let resumed = Arc::new(Service {
            runtime: Mutex::new(runtime),
            driving: AtomicBool::new(false),
            drive_signal: (Mutex::new(0), Condvar::new()),
            planning: AtomicBool::new(false),
            extension: temp.path().join("unused"),
        });
        remember_service_root(&resumed, &root);
        let history = dispatch(&resumed, "history", serde_json::json!({"runId": next_id})).unwrap();
        assert_eq!(history["runId"], next_id);
        assert_eq!(
            dispatch(&resumed, "snapshot", serde_json::json!({})).unwrap()["runId"],
            next_id
        );
        retry_cleanup_tasks_with_gc(&resumed, false).unwrap();
        assert!(!workspace.exists());
        assert!(next_workspace.join("keep.txt").is_file());
        assert!(source.join("user.txt").is_file());
        assert!(resumed
            .runtime
            .lock()
            .unwrap()
            .store
            .pending_cleanups()
            .unwrap()
            .is_empty());
        invalidate_service_cache(&root, None);
    }
}

#[test]
fn deletion_supersedes_a_previously_selected_workspace_cleanup_task() {
    let (_temp, source, workspace, service) = fixture(false);
    service.driving.store(false, Ordering::SeqCst);
    let (root, run_id, stale) = {
        let runtime = service.runtime.lock().unwrap();
        let id = runtime.state.run_id.clone();
        runtime
            .store
            .remember_cleanup_targets(
                &id,
                &BTreeSet::from([crate::cleanup::Target::data("planner-sessions", &id)]),
            )
            .unwrap();
        (
            runtime.root.clone(),
            id.clone(),
            runtime.store.cleanup_task(&id).unwrap().unwrap(),
        )
    };
    let session = root.join("planner-sessions").join(&run_id);
    fs::create_dir_all(&session).unwrap();
    fs::write(session.join("history.jsonl"), "history").unwrap();
    {
        let runtime = service.runtime.lock().unwrap();
        runtime
            .store
            .fail_cleanup(&run_id, "prior workspace failure")
            .unwrap();
    }
    delete_run(run_id.clone(), &service).unwrap();
    assert!(session.exists());
    // The maintenance worker may have read the workspace-only task before the
    // delete committed. It must use the new manifest, including histories, and
    // start with a clean retry counter rather than stale workspace errors.
    let store = crate::store::Store::open(&root.join("events.sqlite")).unwrap();
    let replacement = store.cleanup_task(&run_id).unwrap().unwrap();
    assert_eq!(replacement.attempts, 0);
    assert!(replacement.last_error.is_none());
    crate::cleanup::attempt(&root, &store, &stale).unwrap();
    assert!(!session.exists());
    assert!(!workspace.exists());
    assert!(store.cleanup_task(&run_id).unwrap().is_none());
    assert!(source.join("user.txt").is_file());
}

#[test]
fn deferred_deletion_hides_pending_planning_history_and_clears_child_state() {
    let (_temp, source, _workspace, service) = fixture(false);
    service.driving.store(false, Ordering::SeqCst);
    let repo = source.to_string_lossy().into_owned();
    let (root, doomed_run) = {
        let runtime = service.runtime.lock().unwrap();
        (runtime.root.clone(), runtime.state.run_id.clone())
    };
    let live_run = Uuid::new_v4().to_string();
    let live_service = service_for_run(&service, &live_run, true).unwrap();
    live_service
        .runtime
        .lock()
        .unwrap()
        .create(
            Graph {
                nodes: vec![crate::model::Node {
                    id: "task".into(),
                    task: "keep".into(),
                }],
                ..Default::default()
            },
            serde_json::from_value(serde_json::json!({
                "repository": source, "model": "test", "maxParallel": 1
            }))
            .unwrap(),
        )
        .unwrap();

    let doomed_plan = Uuid::new_v4().to_string();
    let live_plan = Uuid::new_v4().to_string();
    for (run_id, plan_id, status, error, created_at) in [
        (&doomed_run, &doomed_plan, "running", None, 200u64),
        (&live_run, &live_plan, "failed", Some("live error"), 100u64),
    ] {
        let dir = root.join("planning").join(plan_id);
        fs::create_dir_all(&dir).unwrap();
        let summary = crate::model::PlanningSummary {
            planning_id: plan_id.clone(),
            run_id: Some(run_id.clone()),
            repository: Some(repo.clone()),
            goal: Some("plan goal".into()),
            status: Some(status.into()),
            error: error.map(str::to_string),
            created_at: Some(created_at),
            ..Default::default()
        };
        write_planning_summary(&dir, &summary).unwrap();
        fs::write(
            dir.join("request.json"),
            serde_json::json!({
                "formatVersion": 1,
                "runId": run_id,
                "goal": "plan goal",
                "config": {"repository": source, "model": "test", "maxParallel": 1}
            })
            .to_string(),
        )
        .unwrap();
        fs::write(dir.join("planner.jsonl"), "{\"type\":\"text\"}\n").unwrap();
    }

    let doomed_summary_path = root.join("planning").join(&doomed_plan).join("summary.json");
    let before_bytes = fs::read(&doomed_summary_path).unwrap();

    // Online deletion defers removing planning files, but all Planner history
    // endpoints must immediately hide the tombstoned conversation.
    delete_run(doomed_run.clone(), &service).unwrap();
    assert!(doomed_summary_path.is_file());

    let listed = list_plannings(&service, Some(repo.clone())).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].planning_id, live_plan);
    assert!(get_planning(doomed_plan.clone(), &service).is_err());
    assert!(get_planning_output(
        doomed_plan.clone(),
        "planner".into(),
        0,
        false,
        None,
        None,
        &service,
    )
    .is_err());
    assert_eq!(
        get_planning(live_plan.clone(), &service).unwrap().planning_id,
        live_plan
    );

    // Startup recovery before background cleanup must not rewrite or reimport
    // the tombstoned Run's still-on-disk planning files.
    recover_plannings(&service).unwrap();
    assert_eq!(fs::read(&doomed_summary_path).unwrap(), before_bytes);

    // clear_history must also hide remaining pending planning files and clear
    // cached child services' in-memory snapshots.
    clear_history(&service).unwrap();
    assert!(live_service.runtime.lock().unwrap().state.run_id.is_empty());
    assert!(list_plannings(&service, Some(repo)).unwrap().is_empty());
    assert!(get_planning(live_plan.clone(), &service).is_err());

    retry_cleanup_tasks_with_gc(&service, false).unwrap();
    assert!(!root.join("planning").join(&doomed_plan).exists());
    assert!(!root.join("planning").join(&live_plan).exists());
    invalidate_service_cache(&root, None);
}

#[test]
fn deferred_shadow_cleanup_respects_shadow_use_lock_and_new_compile_run() {
    let (_temp, source, workspace, service) = fixture(false);
    service.driving.store(false, Ordering::SeqCst);
    crate::workspace::materialize_shadow_repo(&source, &[]).unwrap();
    let shadow = crate::workspace::shadow_repo_dir(&source).unwrap();
    assert!(shadow.is_dir());
    let (root, doomed_run) = {
        let mut runtime = service.runtime.lock().unwrap();
        runtime
            .emit(EventKind::Routed {
                plan_type: "graph".into(),
                images: None,
            })
            .unwrap();
        (runtime.root.clone(), runtime.state.run_id.clone())
    };
    delete_run(doomed_run.clone(), &service).unwrap();
    assert!(workspace.exists());
    assert!(shadow.is_dir());

    // An active shadow reader (e.g. a concurrent snapshot) must defer shadow
    // removal rather than letting background cleanup delete it underneath.
    let store = crate::store::Store::open(&root.join("events.sqlite")).unwrap();
    let task = store.cleanup_task(&doomed_run).unwrap().unwrap();
    {
        let shadow_lock = crate::workspace::shadow_use_lock(&shadow).unwrap();
        let _reader = shadow_lock.read().unwrap();
        assert!(crate::cleanup::attempt(&root, &store, &task).is_err());
        assert!(shadow.is_dir());
    }
    assert!(store.cleanup_task(&doomed_run).unwrap().is_some());

    // If a new Compile conversation starts on the same repository before
    // cleanup finishes, retrying cleanup must keep the shared shadow repo.
    let next_run = Uuid::new_v4().to_string();
    let next_service = service_for_run(&service, &next_run, true).unwrap();
    {
        let mut runtime = next_service.runtime.lock().unwrap();
        runtime
            .create(
                Graph {
                    nodes: vec![crate::model::Node {
                        id: "task".into(),
                        task: "new compile".into(),
                    }],
                    ..Default::default()
                },
                serde_json::from_value(serde_json::json!({
                    "repository": source, "model": "test", "maxParallel": 1
                }))
                .unwrap(),
            )
            .unwrap();
        runtime
            .emit(EventKind::Routed {
                plan_type: "graph".into(),
                images: None,
            })
            .unwrap();
    }

    retry_cleanup_tasks_with_gc(&service, false).unwrap();
    assert!(!workspace.exists());
    assert!(shadow.is_dir());
    assert!(store.cleanup_task(&doomed_run).unwrap().is_none());
    assert!(source.join("user.txt").is_file());
    invalidate_service_cache(&root, None);
}
