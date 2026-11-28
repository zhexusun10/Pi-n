import type { ChatMessage, ChatMessageVersion, Execution, FileAttachment, GraphEvent, Snapshot } from "../types";
import { withoutPlannerSteerIdentity } from "./plannerSteers";

export function stripNodePrefix(text: string): string {
  return text.replace(/^\[@[^\]]+\]\s*/, "").trim();
}

function editBoundary(edit: GraphEvent, node: string | undefined, events: readonly GraphEvent[]): number {
  if (!node || edit.target === node) return edit.from_event_sequence ?? edit.sequence;
  // An upstream edit invalidates descendant turns after its anchor. Event
  // sequences distinguish turns recorded in the same millisecond.
  return events.find(event => event.type === "started" &&
    event.execution?.id === edit.from_execution_id)?.sequence ?? edit.sequence;
}

function isEventAbandonedByEdit(event: GraphEvent, from: number, to: number, node?: string): boolean {
  return event.sequence >= from && event.sequence < to &&
    (!node || event.node === node || event.target === node);
}

function collectEventChainIdentities(
  start: GraphEvent | undefined,
  events: readonly GraphEvent[],
  ids: Set<string>,
  requests: Set<string>,
): void {
  const visited = new Set<number>();
  let cursor = start;
  while (cursor && !visited.has(cursor.sequence) &&
      ["invalidated", "node_messaged", "steered", "conversation_edited"].includes(cursor.type)) {
    visited.add(cursor.sequence);
    ids.add(`event-${cursor.sequence}`);
    if (cursor.request_id) {
      requests.add(cursor.request_id);
      ids.add(`msg-${cursor.request_id}`);
    }
    cursor = cursor.type === "conversation_edited"
      ? events.find(event => event.sequence === cursor?.from_event_sequence) : undefined;
  }
}

export function localMessagesAfterEdit(
  messages: ChatMessage[],
  edit: GraphEvent,
  events: GraphEvent[],
  keepOpening = false,
  node = edit.target,
): ChatMessage[] {
  const sourceIds = new Set<string>();
  const sourceRequests = new Set<string>();
  collectEventChainIdentities(
    events.find(event => event.sequence === edit.from_event_sequence),
    events,
    sourceIds,
    sourceRequests,
  );
  const abandonedIds = new Set<string>();
  const abandonedRequests = new Set<string>();
  const priorRequests = new Set<string>();
  const laterIds = new Set<string>();
  const from = editBoundary(edit, node, events);
  for (const event of events) {
    if (isEventAbandonedByEdit(event, from, edit.sequence, node)) {
      collectEventChainIdentities(event, events, abandonedIds, abandonedRequests);
    }
    if (event.sequence < edit.sequence && event.request_id) priorRequests.add(event.request_id);
    if (event.sequence > edit.sequence && (!node || event.node === node || event.target === node) &&
      ["invalidated", "node_messaged", "steered", "conversation_edited"].includes(event.type)) {
      laterIds.add(`event-${event.sequence}`);
      if (event.request_id) laterIds.add(`msg-${event.request_id}`);
    }
  }
  // A later edited copy can retain its display ID after it drops the request ID.
  const isPostEditMessage = (message: ChatMessage) =>
    laterIds.has(message.id) || Boolean(message.steerRequestId && !priorRequests.has(message.steerRequestId));
  const isActiveReplacement = (message: ChatMessage) =>
    edit.target === node &&
    Boolean(edit.instruction) &&
    stripNodePrefix(message.text) === stripNodePrefix(edit.instruction ?? "") &&
    (sourceIds.has(message.id) || Boolean(message.steerRequestId && sourceRequests.has(message.steerRequestId)));
  const matchesAbandonedEvent = (message: ChatMessage) =>
    !isActiveReplacement(message) &&
    (abandonedIds.has(message.id) || Boolean(message.steerRequestId && abandonedRequests.has(message.steerRequestId)));
  // An edited copy keeps its display ID after retiring its transport identity.
  // Follow the durable edit chain to distinguish equal text in different turns.
  const boundary = edit.target === node && edit.old_instruction
    ? messages.findIndex(message => stripNodePrefix(message.text) === edit.old_instruction &&
      (!sourceIds.size || sourceIds.has(message.id) ||
        (message.steerRequestId && sourceRequests.has(message.steerRequestId))))
    : -1;
  const isFirstTurnCut = Boolean(edit.first_turn && edit.target === node);
  // A later receipt or an unacknowledged request is new input. Repeating the
  // pre-edit text cannot put that request in the discarded local suffix.
  const filtered = messages.filter((message, index) => {
    if (keepOpening && index === 0) return true;
    if (isPostEditMessage(message)) return true;
    if (isFirstTurnCut) return false;
    if (boundary >= 0 && index >= boundary + Number(keepOpening)) return false;
    if (matchesAbandonedEvent(message)) return false;
    return true;
  });
  return boundary >= 0 || filtered.length !== messages.length ? filtered : messages;
}

