import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { AppServerHost } from '../../../../../../packages/maker-core/src/agents/codex/app-server/host.js';
import { createStdioTransport } from '../../../../../../packages/maker-core/src/agents/codex/app-server/stdioTransport.js';
import type { Logger } from '../../../../../../packages/maker-core/src/interfaces/logger.js';
import { prepareCodexFastModeCatalog } from '../codex-custom-context-catalog.js';

const binaryPath = process.env.CINDY_TEST_CODEX_BINARY;
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };

it.skipIf(!binaryPath)('native Codex preserves explicit Fast for an unknown alias across settings, resume and standard turns', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lex-codex-fast-'));
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  await Promise.all([mkdir(home), mkdir(work)]);
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.url !== '/responses') { res.writeHead(404).end(); return; }
    requests.push(JSON.parse(raw));
    const id = 'fixture-' + requests.length;
    const events = [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'message-' + id,
        content: [{ type: 'output_text', text: 'fixture complete' }] } },
      // A provider may accept the request but deliver the standard tier.
      { type: 'response.completed', response: { id, service_tier: 'default',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    res.end(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''));
  });
  let host: AppServerHost | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    await writeFile(path.join(home, 'config.toml'), [
      'model="private-fast-fixture"', 'model_provider="fixture"',
      'check_for_update_on_startup=false', 'chatgpt_base_url=' + JSON.stringify(endpoint),
      '[analytics]', 'enabled=false', '[features]', 'fast_mode=true', 'plugins=false',
      '[model_providers.fixture]', 'name="Fixture"', 'base_url=' + JSON.stringify(endpoint),
      'wire_api="responses"', 'env_key="FIXTURE_API_KEY"', 'supports_websockets=false',
      '[mcp_servers.cindy_memory]', 'enabled=false', 'command="unused-fixture-command"',
    ].join('\n'));
    const prepared = await prepareCodexFastModeCatalog({ binaryPath: binaryPath!, codexHome: home,
      modelIds: ['private-fast-fixture', 'another-private-fixture'] });
    host = new AppServerHost({ logger, clientInfo: { name: 'lex-fast-fixture', version: '0.1.13' },
      createTransport: () => createStdioTransport({ binaryPath: binaryPath!, cwd: work,
        extraArgs: prepared.extraArgs, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
          HOME: home, USERPROFILE: home, CODEX_HOME: home, TMPDIR: root,
          FIXTURE_API_KEY: 'invalid-loopback-fixture',
          HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
          NO_PROXY: '127.0.0.1,localhost' },
      }),
    });
    const started = await host.request<{ thread: { id: string }; serviceTier: string | null }>('thread/start', {
      model: 'private-fast-fixture', modelProvider: 'fixture', cwd: work,
      approvalPolicy: 'never', sandbox: 'read-only', serviceTier: 'fast',
    }, { timeoutMs: 20000 });
    expect(started.serviceTier).toBe('priority');
    let completed = 0;
    const errors: unknown[] = [];
    let subscription = host.subscribeThread(started.thread.id, {
      turnCompleted: event => { completed++; if (event.turn.status !== 'completed') errors.push(event); },
      error: event => { errors.push(event); },
    });
    const send = async (tier: 'priority' | undefined) => {
      const before = completed;
      await host!.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'fixture' }] });
      await vi.waitFor(() => expect(completed).toBe(before + 1), { timeout: 20000 });
      expect(errors).toEqual([]);
      expect(requests.at(-1)?.service_tier).toBe(tier);
    };
    await send('priority');
    await host.request('thread/settings/update', { threadId: started.thread.id, serviceTier: null });
    await send(undefined);
    await host.request('thread/settings/update', { threadId: started.thread.id, model: 'another-private-fixture', serviceTier: 'fast' });
    await send('priority');
    expect(requests.at(-1)?.model).toBe('another-private-fixture');
    await subscription.release();
    const resumed = await host.request<{ serviceTier: string | null }>('thread/resume', {
      threadId: started.thread.id, modelProvider: 'fixture', serviceTier: 'fast',
    });
    expect(resumed.serviceTier).toBe('priority');
    subscription = host.subscribeThread(started.thread.id, { turnCompleted: () => { completed++; }, error: event => { errors.push(event); } });
    await send('priority');
    await subscription.release();
    expect(requests).toHaveLength(4);
  } finally {
    await host?.shutdown();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
