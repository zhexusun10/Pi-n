//! Backend-owned warm shells and retained background services for source-native conversations.
//!
//! A successful Serial turn parks its Pi process — and any background services it
//! started — so follow-up turns reuse the resident shell. To prevent unbounded
//! memory growth across many conversations, parked agent shells have both a
//! capacity budget (LRU) and an idle TTL.
//!
//! Crucially, **budget/idle eviction** and **resource-generation invalidation**
//! (for example toggling Pi extensions) call [`LingeringWorker::evict_preserving_services`],
//! which shuts down only the heavy Pi agent process while transferring any live
//! background descendants (dev servers, watchers) into [`LingeringServices`].
//! Explicit Run/workspace deletion, workspace reset, history editing, explicit
//! full release, and backend shutdown call [`Worker::retire`] to terminate the
//! entire process tree.

use super::prewarm::Worker;
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

/// Default maximum number of simultaneously parked Serial Pi agent shells.
pub(crate) const DEFAULT_MAX_PARKED_AGENTS: usize = 8;

/// Default idle duration after which an unused parked Serial Pi agent shell is
/// reclaimed (preserving any live background service descendants).
pub(crate) const DEFAULT_PARKED_AGENT_IDLE_TTL: Duration = Duration::from_secs(30 * 60);

/// A parked worker that can distinguish full termination (`retire`) from
/// agent-only reclamation (`evict_preserving_services`).
pub(crate) trait LingeringWorker: Worker + Sized {
    fn evict_preserving_services(self, _run_id: &str) {
        self.retire();
    }
}

/// Stable identity of a Serial Pi conversation. Execution ids change across
/// attempts (invalidate/retry), so they must never key a parked shell.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct SessionKey {
    pub repository: PathBuf,
    pub session_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ParkedEntrySnapshot {
    pub run_id: String,
    pub session_id: String,
    pub repository: String,
    pub idle_secs: u64,
}

struct Entry<W> {
    key: SessionKey,
    run_id: String,
    worker: W,
    last_used: Instant,
}

/// Parked shells keyed by conversation, bounded by capacity and idle TTL.
pub(crate) struct Lingering<W> {
    entries: Mutex<Vec<Entry<W>>>,
    max_entries: usize,
    idle_ttl: Duration,
}

impl<W: LingeringWorker> Default for Lingering<W> {
    fn default() -> Self {
        Self::with_limits(DEFAULT_MAX_PARKED_AGENTS, DEFAULT_PARKED_AGENT_IDLE_TTL)
    }
}

impl<W: LingeringWorker> Lingering<W> {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn with_limits(max_entries: usize, idle_ttl: Duration) -> Self {
        Self {
            entries: Mutex::new(Vec::new()),
            max_entries,
            idle_ttl,
        }
    }

    pub(crate) fn max_entries(&self) -> usize {
        self.max_entries
    }

