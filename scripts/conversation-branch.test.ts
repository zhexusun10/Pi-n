import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeLocalNodeMessages, activeNodeConversationEvents, activeNodeExecutions, applySelectedVersionToEntries, branchEditedMessageEntries, buildConversationTurns, findBranchTargetIndex, localMessagesAfterEdit, localMessagesAfterEdits, nodeConversationExecutions, nodeConversationLineage, executionIdForMessage, executionIdForVersion, executionIdForEdit, sessionEntriesAfterNodeEdit, versionsForEdit } from '../src/services/conversationBranch.ts';
import { emptySnapshot, type ChatMessage, type GraphEvent, type Snapshot } from '../src/types.ts';

test('editing a completed turn hides the abandoned node branch but preserves earlier turns', () => {
  const state: Snapshot = {
    ...emptySnapshot,
    supersededExecutionIds: ['second', 'third'],
    executions: [
      { id: 'first', node: 'task', revision: 1, attempt: 1, sessionId: 's', worktree: '', before: '', after: '', status: 'completed', output: '', startedAt: 1, completedAt: 2 },
      { id: 'second', node: 'task', revision: 2, attempt: 2, sessionId: 's', worktree: '', before: '', after: '', status: 'completed', output: '', startedAt: 3, completedAt: 4 },
      { id: 'third', node: 'task', revision: 3, attempt: 3, sessionId: 's', worktree: '', before: '', after: '', status: 'completed', output: '', startedAt: 5, completedAt: 6 },
      { id: 'edited', node: 'task', revision: 4, attempt: 4, sessionId: 's', worktree: '', before: '', after: '', status: 'completed', output: '', startedAt: 7, completedAt: 8 },
    ],
    events: [
      { sequence: 1, timestamp: 1, type: 'started', execution: { id: 'first' } as never },
      { sequence: 2, timestamp: 3, type: 'invalidated', target: 'task', instruction: 'second', human: true },
      { sequence: 3, timestamp: 3, type: 'started', execution: { id: 'second' } as never },
      { sequence: 4, timestamp: 5, type: 'invalidated', target: 'task', instruction: 'third', human: true },
      { sequence: 5, timestamp: 7, type: 'conversation_edited', target: 'task', nodes: ['task'], instruction: 'replacement', from_event_sequence: 2, from_execution_id: 'second' },
    ],
  };
  assert.deepEqual(activeNodeExecutions(state, 'task').map(e => e.id), ['first', 'edited']);
  assert.deepEqual(activeNodeConversationEvents(state, 'task').filter(e => !!e.instruction).map(e => e.instruction), ['replacement']);
  assert.equal(state.events.length, 5, 'old durable history remains intact');
});

test('editing a later Steer preserves earlier Steers from the superseded execution in the same session', () => {
  const original = { id: 'original', node: 'task', revision: 1, attempt: 1, sessionId: 'same', worktree: '', before: '', after: '', status: 'paused', output: '', startedAt: 1, completedAt: 4 };
  const replacement = { ...original, id: 'replacement', attempt: 2, startedAt: 5, status: 'running', completedAt: null };
  const state = { ...emptySnapshot, supersededExecutionIds: [original.id], executions: [original, replacement], events: [
    { type: 'started', sequence: 1, timestamp: 1, execution: original },
    { type: 'steered', sequence: 2, timestamp: 2, node: 'task', execution_id: original.id, instruction: 'keep this steer' },
    { type: 'steered', sequence: 3, timestamp: 3, node: 'task', execution_id: original.id, instruction: 'replace this steer' },
    { type: 'conversation_edited', sequence: 4, timestamp: 4, target: 'task', nodes: ['task'], first_turn: false,
      instruction: 'edited steer', old_instruction: 'replace this steer', from_event_sequence: 3, from_execution_id: original.id },
    { type: 'started', sequence: 5, timestamp: 5, execution: replacement },
  ] } as Snapshot;
  const replayed = JSON.parse(JSON.stringify(state));
  assert.deepEqual(activeNodeConversationEvents(replayed, 'task').filter(event => event.instruction).map(event => event.instruction),
    ['keep this steer', 'edited steer']);
  assert.equal(executionIdForEdit(replayed, replayed.events[3]), replacement.id);
  assert.deepEqual(versionsForEdit(replayed, replayed.events[3]).map(version => version.text), ['replace this steer', 'edited steer']);
});

