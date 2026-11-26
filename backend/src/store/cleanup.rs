use super::{store_write_guard, Store};
use crate::cleanup::{Manifest, Target, Task};
use rusqlite::{params, OptionalExtension};
use std::{collections::BTreeSet, path::Path};

impl Store {
    pub(crate) fn ensure_not_deleted(&self, run_id: &str) -> Result<(), String> {
        if self.run_was_deleted(run_id)? {
            return Err("Run was deleted; stale writers cannot recreate it".into());
        }
        Ok(())
    }

    pub fn remember_cleanup_targets(
        &self,
        run_id: &str,
        targets: &BTreeSet<Target>,
    ) -> Result<(), String> {
        let _guard = store_write_guard()?;
        self.ensure_not_deleted(run_id)?;
        let tx = self
            .connection
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        for target in targets {
            let payload = serde_json::to_string(target).map_err(|error| error.to_string())?;
            tx.execute(
                "INSERT OR IGNORE INTO run_owned_directories(run_id,target) VALUES(?1,?2)",
                params![run_id, payload],
            )
            .map_err(|error| error.to_string())?;
        }
        tx.commit().map_err(|error| error.to_string())
    }

    /// Source folders remain user data even after their last conversation is
    /// deleted (including a former private checkout adopted as a project).
    pub(crate) fn remember_cleanup_source(&self, repository: &Path) -> Result<(), String> {
        if !repository.is_absolute() {
            return Ok(());
        }
        let Some(source) = crate::path_identity::actual_path(repository)
            .ok()
            .or_else(|| repository.canonicalize().ok())
        else {
            return Ok(());
        };
        let _guard = store_write_guard()?;
        self.connection
            .execute(
                "INSERT OR IGNORE INTO cleanup_sources(path) VALUES(?1)",
                [source.to_string_lossy().as_ref()],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub(crate) fn backfill_cleanup_sources(&self) -> Result<(), String> {
        let indexed: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM cleanup_state WHERE key='sources_indexed')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if indexed {
            return Ok(());
        }
        let mut statement = self
            .connection
            .prepare(
                r#"SELECT DISTINCT json_extract(payload,'$.config.repository') FROM events
            WHERE kind IN ('created','planning_started','draft_edited')"#,
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, Option<String>>(0))
            .map_err(|error| error.to_string())?;
        for row in rows {
            if let Some(source) = row.map_err(|error| error.to_string())? {
                self.remember_cleanup_source(Path::new(&source))?;
            }
        }
        let _guard = store_write_guard()?;
        self.connection
            .execute(
                "INSERT OR IGNORE INTO cleanup_state(key) VALUES('sources_indexed')",
                [],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub(crate) fn cleanup_sources(&self) -> Result<BTreeSet<std::path::PathBuf>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT path FROM cleanup_sources")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.map(|row| {
            row.map(std::path::PathBuf::from)
                .map_err(|error| error.to_string())
        })
        .collect()
    }

