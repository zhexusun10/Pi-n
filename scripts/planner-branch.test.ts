import assert from 'node:assert/strict';
import test from 'node:test';
import { activePlannerOutput, plannerConversationEdits, plannerHistoryIds, plannerTurnIds, reviewPlanningIds } from '../src/lib/plannerOutput.ts';
import { recoveredPlanningForDisplay, runningPlanningFromSnapshot } from '../src/services/planningRecovery.ts';
import { defaultConfig, emptySnapshot, type PlanningSummary, type Snapshot } from '../src/types.ts';

const source = (id: string) => JSON.stringify({ type: 'pi_n_planning_source', planningId: id });
const user = (text: string) => JSON.stringify({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text }] } });

test('Planner branch hides only abandoned turns while retaining earlier context and the new revision', () => {
  const log = [source('a'), user('original'), 'before', user('old follow-up'), 'abandoned',
    source('b'), user('obsolete'), 'abandoned too', source('c'), user('edited'), 'new reply'].join('\n') + '\n';
  const visible = activePlannerOutput(log, [{ old_instruction: 'old follow-up', nextPlanningId: 'c' }]);
  assert.match(visible, /before/);
  assert.match(visible, /edited/);
  assert.doesNotMatch(visible, /abandoned|obsolete/);
});

test('Planner branch matches Pi follow-ups with a dynamic status prefix', () => {
  const log = [source('a'), user('first'), user('Current graph node status:\n- task: completed\n\nlater'), 'old reply'].join('\n') + '\n';
  assert.doesNotMatch(activePlannerOutput(log, [{ old_instruction: 'later' }]), /old reply/);
});

test('live Planner continuation does not replay the revision it is streaming', () => {
  const events = [
    { type: 'created', planning_id: 'initial', planning: { planningId: 'initial', createdAt: 100 } },
    { type: 'graph_revised', planning_id: 'revision', planning: { planningId: 'revision', createdAt: 200 } },
  ];
  const base = { events, planning: true, live: true, backgroundReview: false, routeType: 'graph', representedIds: ['revision'] };
  // The snapshot announces the new attempt before it commits a graph; its
  // durable JSONL must wait until the live transcript releases it.
  assert.deepEqual(plannerHistoryIds({ ...base, savedPlannerId: 'next', continuation: true }), ['initial', 'revision']);
  // `savedPlannerId` still names the last completed turn until the backend
  // announces the revision, so that turn stays visible during the handoff.
  assert.deepEqual(plannerHistoryIds({ ...base, savedPlannerId: 'revision', continuation: true }), ['initial', 'revision']);
  // Once the turn settles, the JSONL is authoritative and the newest attempt returns.
  assert.deepEqual(plannerHistoryIds({ ...base, savedPlannerId: 'next', continuation: true, planning: false }),
    ['initial', 'revision', 'next']);
  // Fresh planning renders only the live transcript, never durable history.
  assert.deepEqual(plannerHistoryIds({ ...base, savedPlannerId: 'next', continuation: false }), []);
});

test('an edit keeps the failed replacement turn it started', () => {
  const events = [
    { type: 'created', planning_id: 'initial', planning: { planningId: 'initial', createdAt: 100 } },
    { type: 'graph_revised', planning_id: 'followup', planning: { planningId: 'followup', createdAt: 200 } },
    { type: 'planner_conversation_edited', old_instruction: 'followup' },
    { type: 'planner_workspace_selected', planning: { planningId: 'replacement', createdAt: 300 } },
    { type: 'planner_turn_aborted', planning: { planningId: 'replacement', createdAt: 300, status: 'failed' } },
  ];
  const edits = plannerConversationEdits(events);
  assert.deepEqual(edits, [{ old_instruction: 'followup', nextPlanningId: 'replacement' }]);
  const log = [source('initial'), user('first'), 'initial reply',
    source('followup'), user('followup'), 'followup reply',
    source('replacement'), user('replacement'), 'failed reply'].join('\n') + '\n';
  const visible = activePlannerOutput(log, edits);
  assert.match(visible, /initial reply/);
  assert.match(visible, /failed reply/);
  assert.doesNotMatch(visible, /followup reply/);
});

test('only post-task review turns start a new transcript section', () => {
  const events = [
    { type: 'created', planning_id: 'initial', planning: { planningId: 'initial', createdAt: 100 } },
    { type: 'graph_revised', planning_id: 'revision', planning: { planningId: 'revision', createdAt: 200 } },
    { type: 'planner_review_started', planning_id: 'review-a', planning: { planningId: 'review-a', createdAt: 300 } },
    { type: 'planner_review_finished', planning: { planningId: 'review-a', status: 'failed' } },
    { type: 'planner_turn_aborted', planning: { planningId: 'aborted', createdAt: 350 } },
    { type: 'planner_review_started', planning: { planningId: 'review-b', createdAt: 400 } },
  ];
  assert.deepEqual([...reviewPlanningIds(events)], ['review-a', 'review-b']);
  // Ordinary revisions and aborted attempts continue the conversation.
  assert.deepEqual([...reviewPlanningIds(events.slice(0, 2))], []);
  assert.equal(reviewPlanningIds([]).size, 0);
});