test('cursor edits retain bounded transcript prefixes and recutting an earlier turn drops only its suffix', () => {
  const original = { id: 'original', node: 'task', revision: 1, attempt: 1, sessionId: 'same', worktree: '', before: '', after: '', status: 'paused', output: '', startedAt: 1, completedAt: 4 };
  const second = { ...original, id: 'second', attempt: 2, startedAt: 5, completedAt: 7 };
  const third = { ...original, id: 'third', attempt: 3, startedAt: 8, status: 'running', completedAt: null };
  const state = { ...emptySnapshot, supersededExecutionIds: [original.id, second.id], executions: [original, second, third], events: [
    { type: 'started', sequence: 1, timestamp: 1, execution: original },
    { type: 'conversation_edited', sequence: 4, timestamp: 4, target: 'task', nodes: ['task'],
      from_execution_id: original.id, from_event_sequence: 1, from_output_offset: 120 },
    { type: 'started', sequence: 5, timestamp: 5, execution: second },
    { type: 'conversation_edited', sequence: 7, timestamp: 7, target: 'task', nodes: ['task'],
      from_execution_id: original.id, from_event_sequence: 1, from_output_offset: 40 },
    { type: 'started', sequence: 8, timestamp: 8, execution: third },
  ] } as Snapshot;
  const replayed = JSON.parse(JSON.stringify(state));
  assert.deepEqual(nodeConversationExecutions(replayed, 'task').map(execution => [execution.id, execution.historyEndOffset]),
    [['original', 40], ['third', undefined]]);
  assert.equal(nodeConversationExecutions(replayed, 'task')[0].historyReadOnly, false,
    'a same-session prefix stays editable');
  assert.deepEqual(activeNodeExecutions(replayed, 'task').map(execution => execution.id), ['third'], 'prefixes are not live runtime executions');
  const restarted = { ...state, supersededExecutionIds: ['original', 'second', 'third'],
    executions: [...state.executions, { ...third, id: 'fresh', sessionId: 'fresh-session', startedAt: 9 }],
    events: [...state.events, { type: 'started', sequence: 9, timestamp: 9, fresh_restart: true,
      execution: { ...third, id: 'fresh', sessionId: 'fresh-session' } }] } as Snapshot;
  assert.deepEqual(nodeConversationExecutions(restarted, 'task').map(execution => execution.id), ['fresh']);
});

test('retained prefix ownership uses execution order even when start timestamps collide', () => {
  const first = { id: 'first', node: 'task', revision: 1, attempt: 1, sessionId: 's', worktree: '', before: '', after: '', status: 'paused', output: '', startedAt: 1, completedAt: 2 };
  const second = { ...first, id: 'second', attempt: 2 };
  const third = { ...first, id: 'third', attempt: 3, status: 'running', completedAt: null };
  const state = { ...emptySnapshot, supersededExecutionIds: ['first', 'second'], executions: [first, second, third], events: [
    { type: 'conversation_edited', target: 'task', sequence: 2, timestamp: 2, from_execution_id: 'first', from_output_offset: 20 },
    { type: 'conversation_edited', target: 'task', sequence: 4, timestamp: 2, from_execution_id: 'second', from_output_offset: 30 },
  ] } as Snapshot;
  assert.deepEqual(nodeConversationExecutions(state, 'task').map(execution => [execution.id, execution.historyEndOffset]),
    [['first', 20], ['second', 30], ['third', undefined]]);
});

test('a forked session keeps its retained prefix while a from-zero restart drops it', () => {
  const original = { id: 'original', node: 'task', revision: 1, attempt: 1, sessionId: 'old-session', worktree: '/old', before: '', after: '', status: 'paused', output: '', startedAt: 1, completedAt: 4 };
  const forked = { ...original, id: 'forked', attempt: 2, sessionId: 'forked-session', worktree: '/new', status: 'running', startedAt: 5, completedAt: null };
  const forkedState = { ...emptySnapshot, supersededExecutionIds: [original.id], executions: [original, forked], events: [
    { type: 'started', sequence: 1, timestamp: 1, execution: original, fresh_restart: true },
    { type: 'steered', sequence: 2, timestamp: 2, node: 'task', execution_id: original.id, instruction: 'keep this steer' },
    { type: 'conversation_edited', sequence: 3, timestamp: 3, target: 'task', nodes: ['task'], first_turn: false,
      instruction: 'edited turn', from_event_sequence: 1, from_execution_id: original.id, from_output_offset: 40 },
    { type: 'started', sequence: 4, timestamp: 4, execution: forked, fresh_restart: false },
  ] } as Snapshot;
  const replayed = JSON.parse(JSON.stringify(forkedState));
  assert.equal(nodeConversationLineage(replayed, 'task').has(original.id), true);
  assert.deepEqual(nodeConversationExecutions(replayed, 'task').map(execution => [execution.id, execution.historyEndOffset]),
    [['original', 40], ['forked', undefined]],
    'a fork keeps the retained prefix even though its Pi session ID changed');
  assert.equal(nodeConversationExecutions(replayed, 'task')[0].historyReadOnly, true,
    'a forked prefix cannot branch the active session, so it offers no edit');
  const restarted = { ...forkedState, supersededExecutionIds: [original.id, forked.id],
    executions: [...forkedState.executions, { ...forked, id: 'restart', sessionId: 'restart-session', startedAt: 6 }],
    events: [...forkedState.events, { type: 'started', sequence: 5, timestamp: 5, execution: { ...forked, id: 'restart' }, fresh_restart: true }] } as Snapshot;
  const reloaded = JSON.parse(JSON.stringify(restarted));
  assert.equal(nodeConversationLineage(reloaded, 'task').has(original.id), false);
  assert.deepEqual(nodeConversationExecutions(reloaded, 'task').map(execution => execution.id), ['restart']);
});

