import { expect, test } from 'bun:test';
import { advanceAttempt, advanceEffect, createRun, publicationEligible, reduceRun, runStatus,
  taskStatuses, validateGraph, type Graph } from '../../src/authoring';
import { command, completed, graph, hash, prepare, ref, step, task } from './fixtures';

test.each(['cycle', 'foreign', 'missing', 'duplicate', 'stale', 'repeated-edge'])('graph rejects %s dependencies', kind => {
  const input = graph();
  const a = input.tasks[0];
  const b = input.tasks[1];
  if (!a || !b) throw new Error('fixture');
  if (kind === 'cycle') a.dependsOn.push(b.ref);
  if (kind === 'foreign') b.dependsOn = [{ ...a.ref, owner: { ...a.ref.owner, runId: 'other_run' } }];
  if (kind === 'missing') b.dependsOn = [ref('task', 'missing')];
  if (kind === 'duplicate') input.tasks.push(a);
  if (kind === 'stale') b.dependsOn = [{ ...a.ref, hash: hash(9) }];
  if (kind === 'repeated-edge') b.dependsOn.push(a.ref);
  expect(() => validateGraph(input)).toThrow();
});

test('phase graph accepts 1024 nodes in a causal chain; refuses 1025', () => {
  const input = graph();
  input.tasks = Array.from({ length: 1024 }, (_, i) => task(`task_${i}`, i ? [`task_${i - 1}`] : []));
  expect(validateGraph(input).tasks).toHaveLength(1024);
  const statuses = taskStatuses(createRun(input));
  expect(statuses.task_0).toBe('ready');
  expect(statuses.task_1023).toBe('blocked');
  input.tasks.push(task('overflow'));
  expect(() => validateGraph(input)).toThrow('task-count');
});

test('snapshots do not alias inputs; duplicate command requires equal digest AND payload', () => {
  const input = graph();
  const initial = createRun(input);
  input.tasks.length = 0;
  expect(initial.graph.tasks).toHaveLength(4);
  const cmd = command(initial, { type: 'question', questionId: 'q', keys: ['mara'] });
  const next = reduceRun(initial, cmd);
  expect(reduceRun(next, cmd)).toBe(next);
  expect(() => reduceRun(next, { ...cmd, payloadDigest: hash(2) })).toThrow('command-replay-mismatch');
  expect(() => reduceRun(next, { ...cmd, action: { type: 'pause' } })).toThrow('command-replay-mismatch');
  cmd.action = { type: 'cancel' };
  expect(initial.questions).toHaveLength(0);
  expect(next.questions).toHaveLength(1);
  expect(Object.isFrozen(next.questions[0]?.keys)).toBe(true);
});

test('prepared, dispatch, output-kept, validated and adopted are distinct dependency boundaries', () => {
  let state = createRun(graph());
  expect(taskStatuses(state)).toEqual({ a: 'ready', b: 'blocked', c: 'ready', u: 'ready' });
  state = prepare(state);
  expect(() => step(state, { type: 'attempt', attemptId: 'attempt_a', event: 'completed' })).toThrow('impossible-attempt-transition');
  state = step(state, { type: 'attempt', attemptId: 'attempt_a', event: 'dispatch-intent' });
  expect(() => step(state, { type: 'attempt', attemptId: 'attempt_a', event: 'dispatch-intent' })).toThrow('impossible-attempt-transition');
  state = step(state, { type: 'attempt', attemptId: 'attempt_a', event: 'receiving' });
  state = step(state, { type: 'attempt', attemptId: 'attempt_a', event: 'output-kept', outputs: [ref('artifact', 'candidate')] });
  expect(taskStatuses(state).a).toBe('validating');
  expect(publicationEligible(state, 'attempt_a')).toBe(false);
  state = step(state, { type: 'attempt', attemptId: 'attempt_a', event: 'completed' });
  expect(publicationEligible(state, 'attempt_a')).toBe(true);
  expect(taskStatuses(state).b).toBe('blocked');
  state = step(state, { type: 'prepare-effect', attemptId: 'attempt_a', effect: ref('effect', 'effect_1'), candidate: ref('artifact', 'candidate') });
  expect(() => step(state, { type: 'effect', effectId: 'effect_1', event: 'confirmed', receipt: ref('effect', 'effect_1', 1) })).toThrow('impossible-effect-transition');
  state = step(state, { type: 'effect', effectId: 'effect_1', event: 'publish-intent' });
  expect(() => step(state, { type: 'effect', effectId: 'effect_1', event: 'confirmed' })).toThrow('missing-effect-receipt');
  state = step(state, { type: 'effect', effectId: 'effect_1', event: 'confirmed', receipt: ref('effect', 'effect_1', 1) });
  expect(taskStatuses(state).a).toBe('completed');
  expect(taskStatuses(state).b).toBe('ready');
});

