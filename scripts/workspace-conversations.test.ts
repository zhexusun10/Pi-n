import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig, emptySnapshot, type Snapshot } from "../src/types.ts";
import {
  bindRunToWorkspace,
  mergeValidatedWorkspaceRuns,
  normalizeWorkspaceRuns,
  orderProjects,
  pinRunInWorkspace,
  promoteRunInWorkspace,
  reconcileWorkspaceRuns,
  reorderRunsInWorkspace,
  reorderSubset,
  snapshotBelongsToWorkspace,
  unpinRunInWorkspace,
  workspaceKey,
  workspaceRunsFromSummaries,
} from "../src/services/workspaceConversations.ts";

const snapshot = (runId: string, repository: string): Snapshot => ({
  ...emptySnapshot, runId, config: { ...defaultConfig, repository },
});

test("authoritative summaries preserve backend order and normalize workspace ownership", () => {
  const summaries = [
    { runId: "newest", repository: "\\\\?\\C:\\Projects\\App\\", title: "Newest" },
    { runId: "foreign", repository: "/other", title: "Other" },
    { runId: "older", repository: "c:/projects/app", title: "" },
    { runId: "newest", repository: "/wrong", title: "Duplicate" },
    { runId: "pending-old", repository: "/other", title: "Provisional" },
    { runId: "unbound", repository: "", title: "Unbound" },
  ];
  assert.deepEqual(workspaceRunsFromSummaries(summaries), {
    "c:/projects/app": ["newest", "older"], "/other": ["foreign"],
  });
  assert.deepEqual(workspaceRunsFromSummaries([]), {}, "an empty backend list is authoritative");
});

test("failed summary reads preserve only explicitly unavailable cached IDs", () => {
  assert.deepEqual(workspaceRunsFromSummaries([
    { runId: "healthy", repository: "/actual", title: "Healthy" },
  ], {
    "/cached": ["damaged", "healthy", "deleted", "pending-old"],
    "/duplicate": ["damaged"],
  }, ["damaged", "healthy", "pending-old"]), {
    "/actual": ["healthy"], "/cached": ["damaged"],
  });
});

test("Windows path aliases and UNC prefixes resolve to the same workspace", () => {
  assert.equal(workspaceKey("\\\\?\\C:\\Projects\\App\\"), workspaceKey("c:/projects/app"));
  assert.equal(workspaceKey("\\\\?\\UNC\\Server\\Share\\App"), workspaceKey("\\\\server\\share\\app\\"));
  assert.notEqual(workspaceKey("/work/App"), workspaceKey("/work/app"));
  assert.equal(workspaceKey("/"), "/");
});

test("legacy path keys merge without duplicate cards or default-workspace ownership", () => {
  assert.deepEqual(normalizeWorkspaceRuns({
    "C:\\Projects\\App": ["a", "b"], "\\\\?\\C:\\Projects\\App\\": ["b", "c"], default: ["foreign"],
  }), { "c:/projects/app": ["a", "b", "c"] });
});

test("a Run has exactly one workspace even when cached in multiple workspaces", () => {
  const original = { "/a": ["a", "b"], "/b": ["a", "b"] };
  const repaired = bindRunToWorkspace(original, "a", "/a");
  assert.deepEqual(repaired, { "/a": ["a", "b"], "/b": ["b"] });
  assert.deepEqual(original, { "/a": ["a", "b"], "/b": ["a", "b"] }, "must not mutate React state");
  assert.equal(bindRunToWorkspace(repaired, "a", "/a"), repaired, "repeated observations are stable");
});

test("detached planning replaces its provisional ID in the originating workspace", () => {
  assert.deepEqual(bindRunToWorkspace({ "/a": ["newer", "pending-1", "older"], "/b": ["b", "pending-1"] }, "real-a", "/a", "pending-1"), {
    "/a": ["newer", "real-a", "older"], "/b": ["b"],
  });
});

test("repeated detached completion events do not reorder an already replaced card", () => {
  const index = { "/a": ["newer", "real-a", "older"], "/b": ["b"] };
  assert.equal(bindRunToWorkspace(index, "real-a", "/a", "pending-1"), index);
});