    pub fn owned_cleanup_targets(&self, run_id: &str) -> Result<BTreeSet<Target>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT target FROM run_owned_directories WHERE run_id=?1")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([run_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.map(|row| {
            serde_json::from_str(&row.map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())
        })
        .collect()
    }

    pub fn enqueue_cleanup(&self, run_id: &str, manifest: &Manifest) -> Result<(), String> {
        let _guard = store_write_guard()?;
        self.insert_cleanup(&self.connection, run_id, manifest)
    }

    pub(super) fn insert_cleanup(
        &self,
        db: &rusqlite::Connection,
        run_id: &str,
        manifest: &Manifest,
    ) -> Result<(), String> {
        let payload = serde_json::to_string(manifest).map_err(|error| error.to_string())?;
        db.execute(
            "INSERT INTO cleanup_tasks(run_id,payload,attempts,last_error) VALUES(?1,?2,0,NULL)
            ON CONFLICT(run_id) DO UPDATE SET payload=excluded.payload",
            params![run_id, payload],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub(crate) fn save_detached_workspace(
        &self,
        record: &crate::cleanup::detached::Record,
    ) -> Result<(), String> {
        let payload = serde_json::to_string(record).map_err(|e| e.to_string())?;
        let _guard = store_write_guard()?;
        self.connection
            .execute(
                "INSERT INTO detached_workspaces(id,payload) VALUES(?1,?2)
             ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
                params![record.id, payload],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub(crate) fn detached_workspaces(
        &self,
    ) -> Result<Vec<crate::cleanup::detached::Record>, String> {
        let mut query = self
            .connection
            .prepare("SELECT id,payload FROM detached_workspaces ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows = query
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        rows.map(|row| {
            let (id, payload) = row.map_err(|e| e.to_string())?;
            let record: crate::cleanup::detached::Record =
                serde_json::from_str(&payload).map_err(|e| e.to_string())?;
            if record.id != id {
                return Err("Detached workspace identity mismatch".into());
            }
            Ok(record)
        })
        .collect()
    }

    pub(crate) fn forget_detached_workspace(&self, id: &str) -> Result<(), String> {
        let _guard = store_write_guard()?;
        self.connection
            .execute("DELETE FROM detached_workspaces WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn pending_cleanups(&self) -> Result<Vec<Task>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT run_id,payload,attempts,last_error FROM cleanup_tasks ORDER BY run_id")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, usize>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        rows.map(|row| {
            let (run_id, payload, attempts, last_error) = row.map_err(|error| error.to_string())?;
            let manifest = serde_json::from_str(&payload)
                .map_err(|error| format!("Invalid cleanup manifest for {run_id}: {error}"))?;
            Ok(Task {
                run_id,
                manifest,
                attempts,
                last_error,
            })
        })
        .collect()
    }

    pub fn cleanup_task(&self, run_id: &str) -> Result<Option<Task>, String> {
        let row = self
            .connection
            .query_row(
                "SELECT payload,attempts,last_error FROM cleanup_tasks WHERE run_id=?1",
                [run_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, usize>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| error.to_string())?;
        row.map(|(payload, attempts, last_error)| {
            Ok(Task {
                run_id: run_id.into(),
                manifest: serde_json::from_str(&payload).map_err(|error| error.to_string())?,
                attempts,
                last_error,
            })
        })
        .transpose()
    }

    pub fn fail_cleanup(&self, run_id: &str, error: &str) -> Result<(), String> {
        let _guard = store_write_guard()?;
        self.connection
            .execute(
                "UPDATE cleanup_tasks SET attempts=attempts+1,last_error=?2 WHERE run_id=?1",
                params![run_id, error],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn finish_cleanup(&self, run_id: &str) -> Result<(), String> {
        let _guard = store_write_guard()?;
        let tx = self
            .connection
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        tx.execute(
            "INSERT INTO workspace_cleanup_done(run_id,sequence)
            SELECT run_id,json_extract(payload,'$.sequence') FROM cleanup_tasks
            WHERE run_id=?1 AND json_extract(payload,'$.sequence') IS NOT NULL
            ON CONFLICT(run_id) DO UPDATE SET sequence=excluded.sequence",
            [run_id],
        )
        .map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM workspace_cleanup_done WHERE run_id=?1 AND EXISTS(SELECT 1 FROM deleted_runs WHERE run_id=?1)", [run_id])
            .map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM cleanup_tasks WHERE run_id=?1", [run_id])
            .map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM run_owned_directories WHERE run_id=?1 AND EXISTS(SELECT 1 FROM deleted_runs WHERE run_id=?1)", [run_id])
            .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())
    }

    pub(crate) fn is_attachment_input_referenced(&self, id: &str) -> Result<bool, String> {
        let payload = serde_json::to_string(&Target::data(crate::attachment_inputs::BUCKET, id))
            .map_err(|error| error.to_string())?;
        self.connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM events WHERE run_id=?1)
                 OR EXISTS(SELECT 1 FROM run_owned_directories WHERE target=?2)
                 OR EXISTS(SELECT 1 FROM cleanup_tasks WHERE run_id=?1)",
                params![id, payload],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
    }

    pub(crate) fn cleanup_target_is_shared(
        &self,
        excluded: &str,
        target: &Target,
    ) -> Result<bool, String> {
        // Both deletion and offline GC use the same lifetime predicate. A
        // completed Git Graph still needs its private ancestry for continuation;
        // only an ordinary folder can release it after successful delivery.
        if let Target::Shadow { root, name, .. } = target {
            return self.shadow_repo_referenced_by(excluded, &root.join("shadow_repos").join(name));
        }
        let payload = serde_json::to_string(target).map_err(|error| error.to_string())?;
        let recorded: bool = self.connection.query_row("SELECT EXISTS(SELECT 1 FROM run_owned_directories o
            WHERE o.target=?1 AND o.run_id<>?2 AND EXISTS(SELECT 1 FROM events e WHERE e.run_id=o.run_id))",
            params![payload, excluded], |row| row.get(0)).map_err(|error| error.to_string())?;
        if recorded {
            return Ok(true);
        }
        let planning = match target {
            Target::Data { bucket, id } if bucket == "planning" => Some(id),
            Target::Workspace {
                checkout: Some(id), ..
            } => Some(id),
            _ => None,
        };
        if let Some(id) = planning {
            return self.connection.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE run_id<>?1 AND (planning_id=?2 OR nested_planning_id=?2))",
                params![excluded, id], |row| row.get(0)).map_err(|error| error.to_string());
        }
        if let Target::Data { bucket, id } = target {
            if matches!(bucket.as_str(), "sessions" | "mergers") {
                let kind = if bucket == "sessions" {
                    "started"
                } else {
                    "merger_started"
                };
                return self.connection.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE run_id<>?1 AND kind=?2 AND execution_id=?3)",
                    params![excluded, kind, id], |row| row.get(0)).map_err(|error| error.to_string());
            }
        }
        Ok(false)
    }

    /// Whether another Graph/unrouted Run needs this source database. Standard
    /// Git retains private ancestry until its last conversation is deleted;
    /// plain folders can release it after publication. Serial never consumes it.
    pub fn shadow_repo_needed_by_other_run(
        &self,
        excluded: &str,
        repository: &Path,
    ) -> Result<bool, String> {
        let expected = crate::workspace::shadow_repo_dir(repository)?;
        self.shadow_repo_referenced_by(excluded, &expected)
    }

    /// Offline variant of the same source-database lifetime predicate, used by
    /// `--cleanup-workspaces` GC without a current Run.
    #[cfg(test)]
    pub(crate) fn shadow_repo_in_use(&self, shadow: &Path) -> Result<bool, String> {
        self.shadow_repo_referenced_by("", shadow)
    }

    pub(crate) fn is_shadow_repo_referenced(&self, shadow: &Path) -> Result<bool, String> {
        self.shadow_repo_referenced_by("", shadow)
    }

    pub(crate) fn shadow_reference_watermark(&self) -> Result<(i64, i64, i64), String> {
        let max_seq: i64 = self
            .connection
            .query_row("SELECT COALESCE(MAX(sequence), 0) FROM events", [], |row| {
                row.get(0)
            })
            .map_err(|error| error.to_string())?;
        let (owned_count, owned_max_rowid): (i64, i64) = self
            .connection
            .query_row(
                "SELECT COUNT(*), COALESCE(MAX(rowid), 0) FROM run_owned_directories",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| error.to_string())?;
        Ok((max_seq, owned_count, owned_max_rowid))
    }

    /// Single-pass set of canonical path keys for all shadow repositories
    /// currently referenced by any live/incomplete/standard-git Graph or
    /// unrouted Run, using indexed `run_metadata` instead of full event replays.
    pub(crate) fn referenced_shadow_repos(
        &self,
    ) -> Result<std::collections::BTreeSet<String>, String> {
        let mut referenced = std::collections::BTreeSet::new();
        for entry in self.run_metadata_entries()? {
            if entry.plan_type.as_deref() == Some("serial") || entry.repository.is_empty() {
                continue;
            }
            let source = Path::new(&entry.repository);
            let Some(resolved) = crate::workspace::shadow_repo_dir(source).ok() else {
                // Missing/moved source cannot disprove recorded shadow ownership.
                for target in self.owned_cleanup_targets(&entry.run_id)? {
                    if let Target::Shadow { root, name, .. } = target {
                        referenced.insert(crate::path_identity::path_key(
                            &root.join("shadow_repos").join(name),
                        ));
                    }
                }
                continue;
            };
            if entry.phase != "completed"
                || crate::workspace::is_standard_git(source)
                || entry.undelivered_result
            {
                referenced.insert(crate::path_identity::path_key(&resolved));
            }
        }
        Ok(referenced)
    }

    fn shadow_repo_referenced_by(&self, excluded: &str, expected: &Path) -> Result<bool, String> {
        for entry in self.run_metadata_entries()? {
            if entry.run_id == excluded {
                continue;
            }
            // Serial does not consume Git snapshots, even while running or
            // paused. Keep unrouted histories conservative: a provisional
            // planning Run can still resolve to Graph.
            if entry.plan_type.as_deref() == Some("serial") || entry.repository.is_empty() {
                continue;
            }
            let source = Path::new(&entry.repository);
            let resolved = crate::workspace::shadow_repo_dir(source).ok();
            if !resolved
                .as_deref()
                .is_some_and(|res| crate::path_identity::same_path(res, expected))
            {
                // A missing binding cannot disprove recorded ownership. Don't
                // discard recovery history merely because the source moved.
                if resolved.is_none() && self.owned_cleanup_targets(&entry.run_id)?.iter().any(|target| {
                    matches!(target, Target::Shadow { root, name, .. } if crate::path_identity::same_path(&root.join("shadow_repos").join(name), expected))
                }) { return Ok(true); }
                continue;
            }
            if entry.phase != "completed"
                || crate::workspace::is_standard_git(source)
                || entry.undelivered_result
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn completed_workspace_runs(&self) -> Result<Vec<String>, String> {
        let mut statement = self.connection.prepare("SELECT e.run_id FROM events e
            WHERE e.sequence IN (SELECT MAX(sequence) FROM events GROUP BY run_id)
              AND e.kind='publication_completed'
              AND NOT EXISTS(SELECT 1 FROM workspace_cleanup_done d WHERE d.run_id=e.run_id AND d.sequence=e.sequence)")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    /// Provisional planning directories whose Run never reached its first
    /// event are reclaimed only at startup, after planning recovery.
    pub fn orphaned_cleanup_owners(&self) -> Result<Vec<String>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT DISTINCT o.run_id FROM run_owned_directories o
            WHERE NOT EXISTS(SELECT 1 FROM events e WHERE e.run_id=o.run_id)
              AND NOT EXISTS(SELECT 1 FROM cleanup_tasks c WHERE c.run_id=o.run_id)",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }
}
