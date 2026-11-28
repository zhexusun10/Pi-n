import type { ChatMessage, GraphEvent } from "../types";
import { plannerContentSteerId } from "./plannerText";
import { createUuid } from "../lib/uuid";

export type PlannerSteerStatus = "submitting" | "submitted" | "queued" | "accepted" | "consumed" | "handled" | "failed" | "unknown" | "withdrawn";
export interface PlannerSteerRow { id: string; planningId?: string; message: ChatMessage; status: PlannerSteerStatus; error?: string }

/** Steer delivery identity describes one submitted request. A copy that starts
 * a new turn (an edit, an activated version, or a restored branch) must not keep
 * either Planner or Node identity, or it could alias the old pending/withdrawn turn. */
export function withoutPlannerSteerIdentity<T extends ChatMessage>(message: T): T {
  if (!message.plannerSteerId && !message.steerRequestId) return message;
  const { plannerSteerId: _id, plannerSteerStatus: _status, plannerSteerError: _error, steerRequestId: _nodeId, ...rest } = message;
  return rest as T;
}

/** A live execution edit/version resend is a new delivery, not the old turn's
 * transport identity or its display occurrence. Keep history/version fields. */
export function newExecutionSteer(message: ChatMessage, executionId: string, requestId = createUuid()): ChatMessage {
  const { steerOrdinal: _ordinal, inlineSteerOrdinal: _inlineOrdinal, ...copy } = withoutPlannerSteerIdentity(message);
  return { ...copy, delivery: "steered", executionId, steerRequestId: requestId };
}

/** Who owns the text of a Planner steer send. Exactly one surface may show an
 * instruction: the composer keeps one the Planner did not record (so it can be
 * edited and resent), while a recorded submission keeps its pending card and
 * clears the input. A failed RPC is a rejection, not a delivery. */
export function plannerSteerOwner(send: { recorded: boolean; status?: string }): "composer" | "pending" {
  if (!send.recorded) return "composer";
  return send.status === "failed" ? "composer" : "pending";
}

const PLANNER_TURN_EVENTS = new Set([
  "created", "graph_revised", "planner_workspace_selected",
  "planner_review_started", "planner_turn_aborted",
]);

function abandonedPlannerSteerIds(events: readonly GraphEvent[]): Set<string> {
  const abandoned = new Set<string>();
  for (let editIndex = 0; editIndex < events.length; editIndex += 1) {
    const edit = events[editIndex];
    if (edit.type !== "planner_conversation_edited") continue;
    if (edit.first_turn) {
      for (let i = 0; i < editIndex; i += 1) {
        if (events[i].type === "planner_steer_submitted" && events[i].request_id) {
          abandoned.add(events[i].request_id!);
        }
      }
      continue;
    }
    const target = edit.old_instruction?.trim();
    if (!target) continue;
    let startIndex = -1;
    let matchedPlanningId: string | undefined;
    for (let i = editIndex - 1; i >= 0; i -= 1) {
      const item = events[i];
      if (item.type === "planner_steer_submitted" && item.instruction?.trim() === target) {
        startIndex = i;
        break;
      }
      if (item.type && PLANNER_TURN_EVENTS.has(item.type) && item.planning?.goal?.trim() === target) {
        startIndex = i;
        matchedPlanningId = item.planning_id || item.planning?.planningId;
        break;
      }
    }
    if (startIndex < 0) continue;
    for (let i = 0; i < editIndex; i += 1) {
      const item = events[i];
      if (item.type !== "planner_steer_submitted" || !item.request_id) continue;
      if (i >= startIndex || (matchedPlanningId && item.planning_id === matchedPlanningId)) {
        abandoned.add(item.request_id);
      }
    }
  }
  return abandoned;
}

/** Fold durable status evidence by request ID, never by instruction text. */
export function plannerSteerRows(events: readonly GraphEvent[], messages: readonly ChatMessage[], options: {
  planning: boolean; activePlanningId?: string; visibleIds: ReadonlySet<string>;
  /** Requests whose text this client returned to the composer after the send
   * was rejected. The draft owns that instruction; the durable submission must
   * not render a second copy of it. */
  revertedIds?: ReadonlySet<string>;
}): PlannerSteerRow[] {
  const abandoned = abandonedPlannerSteerIds(events);
  const rows = new Map<string, PlannerSteerRow>();
  const local = new Map(messages.filter(message => message.plannerSteerId).map(message => [message.plannerSteerId!, message]));
  for (const event of events) {
    const id = event.request_id;
    if (!id || abandoned.has(id)) continue;
    if (event.type === "planner_steer_submitted") {
      const message = local.get(id) ?? { id: `msg-${id}`, role: "user" as const, text: event.instruction || "",
        images: event.images, timestamp: event.timestamp, plannerSteerId: id };
      rows.set(id, { id, planningId: event.planning_id, message, status: "submitted" });
    } else if (event.type === "planner_steer_status") {
      const row = rows.get(id);
      if (row && ["queued", "accepted", "consumed", "handled", "failed", "unknown", "withdrawn"].includes(event.status || "")) {
        row.status = event.status as PlannerSteerStatus;
        row.error = event.error;
      }
    }
  }
  for (const [id, message] of local) {
    if (!abandoned.has(id) && !rows.has(id)) {
      rows.set(id, { id, message, status: message.plannerSteerStatus ?? "submitting", error: message.plannerSteerError });
    }
  }
  return [...rows.values()].flatMap(row => {
    if (row.status === "withdrawn" || options.visibleIds.has(row.id)) return [];
    // A steer the send returned to the composer left no turn in the
    // conversation, so rebuilding its bubble from the durable submission would
    // show the same instruction in the pending area and in the input.
    if (options.revertedIds?.has(row.id)) return [];
    if (row.status === "consumed") {
      // The durable transcript owns a consumed turn. Keep a local handoff bubble
      // only while the turn is still live and its exact row has not rendered;
      // once the turn settles, a tail window that starts after the steer must
      // not leave a stale "taken by Planner" card at the bottom.
      if (!local.has(row.id) || !options.planning) return [];
    } else if (["submitting", "submitted", "queued", "accepted"].includes(row.status) &&
      (!options.planning || (row.planningId && options.activePlanningId && row.planningId !== options.activePlanningId))) {
      row = { ...row, status: "unknown" };
    }
    return [row];
  });
}

export function planningOutputSteerIds(output: string): Set<string> {
  const ids = new Set<string>();
  for (const line of output.split("\n")) {
    // queue_update and aggregate events can contain the marker before Pi takes
    // the turn. Only a user row that the transcript renders proves handoff.
    if (!line.includes("pi-n-steer-id")) continue;
    try {
      const event = JSON.parse(line);
      if (!["message_start", "message_end", "message"].includes(event.type) || event.message?.role !== "user") continue;
      const id = plannerContentSteerId(event.message.content);
      if (id) ids.add(id);
    } catch { /* A live or paged JSONL record may still be incomplete. */ }
  }
  return ids;
}
