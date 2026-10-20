import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PiLocalNativeSessionOptions, AgentTerminalDriver, PiNativeSessionControl } from '@cindy/maker-core';
import { createPiNativeHostSession } from '../pi-native-host.js';
import type { AgentTerminalLaunch } from '../../terminal/agentTerminalDriver.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-native-host-'));
  cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
  const history = path.join(home, 'original.jsonl'); await fs.writeFile(history, '{}\n');
  const options: PiLocalNativeSessionOptions = { sessionId: 'original-task', model: 'model', provider: 'provider',
    executable: 'original-pi', cwd: home, extensionPath: path.join(home, 'internal', 'native.ts'), resumeSessionId: history,
    args: ['--mode', 'rpc', '--no-approve', '--session-dir', home, '--extension', 'original-user-extension', '--model', 'model'],
    env: { PI_CODING_AGENT_DIR: home, CINDY_PI_SECRET_ENV_NAMES: JSON.stringify(['ORIGINAL_SECRET_NAME']) },
    logger, onEvent() {}, onExit() {}, registerProcess: vi.fn(() => vi.fn()),
  };
  const driver: AgentTerminalDriver & { pid: number } = { pid: 54321, write: vi.fn(), resize: vi.fn(),
    onData: () => vi.fn(), onExit: () => vi.fn(), close: vi.fn(async () => {}) };
  const handshakes: Promise<unknown>[] = [];
  const createTerminal = vi.fn((spec: AgentTerminalLaunch) => {
    const env = spec.env;
    handshakes.push(fetch(env.LEX_PI_BRIDGE_URL + '/exchange', { method: 'POST',
      headers: { authorization: 'Bearer ' + env.LEX_PI_BRIDGE_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ generation: env.LEX_PI_BRIDGE_GENERATION, sessionId: env.LEX_PI_BRIDGE_SESSION,
        events: [{ sequence: 1, kind: 'ready', value: { sessionFile: history, model: 'model', provider: 'provider' } }] }),
    }).then(response => response.json()));
    return driver;
  });
  let controller: PiNativeSessionControl | undefined;
  cleanups.push(async () => { await controller?.close(); await Promise.all(handshakes); });
  return { options, driver, createTerminal, setController(value: PiNativeSessionControl) { controller = value; } };
}

describe('Pi ordinary interactive Main host', () => {
  it('retains the prepared runtime and original history, starts one interactive process, and confirms close before cleanup', async () => {
    const f = await fixture(), controller = await createPiNativeHostSession(f.options, f.createTerminal); f.setController(controller);
    expect(f.createTerminal).not.toHaveBeenCalled();
    await controller.start();
    expect(f.createTerminal).toHaveBeenCalledOnce();
    const spec = f.createTerminal.mock.calls[0]![0];
    expect(spec.args).toEqual([...f.options.args.slice(2), '--extension', f.options.extensionPath, '--session', f.options.resumeSessionId]);
    expect(spec.args).not.toContain('rpc'); expect(spec.args).not.toContain('--no-tools');
    expect(spec.env.PI_CODING_AGENT_DIR).toBe(f.options.env.PI_CODING_AGENT_DIR);
    expect(JSON.parse(spec.env.CINDY_PI_SECRET_ENV_NAMES)).toEqual(expect.arrayContaining(['ORIGINAL_SECRET_NAME',
      'LEX_PI_BRIDGE_TOKEN', 'LEX_PI_BRIDGE_URL', 'LEX_PI_BRIDGE_SESSION', 'LEX_PI_BRIDGE_GENERATION']));
    expect(await fs.readFile(f.options.extensionPath, 'utf8')).not.toContain(spec.env.LEX_PI_BRIDGE_TOKEN);
    vi.mocked(f.driver.close).mockRejectedValueOnce(new Error('exit unconfirmed'));
    await expect(controller.close()).rejects.toThrow('exit unconfirmed');
    expect((await fs.stat(f.options.extensionPath)).isFile()).toBe(true);
    await controller.close(); expect(f.driver.close).toHaveBeenCalledTimes(2);
    expect(f.createTerminal).toHaveBeenCalledOnce();
  });
  it('refuses missing legacy history before spawning or inventing another session', async () => {
    const f = await fixture(); await fs.rm(f.options.resumeSessionId!);
    await expect(createPiNativeHostSession(f.options, f.createTerminal)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.createTerminal).not.toHaveBeenCalled();
    await expect(fs.stat(f.options.extensionPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