export function localMessagesAfterEdits(
  messages: ChatMessage[],
  events: GraphEvent[],
  node: string,
  preserveOpeningSlot = false,
  fromSequence = Number.NEGATIVE_INFINITY,
): ChatMessage[] {
  let retained = messages;
  for (const event of events) {
    if (retained.length === 0) break;
    if (event.sequence < fromSequence || event.type !== "conversation_edited") continue;
    if (event.target !== node && !event.nodes?.includes(node)) continue;
    retained = localMessagesAfterEdit(
      retained,
      event,
      events,
      Boolean(preserveOpeningSlot && event.first_turn),
      node,
    );
  }
  return retained;
}

function nodeFreshRestartBoundary(state: Snapshot, node: string): {
  freshBoundary: number;
  retainedMessages: Set<number>;
} {
  const superseded = new Set(state.supersededExecutionIds ?? []);
  const lineage = nodeConversationLineage(state, node);
  const starts = state.events.filter((event) => event.type === "started" && event.execution?.node === node
    && (!superseded.has(event.execution.id) || lineage.has(event.execution.id)));
  const freshBoundary = starts.reduce((oldest, event) => Math.min(oldest, event.sequence), Number.POSITIVE_INFINITY);
  // A first dispatch claims input accepted before Started. Keep those turns
  // (and still-pending input), but never revive claims from an abandoned branch.
  const retainedMessages = new Set([
    ...starts.flatMap(event => event.message_sequences ?? []),
    ...(state.nodes[node]?.pendingMessages ?? []).map(message => message.sequence),
  ]);
  return { freshBoundary, retainedMessages };
}

function isEventDroppedByFreshRestart(
  event: GraphEvent,
  node: string,
  freshBoundary: number,
  retainedMessages: ReadonlySet<number>,
): boolean {
  if (!Number.isFinite(freshBoundary) || event.sequence >= freshBoundary) return false;
  const belongs = event.node === node || event.target === node;
  if (belongs && retainedMessages.has(event.sequence)) return false;
  if (event.type === "conversation_edited") return belongs;
  return event.type === "invalidated" || event.type === "node_messaged" || event.type === "steered";
}

export function activeLocalNodeMessages(
  messages: ChatMessage[],
  state: Snapshot,
  node: string,
  preserveOpeningSlot = false,
): ChatMessage[] {
  if (messages.length === 0) return messages;
  const { freshBoundary, retainedMessages } = nodeFreshRestartBoundary(state, node);
  if (!Number.isFinite(freshBoundary)) return localMessagesAfterEdits(messages, state.events, node, preserveOpeningSlot);
  // Earlier edits identify stale local entries below, but their cuts do not
  // apply to replacements in a different conversation after the restart.
  const afterEdits = localMessagesAfterEdits(messages, state.events, node, preserveOpeningSlot, freshBoundary);
  const droppedIds = new Set<string>();
  const droppedRequests = new Set<string>();
  for (const event of state.events) {
    const belongs = event.node === node || event.target === node;
    if (belongs && isEventDroppedByFreshRestart(event, node, freshBoundary, retainedMessages)) {
      collectEventChainIdentities(event, state.events, droppedIds, droppedRequests);
    }
  }
  if (!droppedIds.size && !droppedRequests.size) return afterEdits;
  const priorRequests = new Set(
    state.events.filter(event => event.sequence < freshBoundary && event.request_id).map(event => event.request_id),
  );
  const filtered = afterEdits.filter((message, index) => {
    if (preserveOpeningSlot && index === 0 && !message.node) return true;
    if (message.steerRequestId && !priorRequests.has(message.steerRequestId)) return true;
    if (droppedIds.has(message.id)) return false;
    if (message.steerRequestId && droppedRequests.has(message.steerRequestId)) return false;
    return true;
  });
  return filtered.length === afterEdits.length ? afterEdits : filtered;
}