test('queued turns use exact durable execution claims, not the next start or matching text', () => {
  const messages: GraphEvent[] = [1, 2, 3].map(sequence => ({ sequence, timestamp: sequence, type: 'invalidated', target: 'task', instruction: 'same', human: true }));
  const state: Snapshot = { ...emptySnapshot,
    nodes: { task: { status: 'dirty', revision: 2, head: '', instruction: 'same', error: null, pendingMessages: [{ sequence: 3, instruction: 'same' }] } },
    events: [...messages,
      { sequence: 4, timestamp: 4, type: 'started', execution: { id: 'other', node: 'other' } as never, message_sequences: [3] },
      { sequence: 5, timestamp: 5, type: 'started', execution: { id: 'batch', node: 'task' } as never, message_sequences: [1, 2] },
      { sequence: 6, timestamp: 6, type: 'started', execution: { id: 'unrelated-task-start', node: 'task' } as never, message_sequences: [] }],
  };
  assert.equal(executionIdForMessage(state, messages[0]), 'batch');
  assert.equal(executionIdForMessage(state, messages[1]), 'batch');
  assert.equal(executionIdForMessage(state, messages[2]), undefined);
  const reloaded = JSON.parse(JSON.stringify(state));
  assert.equal(executionIdForMessage(reloaded, messages[1]), 'batch');
});

test('pre-start queued messages remain visible after dispatch and replay without reviving abandoned turns', () => {
  const messages: GraphEvent[] = [1, 2].map(sequence => ({
    type: 'node_messaged', sequence, timestamp: sequence, node: 'task', queued: true,
    instruction: 'same constraint', images: [{ type: 'image', mimeType: 'image/png', data: String(sequence) }],
  }));
  const first = { id: 'first', node: 'task', revision: 1, attempt: 1, sessionId: 's', worktree: '',
    before: '', after: null, status: 'running', output: '', startedAt: 5, completedAt: null };
  const state: Snapshot = { ...emptySnapshot,
    nodes: { task: { status: 'waiting', revision: 1, head: null, instruction: '', error: null,
      pendingMessages: messages.map(event => ({ sequence: event.sequence, instruction: event.instruction!, images: event.images })) } },
    events: [{ type: 'node_messaged', sequence: 0, timestamp: 0, node: 'task', instruction: 'legacy note' }, ...messages],
  };
  const visible = (snapshot: Snapshot) => activeNodeConversationEvents(snapshot, 'task').filter(event => event.queued);
  assert.deepEqual(visible(state), messages);
  state.nodes.task.pendingMessages = [];
  state.nodes.task.status = 'running';
  state.executions = [first];
  state.events.push({ type: 'started', sequence: 5, timestamp: 5, execution: first, message_sequences: [1, 2] });
  const replayed: Snapshot = JSON.parse(JSON.stringify(state));
  assert.deepEqual(visible(replayed), messages, 'claimed input cannot disappear at the first Started event');
  assert.deepEqual(visible(replayed).map(event => executionIdForMessage(replayed, event)), ['first', 'first']);
  assert.ok(!activeNodeConversationEvents(replayed, 'task').some(event => event.instruction === 'legacy note'));

  const fresh = { ...first, id: 'fresh', sessionId: 'new', startedAt: 7 };
  const newMessage = { ...messages[0], sequence: 6, timestamp: 6, instruction: 'new constraint' };
  state.supersededExecutionIds = ['first'];
  state.executions.push(fresh);
  state.events.push(newMessage,
    { type: 'started', sequence: 7, timestamp: 7, execution: fresh, fresh_restart: true, message_sequences: [6] });
  assert.deepEqual(visible(state), [newMessage], 'only claims from the active conversation survive a fresh restart');
});