test('a live review keeps the earlier Planner conversation before recovery markers settle', () => {
  const events = [
    { type: 'created', planning_id: 'initial', planning: { planningId: 'initial', createdAt: 100 } },
    { type: 'graph_revised', planning_id: 'revision', planning: { planningId: 'revision', createdAt: 200 } },
    { type: 'planner_review_started', planning: { planningId: 'review', status: 'running', createdAt: 300 } },
  ];
  const base = { events, savedPlannerId: 'review', planning: true, live: true, continuation: false,
    backgroundReview: false, routeType: 'graph' };
  // The live stream may own the review attempt, but it cannot erase the
  // committed turns that preceded it.
  assert.deepEqual(plannerHistoryIds({ ...base, recoveredPlanningId: undefined }), ['initial', 'revision']);
  assert.deepEqual(plannerHistoryIds({ ...base, recoveredPlanningId: 'review' }), ['initial', 'revision']);
  // Once the review is durable history rather than a live stream, it joins them.
  assert.deepEqual(plannerHistoryIds({ ...base, live: false, recoveredPlanningId: 'review' }),
    ['initial', 'revision', 'review']);
});

test('aborted revision turns stay in the replayed Planner conversation', () => {
  const events = [
    { type: 'planning_started', planning: { planningId: 'start' } },
    { type: 'created', planning_id: 'initial', planning: { planningId: 'initial', createdAt: 100 } },
    { type: 'graph_revised', planning_id: 'rev1', planning: { planningId: 'rev1', createdAt: 200 } },
    { type: 'planner_review_started', planning: { planningId: 'review1', status: 'running', createdAt: 300 } },
    { type: 'planner_review_finished', planning: { planningId: 'review1', status: 'failed' } },
    { type: 'graph_revised', planning_id: 'rev2', planning: { planningId: 'rev2', createdAt: 400 } },
    // Recovery records the interrupted turn after later turns; createdAt restores order.
    { type: 'planner_turn_aborted', planning: { planningId: 'aborted', status: 'failed', createdAt: 350 } },
    { type: 'finished', execution_id: 'e1' },
  ];
  assert.deepEqual(plannerTurnIds(events), ['initial', 'rev1', 'review1', 'aborted', 'rev2']);
  assert.deepEqual(plannerTurnIds([]), []);
  assert.deepEqual(plannerTurnIds([{ type: 'planner_turn_aborted' }]), []);
  // Legacy events without createdAt keep their event order ahead of new turns.
  assert.deepEqual(plannerTurnIds([
    { type: 'created', planning_id: 'a' },
    { type: 'graph_revised', planning_id: 'b' },
    { type: 'planner_turn_aborted', planning: { planningId: 'c', createdAt: 5 } },
  ]), ['a', 'b', 'c']);
});

test('linked recovery takes the committed route from its own running Planner snapshot', () => {
  const repository = 'C:\\Users\\repo';
  const summary: PlanningSummary = { planningId: 'review', runId: 'graph-run', repository,
    roles: {}, status: 'running', totalPlanningDuration: 0, modelDuration: 0 };
  const snapshot: Snapshot = { ...emptySnapshot, runId: 'graph-run', phase: 'running', planType: 'graph',
    config: { ...defaultConfig, repository }, planningId: 'review', planning: { ...summary, planType: 'graph' } };
  assert.equal(runningPlanningFromSnapshot(summary, snapshot, 'c:/users/repo/')?.planType, 'graph');
  assert.equal(runningPlanningFromSnapshot({ ...summary, planType: 'serial' }, snapshot, repository)?.planType, 'graph');
  assert.equal(runningPlanningFromSnapshot(summary, { ...snapshot, phase: 'planning', planning: null }, repository)?.planningId, 'review',
    'initial planning may have an identity before its first summary is persisted');
  assert.ok(runningPlanningFromSnapshot(summary, { ...snapshot, phase: 'planning', planning: { ...summary, status: undefined } }, repository),
    'older planning snapshots may omit status while still in the planning phase');
});