test("bootstrap repairs already indexed foreign Runs and discovers missing histories", () => {
  const repaired = reconcileWorkspaceRuns({ "/a": ["a", "b", "pending-old"], "/b": ["a", "b"], default: ["unbound"] }, [
    snapshot("a", "/a"), snapshot("b", "/b"), snapshot("new-b", "/b"), snapshot("unbound", ""),
  ]);
  assert.deepEqual(repaired, { "/a": ["a"], "/b": ["new-b", "b"] });
});

test("cold bootstrap keeps the backend's newest-first order instead of reversing it", () => {
  assert.deepEqual(reconcileWorkspaceRuns({}, [snapshot("newest", "/a"), snapshot("middle", "/a"), snapshot("oldest", "/a")]), {
    "/a": ["newest", "middle", "oldest"],
  });
});

test("newly discovered Runs are inserted ahead of cached cards without reordering the cache", () => {
  assert.deepEqual(reconcileWorkspaceRuns({ "/a": ["cached-newer", "cached-older"] }, [
    snapshot("fresh-1", "/a"), snapshot("fresh-2", "/a"), snapshot("cached-newer", "/a"), snapshot("cached-older", "/a"),
  ]), { "/a": ["fresh-1", "fresh-2", "cached-newer", "cached-older"] });
});

test("unavailable history does not discard cached conversations; unbound histories cannot inherit a workspace", () => {
  assert.deepEqual(reconcileWorkspaceRuns({ "/a": ["offline", "unbound"] }, [null, snapshot("unbound", "")]), { "/a": ["offline"] });
  const original = { "/a": ["a"] };
  assert.equal(bindRunToWorkspace(original, "unbound", ""), original);
});

test("progressive validation keeps warm cards whose histories are not in the current batch", () => {
  const cached = { "/a": ["a", "b", "c", "d"] };
  const firstBatch = { "/a": ["a"] };
  assert.deepEqual(mergeValidatedWorkspaceRuns(cached, firstBatch), cached);
  // Only a later batch may speak for the cards it actually validated.
  assert.deepEqual(mergeValidatedWorkspaceRuns({ "/a": ["a", "b", "c", "d"] }, { "/a": ["a", "b"] }), { "/a": ["a", "b", "c", "d"] });
  assert.deepEqual(cached, { "/a": ["a", "b", "c", "d"] }, "must not mutate React state");
});

test("progressive validation moves a proven card without dropping unreported cards", () => {
  assert.deepEqual(mergeValidatedWorkspaceRuns({ "/a": ["a", "b"], "/b": ["b"] }, { "/b": ["b"] }), {
    "/a": ["a"], "/b": ["b"],
  });
  assert.deepEqual(mergeValidatedWorkspaceRuns({ "/a": ["cached"] }, { "/a": ["cached", "new"] }), {
    "/a": ["cached", "new"],
  });
});

test("opening a card validates snapshot ownership independently of the selected workspace", () => {
  assert.equal(snapshotBelongsToWorkspace(snapshot("a", "C:\\Projects\\A"), "\\\\?\\c:\\projects\\a\\"), true);
  assert.equal(snapshotBelongsToWorkspace(snapshot("a", "/a"), "/b"), false);
  assert.equal(snapshotBelongsToWorkspace(emptySnapshot, ""), false);
});

test("promoting a conversation moves it to the first position and enforces exclusive ownership", () => {
  const original = { "c:/projects/app": ["newest", "middle", "older"], "/other": ["older", "foreign"] };
  const promoted = promoteRunInWorkspace(original, "older", "\\\\?\\C:\\Projects\\App\\");
  assert.deepEqual(promoted, {
    "c:/projects/app": ["older", "newest", "middle"],
    "/other": ["foreign"],
  });
  assert.deepEqual(original, { "c:/projects/app": ["newest", "middle", "older"], "/other": ["older", "foreign"] }, "must not mutate React state");
  assert.equal(promoteRunInWorkspace(promoted, "older", "c:/projects/app"), promoted, "already-first unique card is stable");
  assert.deepEqual(promoteRunInWorkspace(promoted, "fresh", "c:/projects/app"), {
    "c:/projects/app": ["fresh", "older", "newest", "middle"],
    "/other": ["foreign"],
  });
  assert.equal(promoteRunInWorkspace(promoted, "", "c:/projects/app"), promoted);
  assert.equal(promoteRunInWorkspace(promoted, "older", ""), promoted);
});

