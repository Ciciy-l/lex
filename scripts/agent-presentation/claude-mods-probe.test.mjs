import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from './claude-mods-fixture.mjs';
import { fixturePrompt } from './claude-mods-probe.mjs';

test('same-model title requests are not main turns; only the latest native input block identifies a fixture turn', () => {
  assert.equal(fixturePrompt([{ role: 'user', content: [{ type: 'text', text: '<session>\nLEX_MODS_NATIVE\n</session>\n\nWrite the title in the predominant language of the session' }] }]), undefined);
  assert.equal(fixturePrompt([{ role: 'user', content: 'LEX_MODS_NATIVE' }]), 'LEX_MODS_NATIVE');
  assert.equal(fixturePrompt([{ role: 'user', content: 'LEX_MODS_FIRST' }, { role: 'assistant', content: 'LEX_MODS_FIRST_RESULT' },
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>irrelevant</system-reminder>' },
      { type: 'text', text: 'The lex-mods-probe plugin sent a message:\nLEX_MODS_QUEUED\n\nPlugin provenance.' }] }]), 'LEX_MODS_QUEUED');
});

test('tool results continue the preceding fixture turn without classifying unrelated later input as that turn', () => {
  const history = [{ role: 'user', content: 'LEX_MODS_FIRST' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'one', name: 'Write', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'one', is_error: true, content: 'denied' }] }];
  assert.equal(fixturePrompt(history), 'LEX_MODS_FIRST');
  assert.equal(fixturePrompt([...history, { role: 'user', content: 'unrelated next input' }]), undefined);
  assert.equal(fixturePrompt([...history, { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'two', content: 'value' }, { type: 'text', text: 'unrelated input' }] }]), undefined);
});

function fixture() {
  const hooks = new Map();
  const batches = [];
  const inputs = [];
  const commands = [];
  let tick;
  const $ = {
    env: { get: async (key) => key === 'LEX_MODS_ENDPOINT' ? 'http://127.0.0.1:1234' : 'synthetic-token' },
    session: { id: async () => 'native-session', messages: async () => [], usage: async () => ({}) },
    clock: { every: (ms, callback) => { tick = callback; return { cancel() {} }; } },
    http: { fetch: async (url, options) => {
      batches.push(JSON.parse(options.body));
      return { ok: true, text: JSON.stringify({ commands: commands.splice(0) }) };
    } },
    prompt: { submit: async (input) => { inputs.push(input); return { text: input.text }; },
      read: async () => ({ text: 'unfinished native draft', cursor: 5 }) },
    turn: { abort: async ({ turnId }) => { if (turnId !== 'current') throw new Error('Stale turn'); } },
  };
  register((name, fn) => hooks.set(name, fn));
  return { $, hooks, batches, inputs, commands, tick: () => tick(),
    start: () => hooks.get('session.start')($, { cwd: '/fixture', surface: 'terminal', isInteractive: true }, async (e) => ({ cwd: e.cwd })) };
}

test('stream mirror preserves every chunk by identity, order and result with exactly one downstream call', async () => {
  const f = fixture();
  await f.start();
  const chunks = [Object.freeze({ kind: 'engine', ref: 1 }), Object.freeze({ kind: 'text', index: 0, text: 'hello' }),
    Object.freeze({ kind: 'tool', index: 1, id: 'tool-id', name: 'Read' }),
    Object.freeze({ kind: 'input', index: 1, json: '{}' }), Object.freeze({ kind: 'stop', stopReason: 'tool_use' })];
  const result = Object.freeze({ answer: 'hello' });
  const event = Object.freeze({ turnId: 'current', index: 0 });
  let calls = 0;
  const stream = (async function* () { yield* chunks; return result; })();
  // A disconnected/slow observer never blocks the engine stream.
  f.$.http.fetch = () => new Promise(() => {});
  void f.tick();
  const mirror = f.hooks.get('turn.step')(f.$, event, (input) => { calls++; assert.equal(input, event); return stream; });
  for (const expected of chunks) assert.equal((await mirror.next()).value, expected);
  assert.deepEqual(await mirror.next(), { done: true, value: result });
  assert.equal(calls, 1);
});

