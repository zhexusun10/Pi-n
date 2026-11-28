// Planner output filtering logic
// Extracted for use in tests without requiring TSX support
import { plannerContentText, stripPlannerContext } from "../services/plannerText";

export type PlannerEvent = {
  type?: string;
  planning_id?: string;
  old_instruction?: string;
  first_turn?: boolean;
  from_message_timestamp?: number;
  from_occurrence?: number;
  planning?: { planningId?: string; createdAt?: number; goal?: string } | null;
};

/** Planner attempts whose durable output belongs to the Run conversation.
 *
 * Session metrics reuse this set and add progress events, because they also
 * time a turn before it reaches one of these settled/committed records. */
export const PLANNER_TURN_EVENTS: ReadonlySet<string> = new Set([
  "created", "graph_revised", "planner_review_started", "planner_turn_aborted",
]);

/**
 * Planning attempts whose durable output belongs to the Run conversation, in
 * conversation order. Committed turns arrive as `created`/`graph_revised`,
 * background reviews as `planner_review_started`, and aborted revision turns
 * (failed, stopped or interrupted before committing a graph) as
 * `planner_turn_aborted`. Recovery records an interrupted turn when the backend
 * restarts, after later turns, so order falls back to the attempt start time.
 */
/** Post-task review attempts, in event order. A review continues the Planner
 * conversation but is a new section of it, so the saved transcript separates
 * its durable output from the turns that produced the published graph.
 * Ordinary revisions and follow-ups continue the conversation without one. */
export function reviewPlanningIds(events: ReadonlyArray<PlannerEvent>): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type !== "planner_review_started") continue;
    const id = event.planning_id || event.planning?.planningId;
    if (id) ids.add(id);
  }
  return ids;
}

export function plannerTurnIds(events: ReadonlyArray<PlannerEvent>): string[] {
  const turns: Array<{ id: string; createdAt: number; index: number }> = [];
  const seen = new Set<string>();
  for (const [index, event] of events.entries()) {
    if (!event.type || !PLANNER_TURN_EVENTS.has(event.type)) continue;
    const id = event.planning_id || event.planning?.planningId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    turns.push({ id, createdAt: event.planning?.createdAt ?? 0, index });
  }
  return turns.sort((a, b) => (a.createdAt - b.createdAt) || (a.index - b.index)).map(turn => turn.id);
}

/** Durable Planner revisions whose JSONL is replayed as conversation history.
 *
 * A live Planner transcript already renders the attempt it owns. Replaying
 * that attempt's growing JSONL at the same time duplicates its user turn,
 * thinking and tools. Fully committed turns stay in history, including during
 * a continuation. `savedPlannerId` may still name the last completed turn
 * until the backend announces the new revision, so only attempts that are not
 * committed yet are withheld from the replay.
 */
export function plannerHistoryIds(options: {
  events: ReadonlyArray<PlannerEvent>;
  savedPlannerId?: string;
  planning: boolean;
  live: boolean;
  continuation: boolean;
  backgroundReview: boolean;
  recoveredPlanningId?: string;
  routeType: string;
  representedIds?: ReadonlyArray<string>;
}): string[] {
  const { events, savedPlannerId, planning, live, continuation, backgroundReview,
    recoveredPlanningId, routeType } = options;
  // Recovery discovers the planning ID before the route is known. Mount the
  // durable activity poller now, rather than waiting for the finished graph.
  // A review turn belongs to an existing Planner conversation even while its
  // stage/recovery markers are still catching up, so it must keep prior turns.
  const reviewTurn = events.some(event => event.type === "planner_review_started");
  if ((!recoveredPlanningId && routeType !== "graph") ||
    (planning && !backgroundReview && !recoveredPlanningId && !continuation && !reviewTurn)) return [];
  const completed = plannerTurnIds(events);
  const committed = new Set(completed);
  const ids = savedPlannerId ? [...completed, savedPlannerId] : completed;
  // The live stream owns exactly the uncommitted attempt named by the snapshot.
  const streamingId = planning && live && savedPlannerId && !committed.has(savedPlannerId)
    ? savedPlannerId : "";
  const represented = options.representedIds ?? [];
  const seen = new Set<string>();
  return ids.filter(id => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (id === streamingId) return false;
    // Only suppress a durable turn while it is actively streaming. Once
    // planning stops, the JSONL is authoritative even if SSE was partial.
    // A continuation keeps earlier represented turns; only its new revision is live.
    if (!continuation && planning && live && (id === savedPlannerId || represented.includes(id))) {
      return false;
    }
    return true;
  });
}