test('edited messages point at the new active execution, not the superseded anchor', () => {
  const state: Snapshot = {
    ...emptySnapshot,
    events: [
      { sequence: 1, timestamp: 10, type: 'conversation_edited', target: 'task', nodes: ['task'], instruction: 'replacement', from_execution_id: 'old' },
      { sequence: 2, timestamp: 20, type: 'started', execution: { id: 'new', node: 'task' } as never, message_sequences: [] },
    ],
  };
  assert.equal(executionIdForEdit(state, state.events[0]), 'new');
});
test('version lookup can recover a superseded branch anchor', () => {
  const state: Snapshot = {
    ...emptySnapshot,
    events: [
      { sequence: 1, timestamp: 10, type: 'invalidated', target: 'task', instruction: 'original' },
      { sequence: 2, timestamp: 20, type: 'started', execution: { id: 'old', node: 'task' } as never },
      { sequence: 3, timestamp: 30, type: 'conversation_edited', target: 'task', nodes: ['task'], instruction: 'replacement', old_instruction: 'original', from_execution_id: 'old' },
      { sequence: 4, timestamp: 40, type: 'started', execution: { id: 'new', node: 'task' } as never },
    ],
  };
  assert.equal(executionIdForMessage(state, state.events[2]), 'new');
  assert.equal(executionIdForVersion(state, 'task', 'original'), 'old');
});
test('selecting an existing branch does not append another version', () => {
  const state: Snapshot = {
    ...emptySnapshot,
    events: [
      { sequence: 1, timestamp: 10, type: 'invalidated', target: 'task', instruction: 'original' },
      { sequence: 2, timestamp: 20, type: 'conversation_edited', target: 'task', instruction: 'replacement', old_instruction: 'original', from_event_sequence: 1 },
      { sequence: 3, timestamp: 30, type: 'conversation_edited', target: 'task', instruction: 'original', old_instruction: 'replacement', from_event_sequence: 1, selected_version: 0 },
    ],
  };
  const selected = state.events[2];
  assert.deepEqual(versionsForEdit(state, selected).map(version => version.text), ['original', 'replacement']);
  assert.equal(selected.selected_version, 0);

  const continued: GraphEvent = {
    sequence: 4, timestamp: 40, type: 'conversation_edited', target: 'task', instruction: 'continued',
    old_instruction: 'original', from_event_sequence: 3,
  };
  const continuedState = { ...state, events: [...state.events, continued] };
  assert.deepEqual(versionsForEdit(continuedState, continued).map(version => version.text), ['original', 'continued']);
});

test('message versions survive reload and nested edits', () => {
  const state: Snapshot = {
    ...emptySnapshot,
    events: [
      { sequence: 1, timestamp: 10, type: 'invalidated', target: 'task', instruction: 'original' },
      { sequence: 2, timestamp: 20, type: 'conversation_edited', target: 'task', instruction: 'replacement', old_instruction: 'original', from_event_sequence: 1 },
      { sequence: 3, timestamp: 30, type: 'conversation_edited', target: 'task', instruction: 'third', old_instruction: 'replacement', from_event_sequence: 2 },
    ],
  };
  assert.deepEqual(versionsForEdit(state, state.events[2]).map(version => version.text),
    ['original', 'replacement', 'third']);
});

test('edit pruning preserves an earlier identical request and input accepted after the edit', () => {
  const earlier: ChatMessage = { id: 'msg-earlier', role: 'user', text: 'same', steerRequestId: 'earlier' };
  const target: ChatMessage = { id: 'msg-target', role: 'user', text: 'same', steerRequestId: 'target' };
  const pending: ChatMessage = { id: 'msg-pending', role: 'user', text: 'same', steerRequestId: 'pending' };
  const edit: GraphEvent = { type: 'conversation_edited', sequence: 3, timestamp: 3, target: 'task',
    from_event_sequence: 2, old_instruction: 'same', instruction: 'revised' };
  const events: GraphEvent[] = [
    { type: 'invalidated', sequence: 1, timestamp: 1, target: 'task', instruction: 'same', request_id: 'earlier' },
    { type: 'invalidated', sequence: 2, timestamp: 2, target: 'task', instruction: 'same', request_id: 'target' }, edit,
  ];
  assert.deepEqual(localMessagesAfterEdit([earlier, target, pending], edit, events), [earlier, pending]);
  events.push({ type: 'invalidated', sequence: 4, timestamp: 4, target: 'task', instruction: 'same', request_id: 'pending' });
  assert.deepEqual(localMessagesAfterEdit([earlier, target, pending], edit, events), [earlier, pending]);
  const updated = { ...target, text: 'revised', steerRequestId: undefined };
  const nested = { ...edit, sequence: 5, from_event_sequence: 3, old_instruction: 'revised', instruction: 'next revision' };
  assert.deepEqual(localMessagesAfterEdit([earlier, updated], nested, [...events, nested]), [earlier]);
});

test('editing and restoring a repeated turn prefers its message ID over earlier matching text', () => {
  const entries: ChatMessage[] = [
    { id: 'first', role: 'user', text: '[@task] same request', timestamp: 10 },
    { id: 'second', role: 'user', text: '[@task] same request', timestamp: 20 },
    { id: 'third', role: 'user', text: 'later request', timestamp: 30 },
  ];
  const target = entries[1];
  assert.equal(findBranchTargetIndex(entries, target, 'same request'), 1);
  const branched = branchEditedMessageEntries(entries, target, 'same request', 'revised request', undefined);
  assert.deepEqual(branched.previousEntries, [entries[0]]);
  assert.deepEqual(branched.rolledBackEntries.map(entry => entry.id), ['first', 'second']);
  assert.deepEqual(branched.updatedMsg.versions?.[0].subsequentEntries, [entries[2]]);

  // Version selection must use the same identity rule, even when the displayed
  // text is stale or equal to another turn's text.
  const restored = applySelectedVersionToEntries(
    entries, target, 'same request', { ...target, text: 'selected version' }, [entries[2]],
  );
  assert.deepEqual(restored.map(entry => [entry.id, entry.text]), [
    ['first', '[@task] same request'], ['second', 'selected version'], ['third', 'later request'],
  ]);
  assert.deepEqual(entries.map(entry => entry.text), ['[@task] same request', '[@task] same request', 'later request']);
});