test("pinned conversations stay at the top and are never pushed down by new or promoted conversations", () => {
  const initial = { "/a": ["c3", "c2", "c1"] };
  const pinned1 = new Set(["c1"]);
  const afterPin1 = pinRunInWorkspace(initial, "c1", "/a", pinned1);
  assert.deepEqual(afterPin1, { "/a": ["c1", "c3", "c2"] });

  const pinned2 = new Set(["c1", "c2"]);
  const afterPin2 = pinRunInWorkspace(afterPin1, "c2", "/a", pinned2);
  assert.deepEqual(afterPin2, { "/a": ["c2", "c1", "c3"] });

  // New provisional conversation inserts below pinned cards, then adopts durable ID in place.
  const withPending = bindRunToWorkspace(afterPin2, "pending-1", "/a", undefined, pinned2);
  assert.deepEqual(withPending, { "/a": ["c2", "c1", "pending-1", "c3"] });
  const withDurable = bindRunToWorkspace(withPending, "c4", "/a", "pending-1", pinned2);
  assert.deepEqual(withDurable, { "/a": ["c2", "c1", "c4", "c3"] });

  // Promoting an unpinned conversation moves it to the top of unpinned (below pinned).
  const promotedUnpinned = promoteRunInWorkspace(withDurable, "c3", "/a", pinned2);
  assert.deepEqual(promotedUnpinned, { "/a": ["c2", "c1", "c3", "c4"] });

  // Promoting an already pinned conversation keeps pinned cards in their order.
  assert.equal(promoteRunInWorkspace(promotedUnpinned, "c1", "/a", pinned2), promotedUnpinned);

  // Unpinning c2 moves it below remaining pinned card c1.
  const remainingPinned = new Set(["c1"]);
  const afterUnpin = unpinRunInWorkspace(promotedUnpinned, "c2", "/a", remainingPinned);
  assert.deepEqual(afterUnpin, { "/a": ["c1", "c2", "c3", "c4"] });
});

test("reordering and reload reconciliation preserve custom order and pinned conversations", () => {
  const pinned = new Set(["c1"]);
  const index = { "/a": ["c1", "arch", "c3", "c2"] };
  // Reordering visible active runs leaves archived runs untouched and preserves pinned grouping.
  const reordered = reorderRunsInWorkspace(index, "/a", ["c1", "c3", "c2"], 2, 1, pinned);
  assert.deepEqual(reordered, { "/a": ["c1", "arch", "c2", "c3"] });

  // On bootstrap reload, custom order and pinned runs survive while newly discovered runs insert after pinned.
  const summaries = [
    { runId: "fresh", repository: "/a", title: "Fresh" },
    { runId: "c3", repository: "/a", title: "C3" },
    { runId: "c2", repository: "/a", title: "C2" },
    { runId: "c1", repository: "/a", title: "C1" },
  ];
  assert.deepEqual(
    workspaceRunsFromSummaries(summaries, {}, [], pinned, { "/a": ["c1", "c2", "c3"] }),
    { "/a": ["c1", "fresh", "c2", "c3"] },
  );

  // Workspace ordering falls back to lastOpened unless explicit drag order exists.
  const projects = [
    { id: "/p1", path: "/p1", name: "P1", branch: "", clean: true, lastOpened: 10 },
    { id: "/p2", path: "/p2", name: "P2", branch: "", clean: true, lastOpened: 30 },
    { id: "/p3", path: "/p3", name: "P3", branch: "", clean: true, lastOpened: 20, archived: true },
  ];
  assert.deepEqual(orderProjects(projects).map(p => p.path), ["/p2", "/p3", "/p1"]);
  assert.deepEqual(orderProjects(projects, ["/p1", "/p2", "/p3"]).map(p => p.path), ["/p1", "/p2", "/p3"]);
  assert.deepEqual(
    reorderSubset(projects, ["/p1", "/p2"], 1, 0, p => p.path).map(p => p.path),
    ["/p2", "/p1", "/p3"],
  );
});
