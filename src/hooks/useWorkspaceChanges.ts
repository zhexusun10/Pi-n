import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { runtimeService } from "../services/runtime";
import { startVisibilityPolling, type PollingController } from "../services/visibilityPolling";
import type { Execution, FileChangeSummary, Snapshot } from "../types";
import {
  cacheFileChangeSummary,
  emptyFileChangeSummary,
  getCachedFileChangeSummary,
  invalidateFileDiffCache,
} from "../services/fileChanges";

export interface UseWorkspaceChangesOptions {
  state: Snapshot;
  /**
   * Node/Merger conversation scope: only these executions' changes. `null`
   * means no scope (the main view uses the run-level projection). An empty
   * array is still a real scope: a waiting node that has no execution yet must
   * show no changes rather than every node's run aggregate.
   */
  scopedExecutions?: Execution[] | null;
  isWorking?: boolean;
}

export interface WorkspaceChangesViewModel {
  summary: FileChangeSummary;
  /** False until this scope has an authoritative summary. */
  isLoaded: boolean;
  refreshVersion: number;
  loadingMore: boolean;
  remoteExhausted: boolean;
  refresh: () => void;
  loadMore: () => Promise<void>;
}

const REFRESH_INTERVAL_MS = 2_000;
const FILE_CHANGES_PAGE_SIZE = 60;
const MAX_BACKEND_PAGE_LIMIT = 500;