test('message rollback uses stable IDs across node prefix display changes', () => {
  const baseEntries: ChatMessage[] = [
    { id: 'msg-1', role: 'user', text: '[@merge:06_feature_qa] continue solve the conflict', timestamp: 10 },
    { id: 'msg-2', role: 'user', text: '[@merge:06_feature_qa] second follow-up turn', timestamp: 20, plannerSteerId: 'steer-1', plannerSteerStatus: 'queued' },
  ];
  const targetClean = 'continue solve the conflict';
  const targetMsg: ChatMessage = { id: 'msg-1', role: 'user', text: targetClean, timestamp: 10 };
  assert.equal(findBranchTargetIndex(baseEntries, { ...targetMsg, id: 'different' }, targetClean), -1,
    'equal text never authorizes editing a different turn');
  const targetIndex = findBranchTargetIndex(baseEntries, targetMsg, targetClean);
  assert.equal(targetIndex, 0, 'stable ID survives display prefix normalization');

  const branched = branchEditedMessageEntries(baseEntries, targetMsg, targetClean, 'revised resolution', undefined);
  assert.equal(branched.previousEntries.length, 0);
  assert.equal(branched.rolledBackEntries.length, 1);
  assert.equal(branched.updatedMsg.text, 'revised resolution');
  assert.equal(branched.updatedMsg.versions?.length, 2);
  assert.equal(branched.updatedMsg.versions?.[0].subsequentEntries?.length, 1);
  assert.equal(branched.updatedMsg.versions?.[0].subsequentEntries?.[0].id, 'msg-2');

  const restored = applySelectedVersionToEntries(
    branched.rolledBackEntries,
    branched.updatedMsg,
    'revised resolution',
    { ...branched.updatedMsg, text: targetClean, currentVersionIndex: 0 },
    branched.updatedMsg.versions?.[0].subsequentEntries,
  );
  assert.equal(restored.length, 2);
  assert.equal(restored[1].id, 'msg-2');
  assert.equal(restored[1].plannerSteerId, undefined, 'restored subsequent entries strip stale steer identity');
});


test('a fresh restart supersedes prior attempts and their human turns', () => {
  const state: Snapshot = {
    ...emptySnapshot,
    supersededExecutionIds: ['attempt-1'],
    executions: [
      { id: 'attempt-1', node: 'task', revision: 1, attempt: 1, sessionId: 'old', worktree: '', before: '', after: '', status: 'failed', output: '', startedAt: 1, completedAt: 2 },
      { id: 'attempt-2', node: 'task', revision: 2, attempt: 2, sessionId: 'new', worktree: '', before: '', after: '', status: 'running', output: '', startedAt: 9, completedAt: null },
    ],
    events: [
      { sequence: 1, timestamp: 1, type: 'started', execution: { id: 'attempt-1', node: 'task' } as never },
      { sequence: 2, timestamp: 2, type: 'invalidated', target: 'task', instruction: 'old repair instruction', human: true },
      { sequence: 9, timestamp: 9, type: 'started', execution: { id: 'attempt-2', node: 'task' } as never },
    ],
  };
  assert.deepEqual(activeNodeExecutions(state, 'task').map(e => e.id), ['attempt-2']);
  // The dead conversation's human turn no longer renders above the fresh start.
  assert.deepEqual(activeNodeConversationEvents(state, 'task').filter(e => !!e.instruction), []);
});

test('buildConversationTurns keeps pause/continue and retry executions below their owning follow-up turn', () => {
  const exec = (id: string, attempt: number, status: string, startedAt: number) => ({
    id, node: 'task', revision: 1, attempt, sessionId: 's', worktree: '', before: '', after: '',
    status, output: '', startedAt, completedAt: status === 'running' ? null : startedAt + 1,
  });
  const executions = [
    exec('e1', 1, 'completed', 1),
    exec('e2-paused', 2, 'paused', 2),
    exec('e3-continued', 2, 'paused', 3),
    exec('e4-resumed', 2, 'running', 4),
  ];
  const messages: ChatMessage[] = [
    { id: 'm1', role: 'user', text: 'follow-up 1', delivery: 'node_messaged', executionId: 'e2-paused' },
    { id: 'steer-on-resumed', role: 'user', text: 'adjust while resumed', delivery: 'steered', executionId: 'e4-resumed' },
    { id: 'm2-pending', role: 'user', text: 'queued follow-up 2' },
  ];
  const turns = buildConversationTurns({
    initialTurn: { id: 'turn-0', isInitial: true, executions: [executions[0]] },
    messages,
    executions,
    createFollowUpTurn: (message, claimed) => ({ id: message.id, isInitial: false, userMessage: message, executions: claimed }),
  });
  assert.deepEqual(turns.map(t => t.id), ['turn-0', 'm1', 'm2-pending']);
  assert.deepEqual(turns[0].executions.map(e => e.id), ['e1']);
  assert.deepEqual(turns[1].executions.map(e => e.id), ['e2-paused', 'e3-continued', 'e4-resumed']);
  assert.deepEqual((turns[1].steerMessages ?? []).map(m => m.id), ['steer-on-resumed']);
  assert.deepEqual(turns[2].executions, []);
});