export function sessionEntriesAfterNodeEdit(options: {
  entries: readonly ChatMessage[];
  snapshot: Snapshot;
  targetNode: string;
  targetMsg: ChatMessage;
  updatedMsg?: ChatMessage;
  fallbackEntries?: readonly ChatMessage[];
  previousEventSequence?: number;
  preEditIds?: ReadonlySet<string>;
  dropTargetNodeEntries?: boolean;
}): ChatMessage[] {
  const {
    entries,
    snapshot,
    targetNode,
    targetMsg,
    updatedMsg,
    fallbackEntries,
    previousEventSequence = Number.NEGATIVE_INFINITY,
    preEditIds,
    dropTargetNodeEntries = false,
  } = options;
  const latestEdit = [...snapshot.events].reverse().find(event =>
    event.type === "conversation_edited" &&
    event.target === targetNode &&
    event.sequence > previousEventSequence,
  );
  if (!latestEdit) {
    if (dropTargetNodeEntries) {
      return entries.filter(entry => entry.node !== targetNode);
    }
    if (fallbackEntries) return [...fallbackEntries];
    return updatedMsg ? [...entries, updatedMsg] : [...entries];
  }

  const affectedNodes = new Set(latestEdit.nodes?.length ? latestEdit.nodes : [targetNode]);
  const targetIndex = findBranchTargetIndex(entries, targetMsg);
  const preEditActiveIds = new Set<string>();
  const preEditActiveRequests = new Set<string>();
  if (targetIndex < 0) {
    for (const node of affectedNodes) {
      for (const event of activeNodeConversationEvents(snapshot, node)) {
        if (event.sequence < latestEdit.sequence) {
          collectEventChainIdentities(event, snapshot.events, preEditActiveIds, preEditActiveRequests);
        }
      }
    }
  }

  const priorRequests = new Set(
    snapshot.events
      .filter(event => event.sequence < latestEdit.sequence && event.request_id)
      .map(event => event.request_id),
  );
  const isPostEditEntry = (entry: ChatMessage) =>
    (preEditIds !== undefined && !preEditIds.has(entry.id)) ||
    Boolean(entry.steerRequestId && !priorRequests.has(entry.steerRequestId));

  const perNodeRetained = new Map<string, Set<ChatMessage>>();
  for (const node of affectedNodes) {
    const nodeEntries = entries.filter(entry =>
      entry.node === node && (!entry.runId || !snapshot.runId || entry.runId === snapshot.runId),
    );
    perNodeRetained.set(node, new Set(activeLocalNodeMessages(nodeEntries, snapshot, node)));
  }

  const next: ChatMessage[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.runId && snapshot.runId && entry.runId !== snapshot.runId) {
      next.push(entry);
      continue;
    }
    if (!entry.node) {
      if (latestEdit.first_turn && latestEdit.instruction && index === 0) {
        next.push({ ...entry, text: latestEdit.instruction });
      } else {
        next.push(entry);
      }
      continue;
    }
    if (!affectedNodes.has(entry.node)) {
      next.push(entry);
      continue;
    }
    if (isPostEditEntry(entry)) {
      next.push(entry);
      continue;
    }
    if (dropTargetNodeEntries || latestEdit.first_turn) continue;
    if (entry.node === targetNode && targetIndex >= 0 && index >= targetIndex) continue;
    if (!perNodeRetained.get(entry.node)?.has(entry)) continue;
    if (targetIndex < 0) {
      const matchesPreEditActive =
        preEditActiveIds.has(entry.id) ||
        Boolean(entry.steerRequestId && preEditActiveRequests.has(entry.steerRequestId));
      if (!matchesPreEditActive) continue;
    }
    next.push(entry);
  }

  if (updatedMsg && !dropTargetNodeEntries && !latestEdit.first_turn) {
    next.push({
      ...updatedMsg,
      node: targetNode,
      runId: snapshot.runId || updatedMsg.runId,
      steerRequestId: undefined,
    });
  }
  return next;
}

export function findBranchTargetIndex(
  entries: readonly ChatMessage[],
  targetMsg: Pick<ChatMessage, "id" | "text">,
  _cleanExisting?: string,
): number {
  // Equal text can belong to distinct turns; only the message ID identifies it.
  return targetMsg.id ? entries.findIndex(entry => entry.id === targetMsg.id) : -1;
}

