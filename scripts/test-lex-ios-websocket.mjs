#!/usr/bin/env node
// Real Foundation URLSession tests; no Apple login, Expo runtime or signing credentials.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createTLSServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

if (process.platform !== 'darwin') throw new Error('Run this test on macOS with Xcode installed');
const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'lex-ios-ws-'));
const servers = [], sockets = new Set(), origins = {}, requests = {};
const ws = new WebSocketServer({ noServer: true });
async function listen(name, server, secure = false) {
  requests[name] = 0;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return origins[name] = (secure ? 'https' : 'http') + '://127.0.0.1:' + server.address().port;
}
function observed(name, req) {
  requests[name]++;
  assert.equal(req.url, '/api/device-link/ws');
  assert.equal(req.headers.cookie, undefined, 'Ambient cookies must never be sent');
  assert.equal(req.headers.authorization, 'Bearer invalid-fixture');
}
async function run(configuration) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn('swift', ['test', '--package-path', resolvePath(), '--scratch-path', join(scratch, 'build'), '-c', configuration], {
      cwd: root, env: { ...process.env, LEX_WS_TEST_ORIGINS: JSON.stringify(origins) }, stdio: 'inherit',
    });
    child.once('error', reject); child.once('exit', resolve);
  });
  assert.equal(code, 0, 'Swift transport tests must pass');
}
const resolvePath = () => resolve(root, 'apps/mobile/modules/lex-service-websocket');
try {
  const target = createServer((_req, res) => { requests.target++; res.writeHead(400).end(); });
  target.on('upgrade', (_req, socket) => { requests.target++; socket.destroy(); });
  const targetOrigin = await listen('target', target);
  for (const status of [301, 302, 303, 307, 308]) {
    const name = 'redirect' + status, server = createServer();
    server.on('upgrade', (req, socket) => {
      observed(name, req);
      socket.end('HTTP/1.1 ' + status + ' Redirect\r\nLocation: ' + targetOrigin + '/api/device-link/ws\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
    await listen(name, server);
  }
  const unauthorized = createServer();
  unauthorized.on('upgrade', (req, socket) => {
    observed('unauthorized', req);
    socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 14\r\nConnection: close\r\n\r\nsecret-fixture');
  });
  await listen('unauthorized', unauthorized);
  const echo = createServer();
  echo.on('upgrade', (req, socket, head) => {
    observed('echo', req);
    ws.handleUpgrade(req, socket, head, peer => {
      peer.send('fixture-frame');
      peer.on('message', data => peer.send('reply:' + data.toString()));
    });
  });
  ws.on('headers', headers => headers.push('Set-Cookie: server-cookie=invalid-fixture'));
  await listen('echo', echo);
  // Generate throwaway TLS material outside the repository; never install trust exceptions.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', join(scratch, 'key.pem'), '-out', join(scratch, 'cert.pem')], { stdio: 'ignore' });
  const tls = createTLSServer({ key: await readFile(join(scratch, 'key.pem')), cert: await readFile(join(scratch, 'cert.pem')) },
    (_req, res) => { requests.tls++; res.writeHead(400).end(); });
  tls.on('upgrade', (_req, socket) => { requests.tls++; socket.destroy(); });
  await listen('tls', tls, true);
  await run('debug');
  await run('release');
  assert.equal(requests.target, 0, 'Redirect target must receive no request or bearer');
  assert.equal(requests.tls, 0, 'Untrusted TLS must fail before HTTP headers');
  for (const status of [301, 302, 303, 307, 308]) assert.equal(requests['redirect' + status], 1);
  assert.equal(requests.unauthorized, 1);
  assert.equal(requests.echo, 2);
  console.log('PASS: iOS transport debug/release boundaries, redirects, TLS, cookie isolation, messages and lifecycle');
} finally {
  ws.clients.forEach(peer => peer.terminate());
  sockets.forEach(socket => socket.destroy());
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  ws.close();
  await rm(scratch, { recursive: true, force: true });
}