test('semantic command duplicates do not submit twice, native draft is read without modification, stale abort is reported', async () => {
  const f = fixture(); await f.start();
  f.commands.push({ id: 'one', kind: 'submit', text: 'queued' }, { id: 'one', kind: 'submit', text: 'queued' },
    { id: 'two', kind: 'snapshot' }, { id: 'three', kind: 'abort', turnId: 'old' });
  await f.tick(); await new Promise((resolve) => setImmediate(resolve)); await f.tick();
  assert.deepEqual(f.inputs, [{ text: 'queued' }]);
  const events = f.batches.flatMap((b) => b.events);
  assert.deepEqual(events.find((e) => e.kind === 'ack' && e.value.id === 'two').value.result.draft, { text: 'unfinished native draft', cursor: 5 });
  assert.match(events.find((e) => e.kind === 'command-error').value.message, /Stale turn/);
  assert.ok(events.every((e) => e.sessionId === 'native-session'));
});

test('bounded observer explicitly reports dropped events instead of blocking native generation', async () => {
  const f = fixture(); await f.start();
  const event = { turnId: 'current', index: 0 };
  const stream = (async function* () { for (let i = 0; i < 300; i++) yield { kind: 'text', index: 0, text: 'x' }; })();
  stream.result = Promise.resolve({ answer: 'x'.repeat(300) });
  let count = 0;
  for await (const chunk of f.hooks.get('turn.step')(f.$, event, () => stream)) count++;
  await f.tick();
  assert.equal(count, 300);
  assert.ok(f.batches[0].dropped > 0);
  assert.equal(f.batches[0].events.length, 128);
});

test('pending native submission does not block streaming event delivery or abort dispatch', async () => {
  const f = fixture(); await f.start();
  let finish;
  let aborted = false;
  f.$.prompt.submit = () => new Promise((resolve) => { finish = resolve; });
  f.$.turn.abort = async () => { aborted = true; };
  f.commands.push({ id: 'pending', kind: 'submit', text: 'wait until idle' });
  await f.tick();
  await f.hooks.get('turn.start')(f.$, { turnId: 'current', text: 'still working' }, async (e) => e);
  f.commands.push({ id: 'stop', kind: 'abort', turnId: 'current' });
  await f.tick();
  assert.equal(aborted, true);
  assert.ok(f.batches.flatMap((b) => b.events).some((e) => e.kind === 'turn.start'));
  assert.ok(!f.batches.flatMap((b) => b.events).some((e) => e.kind === 'ack' && e.value.id === 'pending'));
  finish({ text: 'accepted' });
  await new Promise((resolve) => setImmediate(resolve)); await f.tick();
  assert.ok(f.batches.flatMap((b) => b.events).some((e) => e.kind === 'ack' && e.value.id === 'pending'));
});

test('closing the observing generator closes its one downstream stream', async () => {
  const f = fixture(); await f.start();
  let closed = false;
  const stream = (async function* () {
    try { yield { kind: 'text', index: 0, text: 'partial' }; yield { kind: 'engine', ref: 2 }; }
    finally { closed = true; }
  })();
  const mirror = f.hooks.get('turn.step')(f.$, { turnId: 'current', index: 0 }, () => stream);
  await mirror.next(); await mirror.return();
  assert.equal(closed, true);
});

test('serialized submissions bind distinct native UUIDs even for repeated text and interleaved external plugin messages', async () => {
  const f = fixture(); await f.start();
  const waiters = [];
  f.$.prompt.submit = ({ text }) => new Promise((resolve) => { f.inputs.push({ text }); waiters.push(resolve); });
  f.commands.push({ id: 'first', kind: 'submit', text: 'same' }, { id: 'second', kind: 'submit', text: 'same' });
  await f.tick();
  const append = async (uuid, origin, extra = {}) => {
    const input = { uuid, door: 'prompt', origin, message: { type: 'user', content: [{ type: 'text', text: 'same' }] }, ...extra };
    const stored = { uuid, message: input.message };
    assert.equal(await f.hooks.get('session.append')(f.$, input, async (e) => {
      assert.equal(e, input); return stored;
    }), stored);
  };
  assert.equal(f.inputs.length, 1);
  await append('external', { kind: 'plugin', name: 'lex-mods-probe-other' });
  await append('child', { kind: 'plugin', name: 'lex-mods-probe' }, { agentId: 'child' });
  await append('one', { kind: 'plugin', name: 'lex-mods-probe' });
  await append('extra', { kind: 'plugin', name: 'lex-mods-probe' });
  waiters.shift()({ text: 'same' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.inputs.length, 2);
  await append('two', { kind: 'plugin', name: 'lex-mods-probe' });
  waiters.shift()({ text: 'same' });
  await new Promise((resolve) => setImmediate(resolve));
  await f.tick();
  const rows = f.batches.flatMap((b) => b.events).filter((e) => e.kind === 'session.append');
  assert.deepEqual(rows.filter((e) => e.value.submissionId).map((e) => [e.value.uuid, e.value.submissionId]),
    [['one', 'first'], ['two', 'second']]);
});