export function applySelectedVersionToEntries(
  entries: readonly ChatMessage[],
  targetMsg: Pick<ChatMessage, "id" | "text">,
  cleanExisting: string | undefined,
  selectedMessage: ChatMessage,
  subsequentEntries: readonly ChatMessage[] | undefined,
  appendWhenMissing = false,
): ChatMessage[] {
  const index = findBranchTargetIndex(entries, targetMsg, cleanExisting);
  if (index < 0) return appendWhenMissing ? [...entries, selectedMessage] : [selectedMessage];
  const subsequent = (subsequentEntries ?? []).map(withoutPlannerSteerIdentity);
  return [...entries.slice(0, index), selectedMessage, ...subsequent];
}

export function branchEditedMessageEntries(
  entries: readonly ChatMessage[],
  targetMsg: ChatMessage,
  cleanExisting: string,
  cleanText: string,
  attachments: FileAttachment[] | undefined,
  transform: (msg: ChatMessage) => ChatMessage = msg => msg,
): { updatedMsg: ChatMessage; rolledBackEntries: ChatMessage[]; previousEntries: ChatMessage[] } {
  const now = Date.now();
  const targetIndex = findBranchTargetIndex(entries, targetMsg, cleanExisting);
  if (targetIndex !== -1) {
    const current = entries[targetIndex];
    const previousEntries = entries.slice(0, targetIndex);
    const parentId = previousEntries.length > 0 ? previousEntries[previousEntries.length - 1].id : null;
    const initialVersion: ChatMessageVersion = {
      id: "v1",
      text: current.text,
      files: current.files,
      images: current.images,
      timestamp: current.timestamp || now,
      subsequentEntries: entries.slice(targetIndex + 1),
    };
    const newVersion: ChatMessageVersion = {
      id: `v${now}`,
      text: cleanText,
      files: attachments,
      images: targetMsg.images,
      timestamp: now,
      subsequentEntries: [],
    };
    const versions = [...(current.versions || [initialVersion]), newVersion];
    const updatedMsg = transform({
      ...current,
      text: cleanText,
      files: attachments,
      timestamp: now,
      parentId,
      versions,
      currentVersionIndex: versions.length - 1,
    });
    return {
      updatedMsg,
      rolledBackEntries: [...previousEntries, updatedMsg],
      previousEntries,
    };
  }
  const versions: ChatMessageVersion[] = [
    ...(targetMsg.versions ?? [{
      id: "v1",
      text: targetMsg.text,
      files: targetMsg.files,
      images: targetMsg.images,
      timestamp: targetMsg.timestamp || now,
    }]),
    {
      id: `v${now}`,
      text: cleanText,
      files: attachments,
      images: targetMsg.images,
      timestamp: now,
      subsequentEntries: [],
    },
  ];
  const updatedMsg = transform({
    ...targetMsg,
    text: cleanText,
    files: attachments,
    timestamp: now,
    versions,
    currentVersionIndex: versions.length - 1,
  });
  return {
    updatedMsg,
    rolledBackEntries: [...entries, updatedMsg],
    previousEntries: entries[0] ? [entries[0]] : [],
  };
}

/** Only the chosen branch contributes turns to the active conversation. The
 * original durable events and executions remain available for history. */
export function activeNodeConversationEvents(state: Snapshot, node: string): GraphEvent[] {
  const edits = state.events
    .filter(event => event.type === "conversation_edited" && event.nodes?.includes(node))
    .map(edit => ({ from: editBoundary(edit, node, state.events), to: edit.sequence }));
  const { freshBoundary, retainedMessages } = nodeFreshRestartBoundary(state, node);
  return state.events.filter(event =>
    !edits.some(({ from, to }) => isEventAbandonedByEdit(event, from, to, node)) &&
    !isEventDroppedByFreshRestart(event, node, freshBoundary, retainedMessages));
}

export function executionIdForMessage(state: Snapshot, event: GraphEvent): string | undefined {
  if (event.execution_id) return event.execution_id;
  const node = event.target ?? event.node;
  if (!node) return undefined;
  const bound = state.events.find(item => item.type === "started" && item.execution?.node === node &&
    item.message_sequences?.includes(event.sequence));
  if (bound) return bound.execution?.id;
  if (state.nodes[node]?.pendingMessages?.some(message => message.sequence === event.sequence)) return undefined;
  // Edits have an explicit conversation boundary; other turns require claims.
  return state.events.find(item => item.type === "started" &&
    event.type === "conversation_edited" &&
    item.sequence > event.sequence && item.execution?.node === node)?.execution?.id;
}