/** Map each edited Planner turn to the attempt that replaced it.
 *
 * A replacement branch is durable before it commits a graph: it starts with
 * `planner_workspace_selected` and may end as `planner_turn_aborted`. Mapping
 * only `graph_revised` would cut a failed replacement (and all later turns)
 * out of the replayed conversation.
 */
export interface PlannerEdit {
  old_instruction?: string;
  nextPlanningId?: string;
  /** True when the edit replaced the conversation's opening goal. */
  firstTurn?: boolean;
  /** Planning IDs known from durable event goals to be abandoned by this edit. */
  abandonedPlanningIds?: string[];
  /** Pi timestamp of the abandoned user turn; replayed rows carry it too. */
  fromMessageTimestamp?: number;
  /** Position among equal-text user turns of the whole session tree. */
  fromOccurrence?: number;
}

export function plannerConversationEdits(events: ReadonlyArray<PlannerEvent>): PlannerEdit[] {
  return events.flatMap((event, index) => {
    if (event.type !== "planner_conversation_edited") return [];
    const next = events.slice(index + 1).find(item =>
      item.type === "graph_revised" || item.type === "planner_workspace_selected"
      || item.type === "planner_review_started" || item.type === "planner_turn_aborted");
    let abandonedPlanningIds: string[] | undefined;
    if (!event.first_turn && event.old_instruction) {
      const target = event.old_instruction.trim();
      let startIndex = -1;
      for (let i = index - 1; i >= 0; i -= 1) {
        const prior = events[i];
        if (prior.type && PLANNER_TURN_EVENTS.has(prior.type) && prior.planning?.goal?.trim() === target) {
          startIndex = i;
          break;
        }
      }
      if (startIndex >= 0) {
        const ids = new Set<string>();
        for (let i = startIndex; i < index; i += 1) {
          const prior = events[i];
          if (!prior.type || !PLANNER_TURN_EVENTS.has(prior.type)) continue;
          const id = prior.planning_id || prior.planning?.planningId;
          if (id) ids.add(id);
        }
        if (ids.size > 0) abandonedPlanningIds = [...ids];
      }
    }
    return [{ old_instruction: event.old_instruction,
      nextPlanningId: next?.planning_id || next?.planning?.planningId,
      ...(event.first_turn ? { firstTurn: true } : {}),
      ...(abandonedPlanningIds ? { abandonedPlanningIds } : {}),
      ...(event.from_message_timestamp !== undefined ? { fromMessageTimestamp: event.from_message_timestamp } : {}),
      ...(event.from_occurrence !== undefined ? { fromOccurrence: event.from_occurrence } : {}) }];
  });
}

interface PlannerUserRow { line: number; text: string; timestamp?: number; segmentStart: number }
interface PlannerSourceSegment { line: number; planningId: string }

function plannerSourceSegments(lines: readonly string[]): PlannerSourceSegment[] {
  const segments: PlannerSourceSegment[] = [];
  lines.forEach((line, index) => {
    if (!line.startsWith('{"type":"pi_n_planning_source"')) return;
    try {
      const marker = JSON.parse(line);
      if (marker.type === "pi_n_planning_source" && typeof marker.planningId === "string") {
        segments.push({ line: index, planningId: marker.planningId });
      }
    } catch { /* Ignore malformed marker line. */ }
  });
  return segments;
}

/** One row per user turn, in log order. A start/end pair counts once and each
 * planning source restarts the pairing, exactly like `plannerUserTurns`. */
function plannerUserRows(lines: readonly string[]): PlannerUserRow[] {
  const rows: PlannerUserRow[] = [];
  const started = new Set<string>();
  let pendingStart = false;
  let segmentStart = 0;
  lines.forEach((line, index) => {
    if (line.startsWith('{"type":"pi_n_planning_source"')) { pendingStart = false; started.clear(); segmentStart = index; return; }
    if (!line.includes('"message_start"') && !line.includes('"message_end"')) return;
    try {
      const event = JSON.parse(line);
      if ((event.type !== "message_start" && event.type !== "message_end") || event.message?.role !== "user") return;
      const id = event.message.id;
      if (event.type === "message_end") {
        if (pendingStart || (id && started.has(id))) { pendingStart = false; return; }
      } else {
        pendingStart = true;
        if (id) started.add(id);
      }
      const timestamp = typeof event.message.timestamp === "number" ? event.message.timestamp : undefined;
      rows.push({ line: index, text: stripPlannerContext(plannerContentText(event.message.content)), timestamp, segmentStart });
    } catch { /* Incomplete JSONL lines are still being written. */ }
  });
  return rows;
}

