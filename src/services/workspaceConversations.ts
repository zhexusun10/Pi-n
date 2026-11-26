import type { ConversationSummary, ProjectItem, Snapshot } from "../types";

export type WorkspaceRuns = Record<string, string[]>;

export function partitionRunsByPinned(
  ids: readonly string[],
  pinnedRunIds?: ReadonlySet<string>,
): string[] {
  if (!pinnedRunIds || pinnedRunIds.size === 0 || ids.length <= 1) return [...ids];
  const pinned: string[] = [];
  const unpinned: string[] = [];
  for (const id of ids) {
    if (pinnedRunIds.has(id)) pinned.push(id);
    else unpinned.push(id);
  }
  if (pinned.length === 0 || unpinned.length === 0) return [...ids];
  return [...pinned, ...unpinned];
}

export function reorderSubset<T>(
  all: readonly T[],
  visibleKeys: readonly string[],
  fromVisibleIndex: number,
  toVisibleIndex: number,
  keyOf: (item: T) => string,
): T[] {
  if (
    fromVisibleIndex === toVisibleIndex ||
    fromVisibleIndex < 0 ||
    toVisibleIndex < 0 ||
    fromVisibleIndex >= visibleKeys.length ||
    toVisibleIndex >= visibleKeys.length
  ) {
    return [...all];
  }
  const nextVisible = [...visibleKeys];
  const [moved] = nextVisible.splice(fromVisibleIndex, 1);
  nextVisible.splice(toVisibleIndex, 0, moved);

  const itemByKey = new Map<string, T>();
  const visibleSet = new Set(visibleKeys);
  const slotIndices: number[] = [];
  all.forEach((item, idx) => {
    const key = keyOf(item);
    if (visibleSet.has(key)) {
      slotIndices.push(idx);
      itemByKey.set(key, item);
    }
  });
  if (slotIndices.length !== nextVisible.length) return [...all];

  const result = [...all];
  slotIndices.forEach((slotIdx, i) => {
    const item = itemByKey.get(nextVisible[i]);
    if (item !== undefined) result[slotIdx] = item;
  });
  return result;
}

export function orderProjects(
  items: readonly ProjectItem[],
  projectOrder?: readonly string[] | null,
): ProjectItem[] {
  const normalized = items.map((p) => ({
    ...p,
    path: normalizeWorkspacePath(p.path),
    id: normalizeWorkspacePath(p.id || p.path),
  }));
  if (!projectOrder || projectOrder.length === 0) {
    return normalized.sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
  }
  const orderIndex = new Map<string, number>();
  projectOrder.forEach((rawKey, idx) => {
    const key = workspaceKey(rawKey);
    if (key && !orderIndex.has(key)) orderIndex.set(key, idx);
  });
  return normalized.sort((a, b) => {
    const idxA = orderIndex.get(workspaceKey(a.path));
    const idxB = orderIndex.get(workspaceKey(b.path));
    if (idxA !== undefined && idxB !== undefined) return idxA - idxB;
    if (idxA !== undefined) return 1;
    if (idxB !== undefined) return -1;
    return (b.lastOpened || 0) - (a.lastOpened || 0);
  });
}

export function normalizeWorkspacePath(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  if (path.startsWith("\\\\?\\")) return path.slice(4);
  return path;
}