    pub(crate) fn idle_ttl(&self) -> Duration {
        self.idle_ttl
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Entry<W>>> {
        // A panic while retiring a worker must not make the pool permanently
        // unusable: parked shells would leak until backend shutdown.
        self.entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn is_expired(&self, entry: &Entry<W>, now: Instant) -> bool {
        !self.idle_ttl.is_zero() && now.saturating_duration_since(entry.last_used) >= self.idle_ttl
    }

    fn drain_dead_and_expired(
        &self,
        entries: &mut Vec<Entry<W>>,
        now: Instant,
    ) -> (Vec<W>, Vec<(String, W)>) {
        let mut dead = Vec::new();
        let mut expired = Vec::new();
        let mut kept = Vec::with_capacity(entries.len());
        for mut entry in entries.drain(..) {
            if !entry.worker.alive() {
                dead.push(entry.worker);
            } else if self.is_expired(&entry, now) {
                expired.push((entry.run_id, entry.worker));
            } else {
                kept.push(entry);
            }
        }
        *entries = kept;
        (dead, expired)
    }

    /// Park a settled shell, replacing any existing entry for the same session.
    /// Dead and idle-expired entries are pruned first, then LRU capacity eviction
    /// reclaims the oldest idle agent while preserving background services.
    pub(crate) fn park(&self, key: SessionKey, run_id: String, worker: W) {
        let now = Instant::now();
        let (mut retired, mut evicted) = {
            let mut entries = self.lock();
            let (mut dead, mut expired) = self.drain_dead_and_expired(&mut entries, now);
            if let Some(index) = entries.iter().position(|entry| entry.key == key) {
                dead.push(entries.remove(index).worker);
            }
            if self.max_entries == 0 {
                expired.push((run_id, worker));
            } else {
                while entries.len() >= self.max_entries {
                    let oldest_index = entries
                        .iter()
                        .enumerate()
                        .min_by_key(|(_, entry)| entry.last_used)
                        .map(|(index, _)| index)
                        .unwrap_or(0);
                    let victim = entries.remove(oldest_index);
                    expired.push((victim.run_id, victim.worker));
                }
                entries.push(Entry {
                    key,
                    run_id,
                    worker,
                    last_used: now,
                });
            }
            (dead, expired)
        };
        for worker in retired.drain(..) {
            worker.retire();
        }
        for (evicted_run, worker) in evicted.drain(..) {
            worker.evict_preserving_services(&evicted_run);
        }
    }

    /// Return whether a live, non-expired parked shell exists for this conversation.
    pub(crate) fn has_live(&self, key: &SessionKey) -> bool {
        let now = Instant::now();
        let (dead, expired, alive) = {
            let mut entries = self.lock();
            let (dead, expired) = self.drain_dead_and_expired(&mut entries, now);
            let alive = entries.iter().any(|entry| &entry.key == key);
            (dead, expired, alive)
        };
        for worker in dead {
            worker.retire();
        }
        for (evicted_run, worker) in expired {
            worker.evict_preserving_services(&evicted_run);
        }
        alive
    }

    /// Take the parked shell for this conversation. Dead entries are retired and
    /// idle-expired entries are evicted (preserving background services); both
    /// report as a miss so the caller cold-launches cleanly.
    pub(crate) fn claim(&self, key: &SessionKey) -> Option<W> {
        let now = Instant::now();
        let (dead, expired, claimed) = {
            let mut entries = self.lock();
            let (dead, expired) = self.drain_dead_and_expired(&mut entries, now);
            let claimed = entries
                .iter()
                .position(|entry| &entry.key == key)
                .map(|index| entries.remove(index).worker);
            (dead, expired, claimed)
        };
        for worker in dead {
            worker.retire();
        }
        for (evicted_run, worker) in expired {
            worker.evict_preserving_services(&evicted_run);
        }
        claimed
    }

    /// Reap dead and idle-expired parked shells. Returns the number reclaimed.
    pub(crate) fn reap_idle(&self) -> usize {
        let now = Instant::now();
        let (dead, expired) = {
            let mut entries = self.lock();
            self.drain_dead_and_expired(&mut entries, now)
        };
        let count = dead.len() + expired.len();
        for worker in dead {
            worker.retire();
        }
        for (evicted_run, worker) in expired {
            worker.evict_preserving_services(&evicted_run);
        }
        count
    }

    /// Evict parked agents matching `predicate` while preserving any background
    /// services they started. Returns the number of evicted agents.
    pub(crate) fn evict_where(&self, predicate: impl Fn(&str) -> bool) -> usize {
        let evicted = {
            let mut entries = self.lock();
            let mut kept = Vec::with_capacity(entries.len());
            let mut evicted = Vec::new();
            for entry in entries.drain(..) {
                if predicate(&entry.run_id) {
                    evicted.push((entry.run_id, entry.worker));
                } else {
                    kept.push(entry);
                }
            }
            *entries = kept;
            evicted
        };
        let count = evicted.len();
        for (run_id, worker) in evicted {
            worker.evict_preserving_services(&run_id);
        }
        count
    }

    /// Retire every parked shell matching a predicate (Run/workspace deletion).
    pub(crate) fn retire_where(&self, predicate: impl Fn(&str) -> bool) -> usize {
        let retired = {
            let mut entries = self.lock();
            let mut kept = Vec::with_capacity(entries.len());
            let mut retired = Vec::new();
            for entry in entries.drain(..) {
                if predicate(&entry.run_id) {
                    retired.push(entry.worker);
                } else {
                    kept.push(entry);
                }
            }
            *entries = kept;
            retired
        };
        let count = retired.len();
        for worker in retired {
            worker.retire();
        }
        count
    }

    /// Retire every parked shell (backend shutdown).
    pub(crate) fn shutdown(&self) {
        let drained = {
            let mut entries = self.lock();
            entries
                .drain(..)
                .map(|entry| entry.worker)
                .collect::<Vec<_>>()
        };
        for worker in drained {
            worker.retire();
        }
    }

    /// Inspect live parked shells (pruning dead/expired entries first).
    pub(crate) fn snapshot_entries(&self) -> Vec<ParkedEntrySnapshot> {
        let now = Instant::now();
        let (dead, expired, snapshots) = {
            let mut entries = self.lock();
            let (dead, expired) = self.drain_dead_and_expired(&mut entries, now);
            let snapshots = entries
                .iter()
                .map(|entry| ParkedEntrySnapshot {
                    run_id: entry.run_id.clone(),
                    session_id: entry.key.session_id.clone(),
                    repository: entry.key.repository.to_string_lossy().into_owned(),
                    idle_secs: now.saturating_duration_since(entry.last_used).as_secs(),
                })
                .collect::<Vec<_>>();
            (dead, expired, snapshots)
        };
        for worker in dead {
            worker.retire();
        }
        for (evicted_run, worker) in expired {
            worker.evict_preserving_services(&evicted_run);
        }
        snapshots
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.lock().len()
    }
}

struct ServiceEntry<W> {
    run_id: String,
    worker: W,
}

/// Process boundaries held for background services without retaining their agent host.
pub(crate) struct LingeringServices<W> {
    entries: Mutex<Vec<ServiceEntry<W>>>,
}

impl<W: Worker> Default for LingeringServices<W> {
    fn default() -> Self {
        Self {
            entries: Mutex::new(Vec::new()),
        }
    }
}

impl<W: Worker> LingeringServices<W> {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<ServiceEntry<W>>> {
        self.entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    pub(crate) fn hold(&self, run_id: String, mut worker: W) {
        if !worker.alive() {
            worker.retire();
            return;
        }
        let retired = {
            let mut entries = self.lock();
            let mut kept = Vec::with_capacity(entries.len() + 1);
            let mut retired = Vec::new();
            for mut entry in entries.drain(..) {
                if entry.worker.alive() {
                    kept.push(entry);
                } else {
                    retired.push(entry.worker);
                }
            }
            kept.push(ServiceEntry { run_id, worker });
            *entries = kept;
            retired
        };
        for worker in retired {
            worker.retire();
        }
    }

    pub(crate) fn prune_dead(&self) -> usize {
        let retired = {
            let mut entries = self.lock();
            let mut kept = Vec::with_capacity(entries.len());
            let mut retired = Vec::new();
            for mut entry in entries.drain(..) {
                if entry.worker.alive() {
                    kept.push(entry);
                } else {
                    retired.push(entry.worker);
                }
            }
            *entries = kept;
            retired
        };
        let count = retired.len();
        for worker in retired {
            worker.retire();
        }
        count
    }

    pub(crate) fn retire_run(&self, run_id: &str) -> usize {
        let retired = {
            let mut entries = self.lock();
            let mut kept = Vec::with_capacity(entries.len());
            let mut retired = Vec::new();
            for entry in entries.drain(..) {
                if entry.run_id == run_id {
                    retired.push(entry.worker);
                } else {
                    kept.push(entry);
                }
            }
            *entries = kept;
            retired
        };
        let count = retired.len();
        for worker in retired {
            worker.retire();
        }
        count
    }

    pub(crate) fn shutdown(&self) -> usize {
        let drained = {
            let mut entries = self.lock();
            entries
                .drain(..)
                .map(|entry| entry.worker)
                .collect::<Vec<_>>()
        };
        let count = drained.len();
        for worker in drained {
            worker.retire();
        }
        count
    }

    /// Count live background service trees per Run ID (pruning dead entries first).
    pub(crate) fn snapshot_by_run(&self) -> BTreeMap<String, usize> {
        let (retired, counts) = {
            let mut entries = self.lock();
            let mut kept = Vec::with_capacity(entries.len());
            let mut retired = Vec::new();
            let mut counts: BTreeMap<String, usize> = BTreeMap::new();
            for mut entry in entries.drain(..) {
                if entry.worker.alive() {
                    *counts.entry(entry.run_id.clone()).or_default() += 1;
                    kept.push(entry);
                } else {
                    retired.push(entry.worker);
                }
            }
            *entries = kept;
            (retired, counts)
        };
        for worker in retired {
            worker.retire();
        }
        counts
    }

    #[cfg(test)]
    pub(crate) fn count_for_run(&self, run_id: &str) -> usize {
        self.lock()
            .iter()
            .filter(|entry| entry.run_id == run_id)
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };

    struct FakeWorker {
        alive: Arc<AtomicBool>,
        retired: Arc<AtomicUsize>,
        evicted: Arc<AtomicUsize>,
    }

    impl Worker for FakeWorker {
        fn alive(&mut self) -> bool {
            self.alive.load(Ordering::SeqCst)
        }
        fn retire(self) {
            self.retired.fetch_add(1, Ordering::SeqCst);
        }
    }

    impl LingeringWorker for FakeWorker {
        fn evict_preserving_services(self, _run_id: &str) {
            self.evicted.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn key(session: &str) -> SessionKey {
        SessionKey {
            repository: PathBuf::from("C:/repo"),
            session_id: session.into(),
        }
    }

    fn worker() -> (
        FakeWorker,
        Arc<AtomicBool>,
        Arc<AtomicUsize>,
        Arc<AtomicUsize>,
    ) {
        let alive = Arc::new(AtomicBool::new(true));
        let retired = Arc::new(AtomicUsize::new(0));
        let evicted = Arc::new(AtomicUsize::new(0));
        (
            FakeWorker {
                alive: alive.clone(),
                retired: retired.clone(),
                evicted: evicted.clone(),
            },
            alive,
            retired,
            evicted,
        )
    }

    #[test]
    fn claim_returns_the_parked_worker_once() {
        let pool = Lingering::new();
        let (worker, _alive, _retired, _evicted) = worker();
        pool.park(key("a"), "run-a".into(), worker);
        assert!(pool.claim(&key("a")).is_some());
        assert!(pool.claim(&key("a")).is_none());
        assert_eq!(pool.len(), 0);
    }

    #[test]
    fn a_live_worker_stays_warm_within_idle_ttl() {
        let pool = Lingering::new();
        let (worker, _alive, retired, evicted) = worker();
        pool.park(key("a"), "run-a".into(), worker);
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(retired.load(Ordering::SeqCst), 0);
        assert_eq!(evicted.load(Ordering::SeqCst), 0);
        assert!(pool.claim(&key("a")).is_some());
    }

    #[test]
    fn idle_ttl_evicts_preserving_services_instead_of_full_retire() {
        let pool = Lingering::with_limits(4, Duration::from_millis(25));
        let (worker, _alive, retired, evicted) = worker();
        pool.park(key("a"), "run-a".into(), worker);
        std::thread::sleep(Duration::from_millis(40));
        assert_eq!(pool.reap_idle(), 1);
        assert_eq!(retired.load(Ordering::SeqCst), 0);
        assert_eq!(evicted.load(Ordering::SeqCst), 1);
        assert_eq!(pool.len(), 0);
    }

    #[test]
    fn capacity_budget_evicts_oldest_entry_preserving_services() {
        let pool = Lingering::with_limits(2, Duration::from_secs(60));
        let (w1, _a1, r1, e1) = worker();
        let (w2, _a2, r2, e2) = worker();
        let (w3, _a3, r3, e3) = worker();
        pool.park(key("a"), "run-a".into(), w1);
        std::thread::sleep(Duration::from_millis(5));
        pool.park(key("b"), "run-b".into(), w2);
        std::thread::sleep(Duration::from_millis(5));
        pool.park(key("c"), "run-c".into(), w3);
        assert_eq!(pool.len(), 2);
        assert_eq!(r1.load(Ordering::SeqCst), 0);
        assert_eq!(e1.load(Ordering::SeqCst), 1);
        assert_eq!(r2.load(Ordering::SeqCst) + e2.load(Ordering::SeqCst), 0);
        assert_eq!(r3.load(Ordering::SeqCst) + e3.load(Ordering::SeqCst), 0);
        assert!(pool.claim(&key("a")).is_none());
        assert!(pool.claim(&key("b")).is_some());
        assert!(pool.claim(&key("c")).is_some());
    }

    #[test]
    fn a_dead_worker_is_retired_and_reported_as_a_miss() {
        let pool = Lingering::new();
        let (worker, alive, retired, _evicted) = worker();
        pool.park(key("a"), "run-a".into(), worker);
        alive.store(false, Ordering::SeqCst);
        assert!(pool.claim(&key("a")).is_none());
        assert_eq!(retired.load(Ordering::SeqCst), 1);
        assert_eq!(pool.len(), 0);
    }

    #[test]
    fn parking_the_same_session_replaces_and_retires_the_previous_shell() {
        let pool = Lingering::new();
        let (first, _a, r1, _e1) = worker();
        pool.park(key("a"), "run-a".into(), first);
        let (second, _b, _r2, _e2) = worker();
        pool.park(key("a"), "run-b".into(), second);
        assert_eq!(r1.load(Ordering::SeqCst), 1);
        assert_eq!(pool.len(), 1);
        assert!(pool.claim(&key("a")).is_some());
    }

    #[test]
    fn evict_where_preserves_services_while_retire_where_terminates() {
        let pool = Lingering::new();
        let (first, _a, r1, e1) = worker();
        pool.park(key("a"), "run-a".into(), first);
        let (second, _b, r2, e2) = worker();
        pool.park(key("b"), "run-b".into(), second);
        assert_eq!(pool.evict_where(|run_id| run_id == "run-a"), 1);
        assert_eq!(r1.load(Ordering::SeqCst), 0);
        assert_eq!(e1.load(Ordering::SeqCst), 1);
        assert_eq!(pool.retire_where(|run_id| run_id == "run-b"), 1);
        assert_eq!(r2.load(Ordering::SeqCst), 1);
        assert_eq!(e2.load(Ordering::SeqCst), 0);
        assert_eq!(pool.len(), 0);
    }

    #[test]
    fn shutdown_retires_everything() {
        let pool = Lingering::new();
        let (first, _a, r1, _e1) = worker();
        pool.park(key("a"), "run-a".into(), first);
        let (second, _b, r2, _e2) = worker();
        pool.park(key("b"), "run-b".into(), second);
        pool.shutdown();
        assert_eq!(r1.load(Ordering::SeqCst), 1);
        assert_eq!(r2.load(Ordering::SeqCst), 1);
        assert_eq!(pool.len(), 0);
    }

    #[test]
    fn held_services_retire_only_with_their_run() {
        let pool = LingeringServices::new();
        let (first, _a, r1, _e1) = worker();
        pool.hold("run-a".into(), first);
        let (second, _b, r2, _e2) = worker();
        pool.hold("run-b".into(), second);
        assert_eq!(pool.count_for_run("run-a"), 1);
        assert_eq!(pool.snapshot_by_run().get("run-a"), Some(&1));
        pool.retire_run("run-a");
        assert_eq!(r1.load(Ordering::SeqCst), 1);
        assert_eq!(r2.load(Ordering::SeqCst), 0);
        assert_eq!(pool.count_for_run("run-b"), 1);
        pool.shutdown();
        assert_eq!(r2.load(Ordering::SeqCst), 1);
    }
}