test('unanswered question closes affected publication, blocks descendants/unknown impact, allows proven independent work', () => {
  let state = completed(createRun(graph()));
  state = step(state, { type: 'question', questionId: 'mara_choice', keys: ['mara'] });
  expect(taskStatuses(state)).toEqual({ a: 'blocked', b: 'blocked', c: 'ready', u: 'blocked' });
  expect(publicationEligible(state, 'attempt_a')).toBe(false);
  state = completed(state, 'c');
  expect(taskStatuses(state).c).toBe('completed');
  expect(() => step(state, { type: 'finish' })).toThrow('unfinished-run');
  const answer = { type: 'answer' as const, questionId: 'mara_choice', questionRevision: 0,
    direction: ref('direction', 'direction_1', 1), exactText: '  protective lie\n', confirmedText: 'Protective lie' };
  state = step(state, answer);
  expect(state.questions[0]?.answer?.exactText).toBe('  protective lie\n');
  expect(state.attempts[0]?.historical).toBe(true);
  expect(taskStatuses(state).a).toBe('ready');
  expect(taskStatuses(state).c).toBe('completed');
  expect(() => step(state, answer)).toThrow('stale-question');
  expect(() => step(state, { type: 'prepare', taskId: 'a', attempt: ref('attempt', 'new_attempt'),
    context: ref('context', 'ctx'), direction: ref('direction', 'direction_0'), inputDigest: hash() })).toThrow('stale-direction');
});

test('late old-direction output stays historical; current dependent work waits for real settlement', () => {
  let state = prepare(createRun(graph()));
  state = step(state, { type: 'attempt', attemptId: 'attempt_a', event: 'dispatch-intent' });
  state = step(state, { type: 'direction', keys: ['mara'], direction: ref('direction', 'direction_1', 1), exactText: 'new direction' });
  expect(taskStatuses(state).a).toBe('settling');
  state = step(state, { type: 'attempt', attemptId: 'attempt_a', event: 'output-kept', outputs: [ref('artifact', 'late')] });
  state = step(state, { type: 'attempt', attemptId: 'attempt_a', event: 'completed' });
  expect(state.attempts[0]?.outputs[0]?.id).toBe('late');
  expect(publicationEligible(state, 'attempt_a')).toBe(false);
  expect(taskStatuses(state).a).toBe('ready');
  expect(prepare(state, 'a', 'fresh_attempt').attempts[1]?.direction.id).toBe('direction_1');
});

test.each(['pause', 'revoke', 'cancel'] as const)('%s beats a late answer and late output; settlement is not a timeout', control => {
  let state = prepare(createRun(graph()));
  state = step(state, { type: 'attempt', attemptId: 'attempt_a', event: 'dispatch-intent' });
  state = step(state, { type: 'question', questionId: 'q', keys: ['mara'] });
  const answer = command(state, { type: 'answer', questionId: 'q', questionRevision: 0,
    direction: ref('direction', 'direction_1', 1), exactText: 'yes', confirmedText: 'yes' });
  state = step(state, { type: control });
  expect(() => reduceRun(state, { ...answer, id: 'late_answer', expectedRevision: state.revision })).toThrow('stale-generation');
  expect(() => step(state, answer.action)).toThrow();
  expect(['pausing', 'revoking', 'cancelling']).toContain(runStatus(state));
  state = step(state, { type: 'attempt', attemptId: 'attempt_a', event: 'output-kept', outputs: [ref('artifact', 'late')] });
  state = step(state, { type: 'attempt', attemptId: 'attempt_a', event: 'completed' });
  expect(publicationEligible(state, 'attempt_a')).toBe(false);
  expect(['paused', 'revoked', 'cancelled']).toContain(runStatus(state));
  if (control !== 'pause') expect(() => step(state, { type: 'resume' })).toThrow('terminal-run');
});

test('independent completed work survives pause/resume and fresh local recovery', () => {
  let state = completed(createRun(graph()), 'c');
  state = step(state, { type: 'pause' });
  state = step(state, { type: 'pause' });
  state = step(state, { type: 'recover' });
  state = step(state, { type: 'resume' });
  expect(taskStatuses(state).c).toBe('completed');
  state = step(state, { type: 'recover' });
  state = step(state, { type: 'resume' });
  expect(taskStatuses(state).c).toBe('completed');
  expect(state.attempts).toHaveLength(1);
});