test('buildConversationTurns preserves initial-turn retries and merger steer continuations', () => {
  const exec = (id: string, attempt: number, status: string, startedAt: number) => ({
    id, node: 'merge:task', revision: 1, attempt, sessionId: 's', worktree: '', before: '', after: '',
    status, output: '', startedAt, completedAt: startedAt + 1,
  });
  const executions = [
    exec('m1-failed', 1, 'failed', 1),
    exec('m2-retried', 2, 'completed', 2),
    exec('m3-continued', 3, 'completed', 3),
  ];
  const messages: ChatMessage[] = [
    { id: 'cont-1', role: 'user', text: 'continue merge', delivery: 'steered', executionId: 'm3-continued' },
    { id: 'steer-2', role: 'user', text: 'also check tests', delivery: 'steered', executionId: 'm3-continued' },
  ];
  const turns = buildConversationTurns({
    initialTurn: { id: 'turn-0', isInitial: true, executions: [executions[0]] },
    messages,
    executions,
    allowSteerContinuation: true,
    createFollowUpTurn: (message, claimed) => ({ id: message.id, isInitial: false, userMessage: message, executions: claimed }),
  });
  assert.deepEqual(turns.map(t => t.id), ['turn-0', 'cont-1']);
  assert.deepEqual(turns[0].executions.map(e => e.id), ['m1-failed', 'm2-retried']);
  assert.deepEqual(turns[1].executions.map(e => e.id), ['m3-continued']);
  assert.deepEqual((turns[1].steerMessages ?? []).map(m => m.id), ['steer-2']);
});

test('editing an older durable message not in local session entries prunes all later local messages', () => {
  const initial: ChatMessage = { id: 'msg-initial-goal', role: 'user', text: 'initial goal', runId: 'run-1' };
  const keptEarlier: ChatMessage = { id: 'msg-early', role: 'user', text: 'before edit', node: 'task', runId: 'run-1', steerRequestId: 'early' };
  const later1: ChatMessage = { id: 'msg-u1', role: 'user', text: 'later 1', node: 'task', runId: 'run-1', steerRequestId: 'u1' };
  const later2: ChatMessage = { id: 'msg-u2', role: 'user', text: 'later 2', node: 'task', runId: 'run-1', steerRequestId: 'u2' };
  const later3: ChatMessage = { id: 'msg-u3', role: 'user', text: 'later 3', node: 'task', runId: 'run-1', steerRequestId: 'u3' };
  const postEdit: ChatMessage = { id: 'msg-u4', role: 'user', text: 'after edit', node: 'task', runId: 'run-1', steerRequestId: 'u4' };
  const events: GraphEvent[] = [
    { sequence: 1, timestamp: 1, type: 'started', execution: { id: 'e1', node: 'task' } as never },
    { sequence: 2, timestamp: 2, type: 'invalidated', target: 'task', instruction: 'before edit', request_id: 'early', human: true },
    { sequence: 3, timestamp: 3, type: 'started', execution: { id: 'e2', node: 'task' } as never, message_sequences: [2] },
    // Old durable message from a previous browser session (not present in local sessionEntries).
    { sequence: 4, timestamp: 4, type: 'invalidated', target: 'task', instruction: 'old message', human: true },
    { sequence: 5, timestamp: 5, type: 'started', execution: { id: 'e3', node: 'task' } as never, message_sequences: [4] },
    { sequence: 6, timestamp: 6, type: 'invalidated', target: 'task', instruction: 'later 1', request_id: 'u1', human: true },
    { sequence: 7, timestamp: 7, type: 'started', execution: { id: 'e4', node: 'task' } as never, message_sequences: [6] },
    { sequence: 8, timestamp: 8, type: 'invalidated', target: 'task', instruction: 'later 2', request_id: 'u2', human: true },
    { sequence: 9, timestamp: 9, type: 'started', execution: { id: 'e5', node: 'task' } as never, message_sequences: [8] },
    { sequence: 10, timestamp: 10, type: 'invalidated', target: 'task', instruction: 'later 3', request_id: 'u3', human: true },
    { sequence: 11, timestamp: 11, type: 'started', execution: { id: 'e6', node: 'task' } as never, message_sequences: [10] },
    {
      sequence: 12, timestamp: 12, type: 'conversation_edited', target: 'task', nodes: ['task'],
      from_event_sequence: 4, from_execution_id: 'e3', old_instruction: 'old message', instruction: 'edited old message', first_turn: false,
    },
  ];
  const snapshot: Snapshot = {
    ...emptySnapshot,
    runId: 'run-1',
    supersededExecutionIds: ['e3', 'e4', 'e5', 'e6'],
    events,
  };

  // Render-time pruning drops later1/later2/later3 even when the edited target is absent from local messages.
  assert.deepEqual(
    localMessagesAfterEdits([initial, keptEarlier, later1, later2, later3, postEdit], events, 'task', true).map(m => m.id),
    ['msg-initial-goal', 'msg-early', 'msg-u4'],
  );

  // Submit-time sessionEntries update drops later1/later2/later3 (including untracked legacy entries),
  // preserves earlier active turns and post-edit input, and attaches the edited replacement cleanly.
  const legacy: ChatMessage = { id: 'legacy-local', role: 'user', text: 'untracked local', node: 'task', runId: 'run-1' };
  const targetMsg: ChatMessage = { id: 'event-4', role: 'user', text: 'old message', node: 'task', runId: 'run-1' };
  const updatedMsg: ChatMessage = { ...targetMsg, text: 'edited old message' };
  const nextEntries = sessionEntriesAfterNodeEdit({
    entries: [initial, keptEarlier, later1, later2, later3, legacy, postEdit],
    snapshot,
    targetNode: 'task',
    targetMsg,
    updatedMsg,
    previousEventSequence: 11,
    preEditIds: new Set(['msg-initial-goal', 'msg-early', 'msg-u1', 'msg-u2', 'msg-u3', 'legacy-local']),
  });
  assert.deepEqual(nextEntries.map(m => [m.id, m.text]), [
    ['msg-initial-goal', 'initial goal'],
    ['msg-early', 'before edit'],
    ['msg-u4', 'after edit'],
    ['event-4', 'edited old message'],
  ]);
  // The active replacement survives localMessagesAfterEdits so it can match the durable conversation_edited event.
  assert.deepEqual(
    localMessagesAfterEdits(nextEntries, events, 'task', true).map(m => m.id),
    ['msg-initial-goal', 'msg-early', 'msg-u4', 'event-4'],
  );
});