function sameStringList(a?: string[], b?: string[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Polling often returns identical summaries; field-wise comparison avoids
 * JSON serialization overhead and prevents re-rendering the workbench every 2s. */
function sameSummary(a: FileChangeSummary, b: FileChangeSummary): boolean {
  if (a === b) return true;
  if (
    a.totalFiles !== b.totalFiles ||
    a.addedCount !== b.addedCount ||
    a.modifiedCount !== b.modifiedCount ||
    a.deletedCount !== b.deletedCount ||
    a.renamedCount !== b.renamedCount ||
    a.totalAdditions !== b.totalAdditions ||
    a.totalDeletions !== b.totalDeletions ||
    Boolean(a.isRunning) !== Boolean(b.isRunning) ||
    a.activeFilePath !== b.activeFilePath ||
    a.files.length !== b.files.length
  ) {
    return false;
  }
  for (let i = 0; i < a.files.length; i++) {
    const left = a.files[i];
    const right = b.files[i];
    if (
      left.path !== right.path ||
      left.oldPath !== right.oldPath ||
      left.status !== right.status ||
      left.additions !== right.additions ||
      left.deletions !== right.deletions ||
      Boolean(left.isRunning) !== Boolean(right.isRunning) ||
      left.source !== right.source ||
      left.contentVersion !== right.contentVersion ||
      !sameStringList(left.nodes, right.nodes) ||
      !sameStringList(left.executionIds, right.executionIds)
    ) {
      return false;
    }
  }
  return true;
}

function hasRunningFile(summary: FileChangeSummary | undefined): boolean {
  if (!summary) return false;
  return Boolean(summary.isRunning) || summary.files.some((file) => Boolean(file.isRunning));
}

type SummaryPage = Awaited<ReturnType<typeof runtimeService.getFileChanges>>;
type LoadedSummary = Pick<SummaryPage, "summary" | "orderVersion">;

function mergeSummaryPages(base: LoadedSummary, next: SummaryPage): LoadedSummary {
  const files = [...base.summary.files, ...next.summary.files];
  if (base.orderVersion !== next.orderVersion ||
    base.summary.totalFiles !== next.summary.totalFiles ||
    new Set(files.map(file => file.path)).size !== files.length) {
    throw new Error("File changes moved during pagination");
  }
  return { orderVersion: next.orderVersion, summary: { ...next.summary, files } };
}

async function readSummaryPrefix(
  readPage: (offset: number, limit: number) => Promise<SummaryPage>,
  limit: number,
): Promise<LoadedSummary> {
  const first = await readPage(0, Math.min(limit, MAX_BACKEND_PAGE_LIMIT));
  let loaded: LoadedSummary = first;
  if (first.summary.files.length < Math.min(MAX_BACKEND_PAGE_LIMIT, limit)) return loaded;
  while (loaded.summary.files.length < Math.min(limit, loaded.summary.totalFiles)) {
    const offset = loaded.summary.files.length;
    const chunkLimit = Math.min(MAX_BACKEND_PAGE_LIMIT, limit - offset);
    const page = await readPage(offset, chunkLimit);
    loaded = mergeSummaryPages(loaded, page);
    if (page.summary.files.length < chunkLimit) break;
  }
  return loaded;
}

/**
 * File changes are authoritative only in the backend summary: Git compares the
 * real snapshots, while tool-transcript parsing is an approximation (it misses
 * bash edits, truncated arguments and post-run direct writes). This hook never
 * counts lines or merges scopes itself; it displays the backend projection.
 *
 * The snapshot omits the change list (a build-heavy Run can hold tens of
 * thousands of paths), so the hook fetches it on demand through
 * `get_file_changes`.
 */
export function useWorkspaceChanges({
  state,
  scopedExecutions = null,
  isWorking = false,
}: UseWorkspaceChangesOptions): WorkspaceChangesViewModel {
  const runId = state.runId;
  const scoped = scopedExecutions !== null;
  const scopedIds = scoped ? scopedExecutions.map((execution) => execution.id) : null;
  const scopeKey = scopedIds === null ? `${runId}\0*` : `${runId}\0${scopedIds.join("\0")}`;
  // No executions means there cannot be any execution-scoped changes.
  const emptyScope = scopedIds !== null && scopedIds.length === 0;
  const [fetched, setFetched] = useState<({ key: string } & LoadedSummary) | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [remoteExhausted, setRemoteExhausted] = useState(false);
  const loadedLimitRef = useRef(FILE_CHANGES_PAGE_SIZE);
  const pageGenerationRef = useRef(0);
  const loadMoreAbortRef = useRef<AbortController | null>(null);
  const wasWorkingRef = useRef<{ scopeKey: string; isWorking: boolean }>({ scopeKey, isWorking });
  const wasRunningSummaryRef = useRef(false);
  const forceRefreshRef = useRef(false);
  const poller = useRef<PollingController | null>(null);
  const snapshotSequence = state.events.at(-1)?.sequence ?? 0;

  useEffect(() => {
    loadedLimitRef.current = FILE_CHANGES_PAGE_SIZE;
    pageGenerationRef.current += 1;
    setLoadingMore(false);
    setRemoteExhausted(false);
    wasRunningSummaryRef.current = false;
    return () => {
      loadMoreAbortRef.current?.abort();
      loadMoreAbortRef.current = null;
    };
  }, [scopeKey]);

  // Any running -> settled transition on the SAME scope must invalidate
  // in-flight/pre-run diff cache entries so completion never resurrects stale diffs.
  useEffect(() => {
    const previous = wasWorkingRef.current;
    const completed = previous.scopeKey === scopeKey && previous.isWorking && !isWorking;
    wasWorkingRef.current = { scopeKey, isWorking };
    if (completed && runId && !runId.startsWith("pending-")) {
      invalidateFileDiffCache(runId);
      setRefreshVersion((version) => version + 1);
      forceRefreshRef.current = true;
      poller.current?.wake();
    }
  }, [isWorking, runId, scopeKey]);

  useEffect(() => {
    forceRefreshRef.current = false;
    if (!runId || runId.startsWith("pending-")) { setFetched(null); return; }
    if (emptyScope) return;
    const abort = new AbortController();
    let nextReadAt = 0;
    const load = async (): Promise<number | null> => {
      if (loadMoreAbortRef.current) return REFRESH_INTERVAL_MS;
      const forced = forceRefreshRef.current;
      // Snapshot notifications coalesce with the live timer; frequent tool or
      // metrics updates must not turn into an unbounded stream of Git scans.
      if (!forced && Date.now() < nextReadAt) return nextReadAt - Date.now();
      forceRefreshRef.current = false;
      const startPageGeneration = pageGenerationRef.current;
      try {
        const { summary, orderVersion } = await readSummaryPrefix(
          (offset, limit) => runtimeService.getFileChanges(runId, scopedIds ?? undefined, abort.signal, { offset, limit }),
          loadedLimitRef.current,
        );
        if (abort.signal.aborted) return null;
        // A user-requested expansion supersedes any poll that read the old prefix.
        if (startPageGeneration !== pageGenerationRef.current) return REFRESH_INTERVAL_MS;
        const nowRunning = hasRunningFile(summary);
        if (wasRunningSummaryRef.current && !nowRunning) {
          invalidateFileDiffCache(runId);
          setRefreshVersion((version) => version + 1);
        }
        wasRunningSummaryRef.current = nowRunning;
        cacheFileChangeSummary(scopeKey, runId, summary);
        setFetched(previous => previous?.key === scopeKey && previous.orderVersion === orderVersion &&
          sameSummary(previous.summary, summary) ? previous : { key: scopeKey, summary, orderVersion });
        nextReadAt = Date.now() + REFRESH_INTERVAL_MS;
        return isWorking ? REFRESH_INTERVAL_MS : Infinity;
      } catch {
        if (abort.signal.aborted) return null;
        // A failed read is not an authoritative empty change list. Retain the
        // last projection and retry, including after a terminal snapshot.
        nextReadAt = Date.now() + REFRESH_INTERVAL_MS;
        return REFRESH_INTERVAL_MS;
      }
    };
    const polling = startVisibilityPolling(load);
    poller.current = polling;
    return () => {
      polling();
      abort.abort();
      if (poller.current === polling) poller.current = null;
    };
    // scopeKey contains the immutable execution-id list, not its array identity.
  }, [runId, scopeKey, emptyScope, isWorking]);

  useEffect(() => { poller.current?.wake(); }, [snapshotSequence]);

  const refresh = useCallback(() => {
    invalidateFileDiffCache(runId || undefined);
    setRefreshVersion(version => version + 1);
    setRemoteExhausted(false);
    if (!runId || runId.startsWith("pending-") || emptyScope) return;
    forceRefreshRef.current = true;
    poller.current?.wake();
  }, [runId, emptyScope]);

  const loadMore = useCallback(async () => {
    if (!runId || runId.startsWith("pending-") || emptyScope || loadMoreAbortRef.current || remoteExhausted) return;
    const current = fetched?.key === scopeKey ? fetched : undefined;
    const previous = current?.summary ?? getCachedFileChangeSummary(scopeKey) ?? emptyFileChangeSummary;
    const offset = previous.files.length;
    if (offset >= previous.totalFiles) return;
    const abort = new AbortController();
    loadMoreAbortRef.current = abort;
    pageGenerationRef.current += 1;
    setLoadingMore(true);
    try {
      const readPage = (pageOffset: number, limit: number) => runtimeService.getFileChanges(
        runId, scopedIds ?? undefined, abort.signal, { offset: pageOffset, limit },
      );
      const page = current?.orderVersion ? await readPage(offset, FILE_CHANGES_PAGE_SIZE) : undefined;
      if (abort.signal.aborted) return;
      // Rebuild the prefix if the order changed or the backend cannot verify it.
      const loaded = current && page && current.orderVersion === page.orderVersion
        ? mergeSummaryPages(current, page)
        : await readSummaryPrefix(readPage, offset + FILE_CHANGES_PAGE_SIZE);
      if (abort.signal.aborted) return;
      const { summary, orderVersion } = loaded;
      setRemoteExhausted(orderVersion === undefined && summary.files.length <= offset &&
        summary.totalFiles > summary.files.length);
      loadedLimitRef.current = Math.max(loadedLimitRef.current, summary.files.length);
      cacheFileChangeSummary(scopeKey, runId, summary);
      setFetched({ key: scopeKey, summary, orderVersion });
    } catch {
      // Keep current loaded rows; user can retry clicking Load More.
    } finally {
      if (loadMoreAbortRef.current === abort) {
        loadMoreAbortRef.current = null;
        setLoadingMore(false);
      }
    }
  }, [emptyScope, fetched, remoteExhausted, runId, scopeKey, scopedIds]);

  return useMemo(() => {
    const cachedSummary = !emptyScope ? getCachedFileChangeSummary(scopeKey) : undefined;
    const effectiveSummary = !emptyScope && fetched && fetched.key === scopeKey ? fetched.summary : cachedSummary;
    const summary = effectiveSummary ?? emptyFileChangeSummary;

    return {
      summary,
      isLoaded: !runId || runId.startsWith("pending-") || emptyScope || effectiveSummary !== undefined,
      refreshVersion,
      loadingMore,
      remoteExhausted,
      refresh,
      loadMore,
    };
  }, [
    emptyScope,
    fetched,
    loadMore,
    loadingMore,
    refresh,
    refreshVersion,
    remoteExhausted,
    runId,
    scopeKey,
  ]);
}