test('direction change during publication intent stays settling and cannot retry or count late adoption as current', () => {
  let state = completed(createRun(graph()));
  state = step(state, { type: 'prepare-effect', effect: ref('effect', 'effect_1'), attemptId: 'attempt_a', candidate: ref('artifact', 'output_attempt_a') });
  state = step(state, { type: 'effect', effectId: 'effect_1', event: 'publish-intent' });
  state = step(state, { type: 'direction', keys: ['mara'], direction: ref('direction', 'direction_1', 1), exactText: 'changed' });
  expect(taskStatuses(state).a).toBe('settling');
  expect(() => prepare(state, 'a', 'new')).toThrow('task-not-ready');
  state = step(state, { type: 'effect', effectId: 'effect_1', event: 'confirmed', receipt: ref('effect', 'effect_1', 1) });
  expect(state.effects[0]?.phase).toBe('confirmed');
  expect(taskStatuses(state).a).toBe('ready');
  expect(taskStatuses(state).b).toBe('blocked');
});

test('recovery classifies known-unsent separately and refuses automatic replay of uncertain effects/calls', () => {
  let state = prepare(createRun(graph()));
  state = prepare(state, 'c');
  state = step(state, { type: 'attempt', attemptId: 'attempt_a', event: 'dispatch-intent' });
  state = step(state, { type: 'recover' });
  expect(state.attempts.map(a => a.phase)).toEqual(['uncertain', 'stopped']);
  expect(runStatus(state)).toBe('pausing');
  expect(() => step(state, { type: 'attempt', attemptId: 'attempt_a', event: 'dispatch-intent' })).toThrow('dispatch-gate-closed');
  state = step(state, { type: 'resume' });
  expect(taskStatuses(state).a).toBe('uncertain');
  expect(taskStatuses(state).b).toBe('blocked');
  expect(taskStatuses(state).c).toBe('ready');
  expect(() => prepare(state, 'a', 'replay')).toThrow('task-not-ready');
  expect(advanceEffect('prepared', 'recover')).toBe('not-published');
  expect(advanceEffect('publish-intent', 'recover')).toBe('uncertain');
  expect(() => advanceEffect('uncertain', 'publish-intent')).toThrow('impossible-effect-transition');
  expect(() => advanceAttempt('uncertain', 'dispatch-intent')).toThrow('impossible-attempt-transition');
});

test('a still-live attempt prevents resume, while answers cannot reuse immutable direction IDs', () => {
  let state = prepare(createRun(graph()));
  state = step(state, { type: 'pause' });
  expect(() => step(state, { type: 'resume' })).toThrow('unsettled-resume');
  state = step(state, { type: 'attempt', attemptId: 'attempt_a', event: 'stopped' });
  state = step(state, { type: 'resume' });
  state = step(state, { type: 'direction', keys: ['mara'], direction: ref('direction', 'direction_1', 1), exactText: 'new' });
  expect(() => step(state, { type: 'direction', keys: ['mara'], direction: ref('direction', 'direction_0', 2), exactText: 'reuse' })).toThrow('duplicate-direction');
});

test('failure parks work until explicit new-attempt intent; no completed output or identity can be reused', () => {
  let state = prepare(createRun(graph()));
  state = step(state, { type: 'attempt', attemptId: 'attempt_a', event: 'failed' });
  expect(taskStatuses(state).a).toBe('failed');
  expect(() => prepare(state, 'a', 'retry')).toThrow('task-not-ready');
  state = step(state, { type: 'retry', taskId: 'a' });
  expect(() => prepare(state)).toThrow('duplicate-attempt');
  state = prepare(state, 'a', 'retry');
  expect(state.attempts).toHaveLength(2);
});

test('safe-integer generation exhaustion rejects stop mutation and preserves previous snapshot', () => {
  const input: Graph = { ...graph(), generation: Number.MAX_SAFE_INTEGER };
  const state = createRun(input);
  expect(() => step(state, { type: 'pause' })).toThrow('invalid-integer');
  expect(state.mode).toBe('running');
});

test('final review is separate from author-finished and refuses terminal resurrection', () => {
  const input = graph(); input.tasks = [task('c')];
  let state = completed(createRun(input), 'c');
  expect(runStatus(state)).toBe('final-review-ready');
  state = step(state, { type: 'finish' });
  expect(runStatus(state)).toBe('finished');
  expect(() => step(state, { type: 'resume' })).toThrow('terminal-run');
});

