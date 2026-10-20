import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createCodexNativePresentation } from '../codex-native-presentation.js';
import type { AgentTerminalLaunch } from '../../terminal/agentTerminalDriver.js';

function driver() {
  const exits = new Set<(exit: { code: number | null }) => void>();
  const writes: string[] = [];
  let closes = 0;
  return { pid: 1234, writes, get closes() { return closes; },
    write(data: string) { writes.push(data); }, resize() {}, onData() { return () => {}; },
    onExit(fn: (exit: { code: number | null }) => void) { exits.add(fn); return () => { exits.delete(fn); }; },
    async close() { closes++; for (const fn of [...exits]) fn({ code: 0 }); },
    exit() { for (const fn of [...exits]) fn({ code: 0 }); },
  };
}
async function fixture() {
  const parent = await mkdtemp(path.join(tmpdir(), 'lex-native-presentation-test-'));
  const native = driver(); const launches: AgentTerminalLaunch[] = [], observed: string[] = [];
  const capability = randomBytes(32).toString('base64url');
  const abort = new AbortController();
  const options = {
    handle: { id: 'owned-thread', attachNativeApprovalFrontend: () => ({ answer: () => false, detach() {} }) },
    endpoint: { url: 'ws://127.0.0.1:1', token: capability }, executable: '/fake/codex', cwd: parent,
    env: { PATH: '/fake/bin', HOME: '/never-read-this', OPENAI_API_KEY: 'invalid-fixture-key', CODEX_HOME: '/never-read-codex', CLAUDE_CODE_OAUTH_TOKEN: 'invalid-fixture-token' },
    tempRoot: parent, signal: abort.signal, isCurrent: () => true,
    request: async () => ({}), notification: () => null,
    registerProcess: (pid: number) => { observed.push('register:' + pid); return () => { observed.push('unregister'); }; },
    logger: { warn: (message: string) => observed.push(message) },
  };
  const start = () => createCodexNativePresentation(options, spec => { launches.push(spec); return native; });
  return { parent, native, launches, observed, options, abort, start,
    cleanup: () => rm(parent, { recursive: true, force: true }) };
}
async function until(predicate: () => Promise<boolean>) {
  for (let n = 0; n < 100; n++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('cleanup deadline');
}
describe('task-owned original Codex terminal frontend', () => {
  it('launches only a remote frontend with an independent private home and credential', async () => {
    const f = await fixture(); let view: Awaited<ReturnType<typeof f.start>> | undefined;
    try { view = await f.start(); const spec = f.launches[0]!;
      assert.equal(spec.args[0], 'resume'); assert.equal(spec.args[1], 'owned-thread'); assert.equal(spec.cwd, f.parent);
      assert.equal(spec.env.OPENAI_API_KEY, undefined); assert.equal(spec.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
      assert.notEqual(spec.env.LEX_CODEX_FRONTEND_TOKEN, f.options.endpoint.token);
      assert.equal(JSON.stringify(spec).includes(f.options.endpoint.token), false);
      assert.notEqual(spec.env.HOME, f.options.env.HOME); await access(spec.env.CODEX_HOME!);
      assert.deepEqual(f.observed, ['register:1234']); await view.close();
      await assert.rejects(access(spec.env.HOME!)); assert.deepEqual(f.observed, ['register:1234', 'unregister']);
    } finally { await view?.close(); await f.cleanup(); }
  });
  it('detach and reattach keep the frontend and native task identity', async () => {
    const f = await fixture(); const view = await f.start();
    try { const a = view.presentation.attach('a', () => {}); const control = a.acquireControl()!;
      a.write(control, 1, 'draft'); const before = view.presentation.state(); a.detach();
      const b = view.presentation.attach('b', () => {}); const after = b.read().state;
      assert.equal(after.generation, before.generation); assert.equal(after.nativeSessionId, 'owned-thread');
      assert.equal(f.native.closes, 0); assert.equal(f.launches.length, 1);
      assert.throws(() => a.write(control, 2, 'stale'), /expired/);
    } finally { await view.close(); await f.cleanup(); }
  });
  it('a natural frontend exit retires its capability/home while leaving the presentation readable', async () => {
    const f = await fixture(); const view = await f.start();
    try { f.native.exit(); await until(async () => (await readdir(f.parent)).length === 0);
      assert.equal(view.presentation.state().status, 'exited'); assert.equal(f.native.closes, 0);
      assert.deepEqual(f.observed, ['register:1234', 'unregister']);
    } finally { await view.close(); await f.cleanup(); }
  });
  it('task cancellation closes the native frontend and cleans its owned resources', async () => {
    const f = await fixture(); const view = await f.start();
    try { f.abort.abort(); await view.close(); assert.equal(f.native.closes, 1); assert.deepEqual(await readdir(f.parent), []);
    } finally { await f.cleanup(); }
  });
  it('keeps the frontend home when native process exit cannot be confirmed', async () => {
    const f = await fixture(); f.native.close = async () => { throw new Error('fixture exit unknown'); };
    const view = await f.start();
    try { await assert.rejects(view.close(), /exit unknown/); await access(f.launches[0]!.env.HOME!);
      assert.deepEqual(f.observed, ['register:1234']);
    } finally { f.native.exit(); await until(async () => (await readdir(f.parent)).length === 0); await f.cleanup(); }
  });
  it('startup failure removes only the newly-created home and does not launch another process', async () => {
    const f = await fixture();
    try { await assert.rejects(createCodexNativePresentation(f.options, () => { throw new Error('fixture launch failure'); }), /launch failure/);
      assert.deepEqual(await readdir(f.parent), []); assert.deepEqual(f.observed, []);
    } finally { await f.cleanup(); }
  });
});