test('earlier edit after a previous edit drops the previously edited copy and downstream invalidated nodes', () => {
  const initial: ChatMessage = { id: 'msg-initial-goal', role: 'user', text: 'goal', runId: 'run-1' };
  const otherNodeMsg: ChatMessage = { id: 'msg-other', role: 'user', text: 'unrelated', node: 'other', runId: 'run-1', steerRequestId: 'other' };
  const downstreamMsg: ChatMessage = { id: 'msg-down', role: 'user', text: 'downstream', node: 'b', runId: 'run-1', steerRequestId: 'down' };
  const prevEdited: ChatMessage = { id: 'event-6', role: 'user', text: 'previously edited', node: 'a', runId: 'run-1' };
  const events: GraphEvent[] = [
    { sequence: 1, timestamp: 1, type: 'started', execution: { id: 'a1', node: 'a' } as never },
    { sequence: 2, timestamp: 2, type: 'invalidated', target: 'a', instruction: 'turn 1', human: true },
    { sequence: 3, timestamp: 3, type: 'started', execution: { id: 'a2', node: 'a' } as never, message_sequences: [2] },
    { sequence: 6, timestamp: 6, type: 'invalidated', target: 'a', instruction: 'turn 2', human: true },
    { sequence: 7, timestamp: 7, type: 'conversation_edited', target: 'a', nodes: ['a'], from_event_sequence: 6, from_execution_id: 'a3', old_instruction: 'turn 2', instruction: 'previously edited', first_turn: false },
    { sequence: 8, timestamp: 8, type: 'invalidated', target: 'b', instruction: 'downstream', request_id: 'down', human: true },
    { sequence: 9, timestamp: 9, type: 'conversation_edited', target: 'a', nodes: ['a', 'b'], from_event_sequence: 2, from_execution_id: 'a2', old_instruction: 'turn 1', instruction: 'turn 1 revised', first_turn: false },
  ];
  const snapshot: Snapshot = { ...emptySnapshot, runId: 'run-1', events };
  assert.deepEqual(
    localMessagesAfterEdits([prevEdited], events, 'a', false),
    [],
    'an earlier edit drops a later previously-edited local copy',
  );
  assert.deepEqual(
    localMessagesAfterEdits([downstreamMsg], events, 'b', false),
    [],
    'an upstream edit drops invalidated downstream local messages',
  );
  const next = sessionEntriesAfterNodeEdit({
    entries: [initial, otherNodeMsg, downstreamMsg, prevEdited],
    snapshot,
    targetNode: 'a',
    targetMsg: { id: 'event-2', role: 'user', text: 'turn 1', node: 'a', runId: 'run-1' },
    updatedMsg: { id: 'event-2', role: 'user', text: 'turn 1 revised', node: 'a', runId: 'run-1' },
    previousEventSequence: 8,
    preEditIds: new Set(['msg-initial-goal', 'msg-other', 'msg-down', 'event-6']),
  });
  assert.deepEqual(next.map(m => [m.id, m.node]), [
    ['msg-initial-goal', undefined],
    ['msg-other', 'other'],
    ['event-2', 'a'],
  ]);
});