test('an identical revision output stays retained but parks for direction rather than publication or automatic retry', () => {
  const input = graph();
  input.tasks = [{ ...task('revision'), role: 'revision-writer', completion: 'adoption' }];
  let state = createRun(input);
  expect(() => prepare(state, 'revision')).toThrow('missing-revision-base');
  state = step(state, { type: 'prepare', taskId: 'revision', attempt: ref('attempt', 'revision_attempt'),
    context: ref('context', 'ctx'), direction: ref('direction', 'direction_0'), inputDigest: hash(3),
    revisionOf: ref('artifact', 'original') });
  state = step(state, { type: 'attempt', attemptId: 'revision_attempt', event: 'dispatch-intent' });
  state = step(state, { type: 'attempt', attemptId: 'revision_attempt', event: 'output-kept', outputs: [ref('artifact', 'unchanged')] });
  state = step(state, { type: 'attempt', attemptId: 'revision_attempt', event: 'completed' });
  expect(taskStatuses(state).revision).toBe('needs-direction');
  expect(publicationEligible(state, 'revision_attempt')).toBe(false);
  expect(state.attempts[0]?.outputs[0]?.id).toBe('unchanged');
  expect(() => step(state, { type: 'retry', taskId: 'revision' })).toThrow('retry-not-eligible');
});

test('direction text uses the bounded record envelope without inheriting the brief word/unit ceiling', () => {
  const exactText = `  ${'author direction '.repeat(1500)}\n`;
  const state = step(createRun(graph()), { type: 'direction', keys: ['mara'],
    direction: ref('direction', 'direction_1', 1), exactText });
  expect(state.commands[0]?.action).toMatchObject({ exactText });
});

function dispatchedIsland(): ReturnType<typeof createRun> {
  const state = step(prepare(createRun(graph()), 'c'), { type: 'attempt', attemptId: 'attempt_c', event: 'dispatch-intent' });
  return step(state, { type: 'direction', keys: ['mara'], direction: ref('direction', 'direction_1', 1), exactText: 'mara only' });
}

test('an unrelated in-flight attempt continues through a mara-only direction change', () => {
  const generation = createRun(graph()).generation;
  const state = dispatchedIsland();
  expect(state.generation).toBe(generation);
  expect(state.attempts).toHaveLength(1);
  const attempt = state.attempts[0];
  expect(attempt?.historical).toBe(false);
  expect(attempt?.generation).toBe(generation);
  expect(attempt?.phase).toBe('dispatch-intent');
  expect(attempt?.direction.id).toBe('direction_0');
  expect(Object.fromEntries(state.tasks.map(task => [task.id, task.direction.id]))).toEqual({
    a: 'direction_1', b: 'direction_1', c: 'direction_0', u: 'direction_1' });
  expect(taskStatuses(state)).toEqual({ a: 'ready', b: 'blocked', c: 'executing', u: 'ready' });
  const kept = step(state, { type: 'attempt', attemptId: 'attempt_c', event: 'output-kept', outputs: [ref('artifact', 'island')] });
  const done = step(kept, { type: 'attempt', attemptId: 'attempt_c', event: 'completed' });
  expect(done.attempts).toHaveLength(1);
  expect(done.attempts[0]?.ref.id).toBe('attempt_c');
  expect(done.attempts[0]?.historical).toBe(false);
  expect(done.attempts[0]?.generation).toBe(generation);
  expect(done.attempts[0]?.phase).toBe('completed');
  expect(done.attempts[0]?.direction.id).toBe('direction_0');
  expect(taskStatuses(done)).toEqual({ a: 'ready', b: 'blocked', c: 'completed', u: 'ready' });
});

test('a later stop closes that independent continuation and refuses its output', () => {
  const state = step(dispatchedIsland(), { type: 'attempt', attemptId: 'attempt_c', event: 'stopped' });
  expect(state.mode).toBe('running');
  expect(runStatus(state)).toBe('active');
  expect(state.attempts).toHaveLength(1);
  expect(state.attempts[0]?.phase).toBe('stopped');
  expect(state.attempts[0]?.historical).toBe(false);
  expect(state.tasks.find(task => task.id === 'c')?.retryAllowed).toBe(false);
  expect(taskStatuses(state).c).toBe('failed');
  expect(() => step(state, { type: 'attempt', attemptId: 'attempt_c', event: 'output-kept', outputs: [ref('artifact', 'late')] })).toThrow('impossible-attempt-transition');
  expect(() => step(state, { type: 'attempt', attemptId: 'attempt_c', event: 'completed' })).toThrow('impossible-attempt-transition');
  expect(state.attempts[0]?.phase).toBe('stopped');
  expect(state.attempts[0]?.outputs).toHaveLength(0);
  expect(() => prepare(state, 'c', 'attempt_c_again')).toThrow('task-not-ready');
});