/** Occurrence counts cover the whole log, so they only apply when the output
 * demonstrably starts at the conversation's first revision. */
function startsAtConversationBeginning(lines: readonly string[], firstPlanningId?: string): boolean {
  if (!firstPlanningId) return false;
  try {
    const marker = JSON.parse(lines[0]);
    return marker.type === "pi_n_planning_source" && marker.planningId === firstPlanningId && marker.startOffset === 0;
  } catch { return false; }
}

export function activePlannerOutput(
  output: string,
  edits: PlannerEdit[],
  options: { firstPlanningId?: string; planningIds?: readonly string[] } = {},
): string {
  if (!edits.some(edit => edit.old_instruction || edit.firstTurn)) return output;
  const lines = output.split("\n");
  const removed = new Array<boolean>(lines.length).fill(false);
  const segments = plannerSourceSegments(lines);
  const rows = plannerUserRows(lines);
  const complete = startsAtConversationBeginning(lines, options.firstPlanningId ?? options.planningIds?.[0]);
  for (const edit of edits) {
    if (!edit.old_instruction && !edit.firstTurn) continue;
    const old = edit.old_instruction ?? "";
    const matches = (row: PlannerUserRow) => Boolean(old) && (row.text === old || row.text.endsWith(`\n${old}`));
    const textual = rows.filter(matches);
    // Identity first: the durable turn timestamp, then its tree position. Only
    // when neither resolves (legacy events, or rows without a timestamp) does it
    // fall back to the first equal-text active row.
    const row = (edit.fromMessageTimestamp !== undefined
        ? rows.find(item => item.timestamp === edit.fromMessageTimestamp) : undefined)
      ?? (edit.fromOccurrence !== undefined && complete ? textual[edit.fromOccurrence] : undefined)
      ?? textual.find(item => !removed[item.line]);
    if (row) {
      if (removed[row.line]) continue;
      const resume = edit.nextPlanningId ? lines.findIndex((line, index) => index > row.line &&
        line.includes(`"type":"pi_n_planning_source"`) && line.includes(`"planningId":"${edit.nextPlanningId}"`)) : -1;
      for (let index = row.line; index < (resume >= 0 ? resume : lines.length); index++) removed[index] = true;
      continue;
    }
    // In a paged tail window the edited turn may not be loaded yet, while later
    // abandoned turns before `nextPlanningId` already are. Prune them without
    // touching segments that started after the replacement revision.
    const resume = edit.nextPlanningId
      ? segments.find(segment => segment.planningId === edit.nextPlanningId)?.line ?? -1
      : -1;
    let beforeResumeEnd = -1;
    if (resume >= 0) {
      beforeResumeEnd = resume;
    } else if (!edit.nextPlanningId) {
      beforeResumeEnd = lines.length;
    } else if (options.planningIds && segments.length > 0) {
      const nextPos = options.planningIds.indexOf(edit.nextPlanningId);
      const firstPos = options.planningIds.indexOf(segments[0].planningId);
      if (nextPos >= 0 && firstPos >= 0 && firstPos < nextPos) {
        beforeResumeEnd = lines.length;
      }
    }
    if (beforeResumeEnd <= 0) continue;
    if (edit.firstTurn) {
      for (let index = 0; index < beforeResumeEnd; index++) removed[index] = true;
      continue;
    }
    let cutStart = beforeResumeEnd;
    if (edit.fromMessageTimestamp !== undefined) {
      const laterRow = rows.find(item =>
        item.line < beforeResumeEnd && !removed[item.line] &&
        item.timestamp !== undefined && item.timestamp > edit.fromMessageTimestamp!,
      );
      if (laterRow) {
        const hasEarlierRowInSegment = rows.some(item =>
          item.segmentStart === laterRow.segmentStart && item.line < laterRow.line,
        );
        cutStart = Math.min(cutStart, hasEarlierRowInSegment ? laterRow.line : laterRow.segmentStart);
      }
    }
    if (edit.abandonedPlanningIds?.length) {
      const abandonedSet = new Set(edit.abandonedPlanningIds);
      const abandonedSegment = segments.find(segment =>
        segment.line < beforeResumeEnd && !removed[segment.line] && abandonedSet.has(segment.planningId),
      );
      if (abandonedSegment) {
        cutStart = Math.min(cutStart, abandonedSegment.line);
      }
    }
    for (let index = cutStart; index < beforeResumeEnd; index++) removed[index] = true;
  }
  return lines.filter((_, index) => !removed[index]).join("\n");
}