test('first_turn edit drops pre-edit follow-ups even when opening text already changed', () => {
  const initial: ChatMessage = { id: 'msg-initial-goal', role: 'user', text: 'already updated', runId: 'run-1' };
  const oldFollowUp: ChatMessage = { id: 'msg-old', role: 'user', text: 'old follow-up', node: 'task', runId: 'run-1', steerRequestId: 'old' };
  const newFollowUp: ChatMessage = { id: 'msg-new', role: 'user', text: 'new follow-up', node: 'task', runId: 'run-1', steerRequestId: 'new' };
  const events: GraphEvent[] = [
    { sequence: 1, timestamp: 1, type: 'started', execution: { id: 'e1', node: 'task' } as never },
    { sequence: 2, timestamp: 2, type: 'invalidated', target: 'task', instruction: 'old follow-up', request_id: 'old', human: true },
    { sequence: 3, timestamp: 3, type: 'conversation_edited', target: 'task', nodes: ['task'], from_event_sequence: 1, from_execution_id: 'e1', old_instruction: 'original goal', instruction: 'already updated', first_turn: true },
  ];
  assert.deepEqual(
    localMessagesAfterEdits([initial, oldFollowUp, newFollowUp], events, 'task', true).map(m => m.id),
    ['msg-initial-goal', 'msg-new'],
  );
});

test('fresh restart drops pre-restart durable conversation_edited events and local session entries', () => {
  const attempt1 = { id: 'attempt-1', node: 'task', revision: 1, attempt: 1, sessionId: 'old', worktree: '', before: '', after: '', status: 'completed', output: '', startedAt: 1, completedAt: 2 };
  const attempt2 = { ...attempt1, id: 'attempt-2', revision: 2, attempt: 2, startedAt: 3, completedAt: 4 };
  const fresh = { ...attempt1, id: 'attempt-3', revision: 3, attempt: 3, sessionId: 'new', status: 'running', startedAt: 10, completedAt: null };
  const state: Snapshot = {
    ...emptySnapshot,
    runId: 'run-1',
    supersededExecutionIds: ['attempt-1', 'attempt-2'],
    executions: [attempt1, attempt2, fresh],
    events: [
      { sequence: 1, timestamp: 1, type: 'started', execution: attempt1 },
      { sequence: 2, timestamp: 2, type: 'invalidated', target: 'task', instruction: 'old follow-up', request_id: 'old-req', human: true },
      { sequence: 3, timestamp: 3, type: 'conversation_edited', target: 'task', nodes: ['task'], from_event_sequence: 2, from_execution_id: 'attempt-1', old_instruction: 'old follow-up', instruction: 'edited before restart', first_turn: false },
      { sequence: 4, timestamp: 4, type: 'started', execution: attempt2 },
      { sequence: 8, timestamp: 8, type: 'node_messaged', node: 'task', instruction: 'queued for fresh', request_id: 'claimed-req', queued: true },
      { sequence: 10, timestamp: 10, type: 'started', execution: fresh, fresh_restart: true, message_sequences: [8] },
    ],
  };
  assert.deepEqual(
    activeNodeConversationEvents(state, 'task').filter(event => !!event.instruction).map(event => event.instruction),
    ['queued for fresh'],
    'a fresh restart drops pre-restart conversation_edited turns while keeping claimed input',
  );
  const initial: ChatMessage = { id: 'msg-initial-goal', role: 'user', text: 'goal', runId: 'run-1' };
  const staleEdited: ChatMessage = { id: 'event-2', role: 'user', text: 'edited before restart', node: 'task', runId: 'run-1' };
  const staleFollowUp: ChatMessage = { id: 'msg-old-req', role: 'user', text: 'old follow-up', node: 'task', runId: 'run-1', steerRequestId: 'old-req' };
  const claimedLocal: ChatMessage = { id: 'msg-claimed-req', role: 'user', text: 'queued for fresh', node: 'task', runId: 'run-1', steerRequestId: 'claimed-req' };
  const postRestart: ChatMessage = { id: 'msg-post', role: 'user', text: 'after restart', node: 'task', runId: 'run-1', steerRequestId: 'post-req' };
  assert.deepEqual(
    activeLocalNodeMessages([initial, staleFollowUp, staleEdited, claimedLocal, postRestart], state, 'task', true).map(m => m.id),
    ['msg-initial-goal', 'msg-claimed-req', 'msg-post'],
  );
});