export function executionIdForVersion(state: Snapshot, node: string, text: string): string | undefined {
  const clean = stripNodePrefix(text);
  const edited = state.events.slice().reverse().find(event =>
    event.type === "conversation_edited" && event.target === node &&
    event.instruction?.trim() === clean);
  if (edited) return executionIdForMessage(state, edited);
  const previous = state.events.slice().reverse().find(event =>
    event.type === "conversation_edited" && event.target === node &&
    event.old_instruction?.trim() === clean);
  if (previous?.from_execution_id) return previous.from_execution_id;
  const invalidated = state.events.slice().reverse().find(event =>
    event.type === "invalidated" && event.target === node &&
    event.instruction?.trim() === clean);
  return invalidated ? executionIdForMessage(state, invalidated) : undefined;
}

export function executionIdForEdit(state: Snapshot, edit: GraphEvent): string | undefined {
  return executionIdForMessage(state, edit);
}

export function versionIndexForEdit(state: Snapshot, edit: GraphEvent, versions = versionsForEdit(state, edit)): number {
  return edit.selected_version ?? versions.length - 1;
}

export function versionsForEdit(state: Snapshot, edit: GraphEvent): ChatMessageVersion[] {
  const versions: ChatMessageVersion[] = [];
  let cursor: GraphEvent | undefined = edit;
  const visited = new Set<number>();
  while (cursor?.type === "conversation_edited" && !visited.has(cursor.sequence)) {
    visited.add(cursor.sequence);
    if (cursor.selected_version !== undefined) {
      const previous = state.events.slice().reverse().find(event =>
        event.sequence < cursor!.sequence && event.type === "conversation_edited" &&
        event.target === cursor!.target && event.selected_version === undefined);
      const base = previous ? versionsForEdit(state, previous) : [];
      const branchEnd = versions.length === 0 ? base.length : cursor.selected_version + 1;
      return [...base.slice(0, branchEnd), ...versions];
    }
    const nextExecution = executionIdForEdit(state, cursor);
    versions.unshift({ id: `v${cursor.sequence}`, text: cursor.instruction ?? "", images: cursor.images,
      timestamp: cursor.timestamp, executionId: nextExecution });
    const parent: GraphEvent | undefined = state.events.find(e => e.sequence === cursor?.from_event_sequence);
    if (parent?.type === "conversation_edited") cursor = parent;
    else {
      versions.unshift({ id: `v${parent?.sequence ?? cursor.sequence}-before`, text: cursor.old_instruction ?? "",
        images: parent?.images, timestamp: parent?.timestamp ?? cursor.timestamp, executionId: cursor.from_execution_id });
      break;
    }
  }
  return versions;
}

/** Executions whose conversation history belongs to the node's active
 * conversation: the live attempts plus each edit's retained anchor. A from-zero
 * restart discards everything before it, so a fork (which is not a restart)
 * keeps its retained prefix even though its Pi session ID changed. */
export function nodeConversationLineage(state: Snapshot, node: string): Set<string> {
  const lineage = new Set(activeNodeExecutions(state, node).map(execution => execution.id));
  const restart = state.events.reduce((latest, event) =>
    event.type === "started" && event.execution?.node === node && event.fresh_restart && event.sequence > latest
      ? event.sequence : latest, Number.NEGATIVE_INFINITY);
  for (const event of state.events) {
    if (event.type !== "conversation_edited" || event.target !== node) continue;
    if (event.sequence < restart) continue;
    if (event.from_execution_id) lineage.add(event.from_execution_id);
  }
  return lineage;
}

export type ConversationExecution = Execution & { historyEndOffset?: number; historyReadOnly?: boolean };

/** Durable edits retain a byte-bounded prefix of an abandoned execution. A
 * later edit of an earlier prefix replaces that cut and drops later prefixes. */