test('stale, superseded and foreign planning hints cannot resurrect or combine Runs', () => {
  const repository = '/repo';
  const summary: PlanningSummary = { planningId: 'review', runId: 'graph-run', repository,
    roles: {}, status: 'running', totalPlanningDuration: 0, modelDuration: 0 };
  const snapshot: Snapshot = { ...emptySnapshot, runId: 'graph-run', phase: 'running', planType: 'graph',
    config: { ...defaultConfig, repository }, planningId: 'review', planning: summary };
  for (const status of ['failed', 'success', 'cancelled']) {
    assert.equal(runningPlanningFromSnapshot(summary, { ...snapshot, planning: { ...summary, status } }, repository), null);
  }
  assert.equal(runningPlanningFromSnapshot(summary, { ...snapshot, planningId: 'new', planning: { ...summary, planningId: 'new' } }, repository), null);
  assert.equal(runningPlanningFromSnapshot(summary, { ...snapshot, runId: 'other-run' }, repository), null);
  assert.equal(runningPlanningFromSnapshot({ ...summary, repository: '/other' }, snapshot, repository), null);
  assert.equal(runningPlanningFromSnapshot(summary, { ...snapshot, config: { ...defaultConfig, repository: '/other' } }, repository), null);
  assert.equal(runningPlanningFromSnapshot(summary, { ...snapshot, planning: null }, repository), null,
    'an old running phase without a running Planner is not sufficient');
});

test('a newer live Planner turn retires the recovered snapshot instead of keeping it marked running', () => {
  const running = {
    planningId: 'review', roles: {}, totalPlanningDuration: 0, modelDuration: 0, status: 'running',
  };
  assert.equal(recoveredPlanningForDisplay(running, null, false, false)?.planningId, 'review');
  // A poll can discover a turn before its Run snapshot has a planning summary;
  // an absent snapshot summary must not erase that discovery.
  assert.equal(recoveredPlanningForDisplay(null, running, false, false), undefined);
  // A run switch can pair the previous run's terminal summary with the newly
  // discovered running turn; the older snapshot must not erase it.
  const previousRun = { ...running, planningId: 'old-run', status: 'failed', createdAt: 1 };
  const discovered = { ...running, planningId: 'new-run', status: 'running', createdAt: 2 };
  assert.equal(recoveredPlanningForDisplay(previousRun, discovered, false, false), undefined, 'keep the poll-discovered turn');
  // The browser owns a new stream: its live transcript is authoritative.
  assert.equal(recoveredPlanningForDisplay(running, running, true, false), null);
  // A request is in flight: an existing recovery stays (no unmount flash),
  // and a not-yet-adopted turn is not adopted mid-request.
  assert.equal(recoveredPlanningForDisplay(running, running, false, true)?.planningId, 'review');
  assert.equal(recoveredPlanningForDisplay(running, null, false, true), undefined);
  // Terminal snapshots never remain a recovered live turn.
  assert.equal(recoveredPlanningForDisplay({ ...running, status: 'failed' }, running, false, false), null);
  // A newer snapshot supersedes the recovered ID (the stale-display bug).
  const staleReview = { ...running, planningId: 'review', createdAt: 1 };
  const continuation = { ...running, planningId: 'continue', createdAt: 2 };
  assert.equal(recoveredPlanningForDisplay(continuation, staleReview, false, false)?.planningId, 'continue');
  assert.equal(recoveredPlanningForDisplay(continuation, staleReview, true, false), null);
});

test('Planner edit identifies a repeated turn by its timestamp or tree position, not first equal text', () => {
  const src = (id: string) => JSON.stringify({ type: 'pi_n_planning_source', planningId: id, startOffset: 0 });
  const turn = (text: string, timestamp?: number) => JSON.stringify({ type: 'message_start',
    message: { role: 'user', content: [{ type: 'text', text }], ...(timestamp ? { timestamp } : {}) } });
  const build = (timestamps: boolean) => [src('a'), turn('go', timestamps ? 10 : undefined), 'reply one',
    src('b'), turn('go', timestamps ? 20 : undefined), 'reply two',
    src('c'), turn('go', timestamps ? 30 : undefined), 'reply three'].join('\n') + '\n';
  const edit = { old_instruction: 'go', nextPlanningId: 'c' };
  const kept = (output: string) => ['reply one', 'reply two', 'reply three'].filter(reply => output.includes(reply));
  // Editing the middle turn keeps the earlier equal-text turn and the later one.
  assert.deepEqual(kept(activePlannerOutput(build(true), [{ ...edit, fromMessageTimestamp: 20 }])), ['reply one', 'reply three']);
  assert.deepEqual(kept(activePlannerOutput(build(false), [{ ...edit, fromOccurrence: 1 }], { firstPlanningId: 'a' })),
    ['reply one', 'reply three']);
  // A partial window cannot trust a whole-tree position, so it uses the legacy first match.
  assert.deepEqual(kept(activePlannerOutput(build(false), [{ ...edit, fromOccurrence: 1 }], { firstPlanningId: 'x' })), ['reply three']);
  // Events recorded before identities existed keep the legacy behavior.
  assert.deepEqual(kept(activePlannerOutput(build(true), [edit])), ['reply three']);
  // Sequential edits each resolve their own turn.
  assert.deepEqual(kept(activePlannerOutput(build(true), [{ ...edit, fromMessageTimestamp: 20 }, { old_instruction: 'go', fromMessageTimestamp: 10, nextPlanningId: 'b' }])),
    ['reply three']);
  assert.deepEqual(plannerConversationEdits([{ type: 'planner_conversation_edited', old_instruction: 'go', from_message_timestamp: 20, from_occurrence: 1 },
    { type: 'graph_revised', planning_id: 'c' }]), [{ old_instruction: 'go', nextPlanningId: 'c', fromMessageTimestamp: 20, fromOccurrence: 1 }]);
});

