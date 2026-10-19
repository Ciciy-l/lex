import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { CodexNativeTaskPresentation } from './native-task-presentation.js';

function fixture() {
  const warnings: string[] = [], task = new CodexNativeTaskPresentation(message => warnings.push(message));
  const service = new AbortController(); let current = true, closes = 0;
  const presentation = { marker: true } as never;
  const handle = { id: 'owned-thread' } as never;
  const launch = { handle, cwd: '/fixture', service: { endpoint: { url: 'ws://127.0.0.1:1', token: 'invalid-fixture-token' },
    signal: service.signal, isCurrent: () => !service.signal.aborted }, isCurrent: () => current, routingContext: { ownsDescendant: () => false,
      titleContext: () => ({ model: 'fixture-model', mcpServers: [] }) } };
  const owner = { presentation, ready: Promise.resolve(), async close() { closes++; } };
  return { task, launch, owner, service, warnings, expire() { current = false; }, get closes() { return closes; } };
}
describe('Codex task-owned frontend lifetime', () => {
  it('publishes one presentation and closes only its frontend', async () => {
    const f = fixture(); let signal!: AbortSignal; let isCurrent!: () => boolean;
    await f.task.start(async launch => { signal = launch.signal; isCurrent = launch.isCurrent; return f.owner; }, f.launch);
    assert.equal(f.task.presentation, f.owner.presentation); assert.equal(isCurrent(), true);
    await assert.rejects(f.task.start(async () => f.owner, f.launch), /already/);
    await f.task.close(); await f.task.close();
    assert.equal(f.closes, 1); assert.equal(signal.aborted, true); assert.equal(isCurrent(), false);
    assert.equal(f.service.signal.aborted, false); assert.equal(f.task.presentation, undefined);
  });
  it('revokes its frontend when the concrete service generation expires', async () => {
    const f = fixture(); await f.task.start(async () => f.owner, f.launch);
    f.service.abort(); assert.equal(f.task.presentation, undefined); await f.task.close();
    assert.equal(f.closes, 1);
  });
  it('cleans a late factory result after task close without ever exposing it', async () => {
    const f = fixture(); let complete!: () => void, entered!: () => void;
    const running = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { complete = resolve; });
    const start = f.task.start(async () => { entered(); await held; return f.owner; }, f.launch);
    await running; const rejected = assert.rejects(start, /changed/); const closed = f.task.close();
    complete(); await Promise.all([closed, rejected]); assert.equal(f.closes, 1); assert.equal(f.task.presentation, undefined);
  });
  it('cleans a factory result if the task changes during frontend creation', async () => {
    const f = fixture();
    await assert.rejects(f.task.start(async () => { f.expire(); return f.owner; }, f.launch), /changed/);
    assert.equal(f.closes, 1); assert.equal(f.task.presentation, undefined);
  });
  it('records unconfirmed close without reporting successful task disposal', async () => {
    const f = fixture(); await f.task.start(async () => ({ presentation: f.owner.presentation, ready: Promise.resolve(),
      async close() { throw new Error('fixture exit unconfirmed'); } }), f.launch);
    f.service.abort(); await assert.rejects(f.task.close(), /unconfirmed/);
    assert.equal(f.warnings.length, 1); assert.equal(f.task.presentation, undefined);
  });
  it('a synchronous service retirement inside the factory still closes its returned owner', async () => {
    const f = fixture();
    await assert.rejects(f.task.start(async () => { f.service.abort(); return f.owner; }, f.launch), /changed/);
    assert.equal(f.closes, 1);
  });
  it('shares the close receipt with a synchronous abort observer', async () => {
    const f = fixture(); let nested: Promise<void> | undefined;
    await f.task.start(async launch => {
      launch.signal.addEventListener('abort', () => { nested = f.task.close(); }, { once: true });
      return f.owner;
    }, f.launch);
    const closed = f.task.close(); assert.equal(nested, closed); await closed; assert.equal(f.closes, 1);
  });
  it('does not expose a frontend after its task binding has changed', async () => {
    const f = fixture(); await f.task.start(async () => f.owner, f.launch);
    f.expire(); assert.equal(f.task.presentation, undefined); await f.task.close(); assert.equal(f.closes, 1);
  });
  it('keeps the PTY private until its real resume receipt and closes a pending receipt without a cycle', async () => {
    const f = fixture(); let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const start = f.task.start(async () => ({ ...f.owner,
      get ready() { entered(); return new Promise<void>(() => {}); },
    }), f.launch);
    const rejected = assert.rejects(start, /owner-changed/);
    await started; assert.equal(f.task.presentation, undefined);
    await f.task.close(); await rejected;
    assert.equal(f.closes, 1); assert.equal(f.service.signal.aborted, false);
  });
  it('does not launch after cancellation during storage preparation, including a late read', async () => {
    const f = fixture(), owner = new AbortController(); let finish!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const begun = new Promise<void>(resolve => { entered = resolve; });
    let factories = 0;
    const start = f.task.start(async () => { factories++; return f.owner; }, { ...f.launch, ownerSignal: owner.signal }, async () => { entered(); await held; });
    const rejected = assert.rejects(start, /owner-changed/);
    await begun; owner.abort(); await rejected; finish(); await f.task.close();
    assert.equal(factories, 0); assert.equal(f.service.signal.aborted, false);
  });
});
