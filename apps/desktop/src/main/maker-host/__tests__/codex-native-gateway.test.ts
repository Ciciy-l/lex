import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createCodexNativeGateway } from '../codex-native-gateway.js';
import type { CodexAppServerTransport as Transport } from '@cindy/maker-core';
async function fixture() {
  const connections: Transport[] = [], messages: string[] = [];
  let current = true;
  const gateway = await createCodexNativeGateway({ isCurrent: () => current,
    attach(frontend) {
      connections.push(frontend); frontend.onLine(line => { messages.push(line); void frontend.writeLine(line); });
      return { close: () => frontend.close() };
    } });
  const sockets: WebSocket[] = [];
  const connect = (headers: Record<string, string> = { Authorization: 'Bearer ' + gateway.endpoint.token }, suffix = '') => {
    const socket = new WebSocket(gateway.endpoint.url + suffix, { headers }); sockets.push(socket); return socket;
  };
  const close = async () => { for (const socket of sockets) socket.terminate(); await gateway.close(); };
  return { gateway, connections, messages, connect, close, expire() { current = false; } };
}
describe('native Codex per-task loopback gateway', () => {
  it('accepts the task capability, preserves text framing, and confirms close', async () => {
    const f = await fixture();
    try { const socket = f.connect(); await once(socket, 'open');
      const response = once(socket, 'message'); socket.send('first'); assert.equal(String((await response)[0]), 'first');
      assert.deepEqual(f.messages, ['first']); assert.equal(f.connections.length, 1);
      const closed = once(socket, 'close');
      const closing = f.gateway.close();
      assert.equal(f.gateway.close(), closing);
      await closing; await closed; assert.equal(socket.readyState, WebSocket.CLOSED);
    } finally { await f.close(); }
  });
  it('rejects missing/wrong authorization, browser origins, routes and host rebinding', async () => {
    const f = await fixture();
    try {
      for (const [headers, suffix] of [
        [{}, ''], [{ Authorization: 'Bearer invalid' }, ''],
        [{ Authorization: 'Bearer ' + f.gateway.endpoint.token, Origin: 'https://example.test' }, ''],
        [{ Authorization: 'Bearer ' + f.gateway.endpoint.token }, '/other'],
        [{ Authorization: 'Bearer ' + f.gateway.endpoint.token, Host: 'foreign.test' }, ''],
      ] as Array<[Record<string, string>, string]>) {
        const socket = f.connect(headers, suffix); const [error] = await once(socket, 'error');
        assert.match(String(error), /403/);
      }
      assert.equal(f.connections.length, 0);
    } finally { await f.close(); }
  });
  it('a native frontend disconnection leaves another frontend attached', async () => {
    const f = await fixture();
    try { const a = f.connect(), b = f.connect(); await Promise.all([once(a, 'open'), once(b, 'open')]);
      const closed = once(a, 'close'); a.close(); await closed;
      const response = once(b, 'message'); b.send('survives'); assert.equal(String((await response)[0]), 'survives');
    } finally { await f.close(); }
  });
  it('rejects a stale task capability without constructing another upstream connection', async () => {
    const f = await fixture();
    try { f.expire(); const socket = f.connect(); const [error] = await once(socket, 'error');
      assert.match(String(error), /403/); assert.equal(f.connections.length, 0);
    } finally { await f.close(); }
  });
  it('rejects binary frames and bounds simultaneously attached connections', async () => {
    const f = await fixture();
    try {
      const sockets: WebSocket[] = [];
      for (let n = 0; n < 4; n++) { const socket = f.connect(); await once(socket, 'open'); sockets.push(socket); }
      const extra = f.connect(); const [error] = await once(extra, 'error'); assert.match(String(error), /403/);
      const ended = once(sockets[0]!, 'close'); sockets[0]!.send(Buffer.from('binary')); await ended;
      assert.deepEqual(f.messages, []);
    } finally { await f.close(); }
  });
  it('revokes a listener if its task expired during startup', async () => {
    await assert.rejects(createCodexNativeGateway({ isCurrent: () => false, attach() { throw new Error('must not attach'); } }), /task changed/);
  });
});