/** Windows aliases share an index; POSIX paths remain case-sensitive. */
export function workspaceKey(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  if (/^[a-z]:[/\\]/i.test(normalized) || normalized.startsWith("\\\\")) {
    return normalized.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

export function normalizeWorkspaceRuns(index: WorkspaceRuns): WorkspaceRuns {
  const result: WorkspaceRuns = {};
  for (const [repository, ids] of Object.entries(index)) {
    const key = workspaceKey(repository);
    if (!key || key === "default" || !Array.isArray(ids)) continue;
    result[key] = [...new Set([...(result[key] ?? []), ...ids.filter(id => typeof id === "string")])];
  }
  return result;
}

function insertAfterPinned(
  list: readonly string[],
  runId: string,
  pinnedRunIds?: ReadonlySet<string>,
): string[] {
  if (!pinnedRunIds || pinnedRunIds.size === 0 || pinnedRunIds.has(runId)) {
    return [runId, ...list];
  }
  const insertAt = list.findIndex(id => !pinnedRunIds.has(id));
  if (insertAt === -1) return [...list, runId];
  return [...list.slice(0, insertAt), runId, ...list.slice(insertAt)];
}

/** Ownership comes from the Run, never from the workspace currently on screen. */
export function bindRunToWorkspace(
  index: WorkspaceRuns,
  runId: string,
  repository: string,
  replacedId?: string,
  pinnedRunIds?: ReadonlySet<string>,
): WorkspaceRuns {
  const owner = workspaceKey(repository);
  if (!runId || !owner) return index;
  if (index[owner]?.includes(runId) &&
    !Object.entries(index).some(([key, ids]) =>
      (key !== owner && ids.includes(runId)) || (!!replacedId && ids.includes(replacedId)))) return index;

  const next: WorkspaceRuns = {};
  for (const [key, ids] of Object.entries(index)) {
    next[key] = ids.filter(id => id !== runId && id !== replacedId);
  }
  const existing = index[owner] ?? [];
  // A provisional card keeps its position when its durable ID arrives.
  next[owner] = replacedId && existing.includes(replacedId)
    ? [...new Set(existing.map(id => id === replacedId ? runId : id))]
    : insertAfterPinned(next[owner] ?? [], runId, pinnedRunIds);
  return next;
}

/**
 * Move a conversation to the first unpinned position of its workspace list (and
 * enforce exclusive ownership) when a new turn starts in that conversation.
 * Pinned conversations keep their pinned position so new turns never push them down.
 */
export function promoteRunInWorkspace(
  index: WorkspaceRuns,
  runId: string,
  repository: string,
  pinnedRunIds?: ReadonlySet<string>,
): WorkspaceRuns {
  const owner = workspaceKey(repository);
  if (!runId || !owner) return index;
  const existing = index[owner] ?? [];
  const exclusive = !Object.entries(index).some(([key, ids]) => key !== owner && ids.includes(runId));
  const isPinned = Boolean(pinnedRunIds?.has(runId));

  if (isPinned && existing.includes(runId) && exclusive) {
    const partitioned = partitionRunsByPinned(existing, pinnedRunIds);
    if (partitioned.every((id, idx) => id === existing[idx])) return index;
    return { ...index, [owner]: partitioned };
  }

  if (!isPinned && exclusive) {
    const firstUnpinnedIndex = existing.findIndex(id => !pinnedRunIds?.has(id));
    if (firstUnpinnedIndex !== -1 && existing[firstUnpinnedIndex] === runId) {
      return index;
    }
  }

  const next: WorkspaceRuns = {};
  for (const [key, ids] of Object.entries(index)) {
    next[key] = ids.filter(id => id !== runId);
  }
  const targetList = partitionRunsByPinned(next[owner] ?? [], pinnedRunIds);
  next[owner] = insertAfterPinned(targetList, runId, pinnedRunIds);
  return next;
}

/** Pin a conversation to the very top of its workspace list. */
export function pinRunInWorkspace(
  index: WorkspaceRuns,
  runId: string,
  repository: string,
  pinnedRunIds: ReadonlySet<string>,
): WorkspaceRuns {
  if (!runId) return index;
  let owner = repository ? workspaceKey(repository) : "";
  if (!owner || !index[owner]?.includes(runId)) {
    const found = Object.entries(index).find(([, ids]) => ids.includes(runId));
    if (found) owner = found[0];
  }
  if (!owner) return index;
  const existing = index[owner] ?? [];
  const rest = existing.filter(id => id !== runId);
  const nextList = partitionRunsByPinned([runId, ...rest], pinnedRunIds);
  if (nextList.length === existing.length && nextList.every((id, idx) => id === existing[idx])) {
    return index;
  }
  return { ...index, [owner]: nextList };
}

/** Re-partition a workspace list after unpinning a conversation so remaining pinned cards stay above it. */
export function unpinRunInWorkspace(
  index: WorkspaceRuns,
  runId: string,
  repository: string,
  remainingPinnedRunIds: ReadonlySet<string>,
): WorkspaceRuns {
  if (!runId) return index;
  let owner = repository ? workspaceKey(repository) : "";
  if (!owner || !index[owner]?.includes(runId)) {
    const found = Object.entries(index).find(([, ids]) => ids.includes(runId));
    if (found) owner = found[0];
  }
  if (!owner) return index;
  const existing = index[owner] ?? [];
  const nextList = partitionRunsByPinned(existing, remainingPinnedRunIds);
  if (nextList.length === existing.length && nextList.every((id, idx) => id === existing[idx])) {
    return index;
  }
  return { ...index, [owner]: nextList };
}

/** Reorder visible conversations within a workspace while preserving pinned/unpinned grouping. */
export function reorderRunsInWorkspace(
  index: WorkspaceRuns,
  repository: string,
  visibleRunIds: readonly string[],
  fromVisibleIndex: number,
  toVisibleIndex: number,
  pinnedRunIds?: ReadonlySet<string>,
): WorkspaceRuns {
  const owner = workspaceKey(repository);
  if (!owner) return index;
  const existing = index[owner];
  if (!existing || existing.length <= 1) return index;
  const reordered = partitionRunsByPinned(
    reorderSubset(existing, visibleRunIds, fromVisibleIndex, toVisibleIndex, id => id),
    pinnedRunIds,
  );
  if (reordered.length === existing.length && reordered.every((id, idx) => id === existing[idx])) {
    return index;
  }
  return { ...index, [owner]: reordered };
}

/**
 * Fold one progressive validation batch into the warm cached index without
 * replacing cards whose histories are still unresolved. `validated` must be the
 * batch built for this publish: reading live validation state here would let a
 * later batch remove cards that this batch never inspected, and re-appending
 * them would replay their entrance animation in a different order.
 */
export function mergeValidatedWorkspaceRuns(
  current: WorkspaceRuns,
  validated: WorkspaceRuns,
): WorkspaceRuns {
  const merged: WorkspaceRuns = {};
  for (const [owner, ids] of Object.entries(current)) merged[owner] = [...ids];
  const validatedIds = new Set(Object.values(validated).flat());
  // Validation is authoritative for ownership, so a cached card proven to
  // belong to another workspace must leave its old list right away.
  for (const id of validatedIds) {
    for (const [owner, ids] of Object.entries(merged)) {
      if (validated[owner]?.includes(id)) continue;
      const index = ids.indexOf(id);
      if (index !== -1) ids.splice(index, 1);
    }
  }
  for (const [owner, ids] of Object.entries(validated)) {
    const list = merged[owner] || (merged[owner] = []);
    for (const id of ids) if (!list.includes(id)) list.push(id);
  }
  return merged;
}

/** Replace the browser hint with the authoritative, newest-first backend index,
 * preserving user-defined sidebar order and pinned conversations when present. */
export function workspaceRunsFromSummaries(
  summaries: ConversationSummary[],
  cached: WorkspaceRuns = {},
  unavailableRunIds: string[] = [],
  pinnedRunIds?: ReadonlySet<string>,
  customOrder?: WorkspaceRuns,
): WorkspaceRuns {
  const result: WorkspaceRuns = {};
  const seen = new Set<string>();
  for (const summary of summaries) {
    const owner = workspaceKey(summary.repository);
    if (!owner || !summary.runId || summary.runId.startsWith("pending-") || seen.has(summary.runId)) continue;
    seen.add(summary.runId);
    (result[owner] ??= []).push(summary.runId);
  }
  // A failed read is not evidence of deletion or new ownership. Only preserve
  // explicitly unavailable IDs; all other stale browser cards must disappear.
  const unavailable = new Set(unavailableRunIds);
  for (const [owner, ids] of Object.entries(normalizeWorkspaceRuns(cached))) {
    for (const id of ids) {
      if (!unavailable.has(id) || seen.has(id) || id.startsWith("pending-")) continue;
      seen.add(id);
      (result[owner] ??= []).push(id);
    }
  }
  const normalizedOrder = customOrder ? normalizeWorkspaceRuns(customOrder) : {};
  for (const [owner, authoritative] of Object.entries(result)) {
    const preferred = normalizedOrder[owner];
    let ordered = authoritative;
    if (preferred && preferred.length > 0) {
      const authSet = new Set(authoritative);
      const knownInPreferred = preferred.filter(id => authSet.has(id));
      const knownSet = new Set(knownInPreferred);
      const fresh = authoritative.filter(id => !knownSet.has(id));
      ordered = [...fresh, ...knownInPreferred];
    }
    result[owner] = partitionRunsByPinned(ordered, pinnedRunIds);
  }
  return result;
}

export function snapshotBelongsToWorkspace(snapshot: Snapshot, repository: string): boolean {
  const owner = workspaceKey(snapshot.config?.repository ?? "");
  return !!owner && owner === workspaceKey(repository);
}

/**
 * Repair previously polluted indexes as well as discover unindexed Runs.
 * Cached cards keep their relative order; newly discovered Runs are inserted
 * ahead of them in snapshot order. Prepending one snapshot at a time would
 * reverse a cold cache and replay every card's entrance animation.
 */
export function reconcileWorkspaceRuns(index: WorkspaceRuns, snapshots: Array<Snapshot | null>): WorkspaceRuns {
  const cached = normalizeWorkspaceRuns(index);
  for (const key of Object.keys(cached)) {
    // Provisional IDs only exist in the originating browser session.
    cached[key] = cached[key].filter(id => !id.startsWith("pending-"));
  }

  // The last snapshot wins if one ID is reported more than once.
  const ownerByRun = new Map<string, string | null>();
  const discovered: string[] = [];
  for (const snapshot of snapshots) {
    if (!snapshot?.runId) continue;
    if (!ownerByRun.has(snapshot.runId)) discovered.push(snapshot.runId);
    const repository = snapshot.config?.repository;
    ownerByRun.set(snapshot.runId, repository ? workspaceKey(repository) : null);
  }

  const result: WorkspaceRuns = {};
  for (const [owner, ids] of Object.entries(cached)) {
    for (const id of ids) {
      // An unbound Run must not inherit whichever workspace bootstrapped it.
      if (ownerByRun.has(id) && ownerByRun.get(id) !== owner) continue;
      (result[owner] ??= []).push(id);
    }
  }

  const discoveredByOwner = new Map<string, string[]>();
  for (const id of discovered) {
    const owner = ownerByRun.get(id);
    if (!owner) continue;
    const ids = discoveredByOwner.get(owner) ?? [];
    if (!discoveredByOwner.has(owner)) discoveredByOwner.set(owner, ids);
    ids.push(id);
  }
  for (const [owner, ids] of discoveredByOwner) {
    const existing = new Set(result[owner] ?? []);
    const prefix = ids.filter(id => !existing.has(id));
    if (prefix.length > 0) result[owner] = [...prefix, ...(result[owner] ?? [])];
  }
  return result;
}