export function nodeConversationExecutions(state: Snapshot, node: string): ConversationExecution[] {
  const active = activeNodeExecutions(state, node);
  const order = new Map(state.executions.map((execution, index) => [execution.id, index]));
  const edits = state.events.filter(event => event.type === "conversation_edited" && event.target === node);
  const lineage = nodeConversationLineage(state, node);
  // A retained prefix is editable only while its Pi session is still the
  // conversation's current session. A fork continues in a new session file, so
  // branching the old one could not affect the active conversation (the runtime
  // refuses that edit), and offering it would only fail.
  const currentSession = active.length > 0 ? active[active.length - 1].sessionId : undefined;
  const prefixes = new Map<string, ConversationExecution>();
  for (const edit of edits) {
    const anchor = state.executions.find(execution => execution.id === edit.from_execution_id);
    if (!anchor || !lineage.has(anchor.id)) continue;
    for (const [id, prefix] of prefixes) {
      if (prefix.sessionId === anchor.sessionId && order.get(prefix.id)! >= order.get(anchor.id)!) prefixes.delete(id);
    }
    if (edit.from_output_offset !== undefined && edit.from_output_offset > 0) {
      prefixes.set(anchor.id, { ...anchor, historyEndOffset: edit.from_output_offset,
        historyReadOnly: currentSession !== undefined && anchor.sessionId !== currentSession });
    }
  }
  for (const execution of active) prefixes.delete(execution.id);
  return [...prefixes.values(), ...active].sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

export function activeNodeExecutions(state: Snapshot, node: string) {
  const superseded = new Set(state.supersededExecutionIds ?? []);
  return state.executions.filter((execution) => execution.node === node && !superseded.has(execution.id));
}

export interface ConversationTurnShape {
  id: string;
  isInitial: boolean;
  userMessage?: ChatMessage;
  steerMessages?: ChatMessage[];
  executions: ConversationExecution[];
}

/** Assign executions and steers to conversation turns. Retries and
 * pause/continue executions carry no new user message, so they follow the
 * preceding execution's turn instead of jumping back to turns[0]. */
export function buildConversationTurns<T extends ConversationTurnShape>(options: {
  initialTurn: T;
  messages: readonly ChatMessage[];
  executions: readonly ConversationExecution[];
  createFollowUpTurn: (message: ChatMessage, executions: ConversationExecution[]) => T;
  allowSteerContinuation?: boolean;
}): T[] {
  const { initialTurn, messages, executions, createFollowUpTurn, allowSteerContinuation = false } = options;
  const rootTurn: T = {
    ...initialTurn,
    executions: [...initialTurn.executions],
    ...(initialTurn.steerMessages ? { steerMessages: [...initialTurn.steerMessages] } : {}),
  };
  const turns: T[] = [rootTurn];
  const executionIds = new Set(executions.map(execution => execution.id));
  const order = new Map(executions.map((execution, index) => [execution.id, index]));
  const assigned = new Set(rootTurn.executions.map(execution => execution.id));
  // Passive node messages are opening input, not in-flight Steers. A claimed
  // batch owns its response only after the last user bubble in that batch.
  const lastMessageByExecution = new Map(
    messages
      .filter(message => message.delivery !== "steered" && message.executionId)
      .map(message => [message.executionId!, message.id])
  );
  const pendingSteers: ChatMessage[] = [];

  for (const message of messages) {
    if (message.delivery === "steered" && message.executionId) {
      // Merger continuations (`continue_merger`) create a new execution and
      // emit a `steered` event pointing to that new execution id. When no
      // earlier turn owns it yet, this message started that execution and must
      // sit above its output; later steers on the same execution attach above.
      if (
        allowSteerContinuation &&
        !assigned.has(message.executionId) &&
        !lastMessageByExecution.has(message.executionId)
      ) {
        const continued = executions.find(item => item.id === message.executionId);
        if (continued) {
          assigned.add(continued.id);
          turns.push(createFollowUpTurn(message, [continued]));
          continue;
        }
      }
      if (executionIds.has(message.executionId)) {
        pendingSteers.push(message);
        continue;
      }
    }
    const exact = message.executionId && lastMessageByExecution.get(message.executionId) === message.id
      ? executions.find(item => item.id === message.executionId && !assigned.has(item.id))
      : undefined;
    const claimed = exact ? [exact] : [];
    if (exact) assigned.add(exact.id);
    turns.push(createFollowUpTurn(message, claimed));
  }

  const ownerByExecutionId = new Map<string, T>();
  for (const turn of turns) {
    for (const execution of turn.executions) ownerByExecutionId.set(execution.id, turn);
  }
  let currentOwner = turns[0];
  const touched = new Set<T>();
  for (const execution of executions) {
    const existingOwner = ownerByExecutionId.get(execution.id);
    if (existingOwner) {
      currentOwner = existingOwner;
    } else {
      currentOwner.executions.push(execution);
      ownerByExecutionId.set(execution.id, currentOwner);
      touched.add(currentOwner);
    }
  }
  for (const turn of touched) {
    turn.executions.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  for (const steer of pendingSteers) {
    const owner = steer.executionId ? ownerByExecutionId.get(steer.executionId) : undefined;
    if (owner) (owner.steerMessages ??= []).push(steer);
  }

  return turns;
}