test('paged activePlannerOutput prunes abandoned turns even before the edited turn is paged in', () => {
  const src = (id: string) => JSON.stringify({ type: 'pi_n_planning_source', planningId: id, startOffset: 0 });
  const turn = (text: string, timestamp?: number) => JSON.stringify({ type: 'message_start',
    message: { role: 'user', content: [{ type: 'text', text }], ...(timestamp !== undefined ? { timestamp } : {}) } });
  const planningIds = ['p1', 'p2', 'p3', 'p4', 'p5'];
  // Tail window contains abandoned p3 & p4 plus replacement p5, while edited p1/p2 is not loaded yet.
  const tailWindow = [
    src('p3'), turn('abandoned 3', 30), 'reply 3',
    src('p4'), turn('abandoned 4', 40), 'reply 4',
    src('p5'), turn('replacement', 50), 'reply 5',
  ].join('\n') + '\n';

  // first_turn edit drops everything before replacement p5 in the tail window.
  const firstTurnOut = activePlannerOutput(tailWindow, [{ old_instruction: 'goal', nextPlanningId: 'p5', firstTurn: true }], { planningIds });
  assert.match(firstTurnOut, /reply 5/);
  assert.doesNotMatch(firstTurnOut, /reply 3|reply 4/);

  // Timestamp-identified non-first_turn edit drops p3/p4 (> 20) before p5 while preserving earlier p1 (< 20).
  const mixedWindow = [
    src('p1'), turn('goal', 10), 'reply 1',
    src('p3'), turn('abandoned 3', 30), 'reply 3',
    src('p5'), turn('replacement', 50), 'reply 5',
  ].join('\n') + '\n';
  const tsOut = activePlannerOutput(mixedWindow, [{ old_instruction: 'turn 2', nextPlanningId: 'p5', fromMessageTimestamp: 20 }], { planningIds });
  assert.match(tsOut, /reply 1/);
  assert.match(tsOut, /reply 5/);
  assert.doesNotMatch(tsOut, /reply 3/);

  // Goal-derived abandonedPlanningIds prunes abandoned tail turns even without timestamps.
  const events = [
    { type: 'created', planning_id: 'p1', planning: { planningId: 'p1', createdAt: 1, goal: 'goal' } },
    { type: 'graph_revised', planning_id: 'p2', planning: { planningId: 'p2', createdAt: 2, goal: 'turn 2' } },
    { type: 'graph_revised', planning_id: 'p3', planning: { planningId: 'p3', createdAt: 3, goal: 'abandoned 3' } },
    { type: 'graph_revised', planning_id: 'p4', planning: { planningId: 'p4', createdAt: 4, goal: 'abandoned 4' } },
    { type: 'planner_conversation_edited', old_instruction: 'turn 2' },
    { type: 'graph_revised', planning_id: 'p5', planning: { planningId: 'p5', createdAt: 5, goal: 'replacement' } },
  ];
  const edits = plannerConversationEdits(events);
  const noTsTail = [
    src('p3'), turn('abandoned 3'), 'reply 3',
    src('p4'), turn('abandoned 4'), 'reply 4',
    src('p5'), turn('replacement'), 'reply 5',
  ].join('\n') + '\n';
  const legacyOut = activePlannerOutput(noTsTail, edits, { planningIds });
  assert.match(legacyOut, /reply 5/);
  assert.doesNotMatch(legacyOut, /reply 3|reply 4/);

  // A tail window strictly after the replacement revision is left untouched.
  const laterOnly = [src('p6'), turn('follow-up after edit', 60), 'reply 6'].join('\n') + '\n';
  assert.equal(
    activePlannerOutput(laterOnly, [{ old_instruction: 'goal', nextPlanningId: 'p5', firstTurn: true }], { planningIds: [...planningIds, 'p6'] }),
    laterOnly,
  );
});
