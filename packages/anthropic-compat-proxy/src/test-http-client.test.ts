import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { listenOnAvailableLoopbackPort } from './test-loopback-server.js';
import { postJson } from './test-http-client.js';

let server: Server | undefined;
const sockets = new Set<Socket>();
const accepted: Socket[] = [];

async function start(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  server = createServer(handler);
  server.on('connection', (socket) => {
    sockets.add(socket);
    accepted.push(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return `http://127.0.0.1:${await listenOnAvailableLoopbackPort(server)}`;
}

async function close(): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
}

afterEach(async () => {
  await close();
  server = undefined;
  sockets.clear();
  accepted.length = 0;
});

it('opens a fresh connection when a retired server address is immediately reused', async () => {
  const url = await start((req, res) => { req.resume(); req.on('end', () => res.end('ok')); });
  expect(await postJson(url, { model: 'test-model' })).toEqual({ status: 200, text: 'ok' });
  // A pooled client has returned its completed socket to the idle pool here.
  await setImmediate();
  await close();
  await new Promise<void>((resolve) => server!.listen(Number(new URL(url).port), '127.0.0.1', resolve));
  expect(await postJson(url, { model: 'test-model' })).toEqual({ status: 200, text: 'ok' });
  expect(accepted).toHaveLength(2);
  expect(accepted[1]).not.toBe(accepted[0]);
});

it('waits for the complete response and preserves split UTF-8 bytes', async () => {
  let response!: ServerResponse;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const bytes = Buffer.from('汉字');
  const url = await start((req, res) => {
    req.resume();
    req.on('end', () => { response = res; res.writeHead(200); res.write(bytes.subarray(0, 1)); signalStarted(); });
  });
  let settled = false;
  const result = postJson(url, {}).then((value) => { settled = true; return value; });
  await started;
  await setImmediate();
  expect(settled).toBe(false);
  response.end(bytes.subarray(1));
  expect(await result).toEqual({ status: 200, text: '汉字' });
});

it('rejects a truncated response without retrying the request', async () => {
  let count = 0;
  const url = await start((req, res) => {
    count += 1; req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-length': 100 });
      res.write('partial', () => res.destroy());
    });
  });
  await expect(postJson(url, {})).rejects.toThrow();
  expect(count).toBe(1);
});

it('preserves JSON request headers and non-2xx response bytes without retrying', async () => {
  const requests: Array<{ method?: string; path?: string; type?: string; thread?: string; body: string }> = [];
  const url = await start((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ method: req.method, path: req.url, type: req.headers['content-type'], thread: String(req.headers['thread-id']), body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"error":"unavailable"}');
    });
  });
  expect(await postJson(url, { model: 'test-model' })).toEqual({ status: 503, text: '{"error":"unavailable"}' });
  expect(requests).toEqual([{ method: 'POST', path: '/v1/responses', type: 'application/json', thread: 'thread-a', body: '{"model":"test-model"}' }]);
});
