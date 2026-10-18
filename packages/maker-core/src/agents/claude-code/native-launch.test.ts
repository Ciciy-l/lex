import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeLocalSessionLaunch } from './local-session-launch.js';
import { prepareClaudeNativeLaunch } from './native-launch.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });
async function launch(overrides: Partial<ClaudeLocalSessionLaunch> = {}): Promise<ClaudeLocalSessionLaunch> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lex-native-launch-test-'));
  cleanups.push(() => fs.rm(cwd, { recursive: true, force: true }));
  return { abortController: new AbortController(), cwd, additionalDirectories: [], managedSkillPluginRoots: [],
    model: 'fixture/model', permissionMode: 'default', binaryPath: process.execPath,
    systemPromptAppend: 'unchanged host prefix\nunchanged task prefix', sessionId: randomUUID(),
    enableFileCheckpointing: true, env: { PATH: 'fixture-path', ANTHROPIC_API_KEY: 'fixture-provider-secret' },
    canUseTool: vi.fn(async (_name, input) => ({ behavior: 'allow' as const, updatedInput: input })),
    settingSources: ['user', 'project', 'local'], settings: { apiKeyHelper: '', autoMemoryEnabled: false },
    allowDangerouslySkipPermissions: true, debug: false, hooks: {}, ...overrides };
}
function argument(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag); expect(index).toBeGreaterThanOrEqual(0); return args[index + 1]!;
}
const expand = (text: string, env: Readonly<Record<string, string>>) => text.replace(/\$\{([^}]+)\}/g, (_, key) => env[key] ?? 'missing');

describe('native Claude launch from existing session configuration', () => {
  it('keeps the existing transcript identity when reopening an idle task with its selected provider', async () => {
    const id = randomUUID(), input = await launch({ resume: id, sessionId: undefined });
    const prepared = await prepareClaudeNativeLaunch(input); cleanups.push(prepared.dispose);
    expect(prepared.nativeSessionId).toBe(id); expect(prepared.resumeSessionId).toBe(id);
    expect(prepared.env.ANTHROPIC_API_KEY).toBe('fixture-provider-secret');
    expect(prepared.args).not.toContain('--session-id'); expect(prepared.args).not.toContain('--resume');
    await expect(prepareClaudeNativeLaunch(await launch({ resume: id }))).rejects.toThrow('identity changed');
  });

  it('keeps HTTP, SSE and stdio MCP credentials out of files/argv while retaining host policy and prompt bytes', async () => {
    const hook = vi.fn();
    const config = await launch({ effort: 'high', hooks: { PreToolUse: [{ hooks: [hook] }] },
      mcpServers: {
        http: { type: 'http', url: 'https://example.invalid/mcp?key=fixture-url-secret', headers: { Authorization: 'Bearer fixture-http-secret' } },
        sse: { type: 'sse', url: 'https://example.invalid/sse', headers: { Authorization: 'Bearer fixture-sse-secret' } },
        stdio: { command: 'fixture-executable', args: ['--token', 'fixture-argument-secret'], env: { KEY: 'fixture-env-secret' } },
      } });
    const prepared = await prepareClaudeNativeLaunch(config); cleanups.push(prepared.dispose);
    const settingsPath = argument(prepared.args, '--settings');
    const promptPath = argument(prepared.args, '--append-system-prompt-file');
    const mcpPath = argument(prepared.args, '--mcp-config');
    const disk = await Promise.all([settingsPath, promptPath, mcpPath].map(file => fs.readFile(file, 'utf8')));
    const surface = JSON.stringify(prepared.args) + disk.join('\n');
    for (const secret of ['fixture-provider-secret', 'fixture-url-secret', 'fixture-http-secret', 'fixture-sse-secret', 'fixture-argument-secret', 'fixture-env-secret']) expect(surface).not.toContain(secret);
    expect(disk[1]).toBe(config.systemPromptAppend);
    expect(JSON.parse(disk[0]!)).toEqual(config.settings);
    expect(prepared.hooks).toBe(config.hooks); expect(prepared.canUseTool).toBe(config.canUseTool);
    expect(prepared.nativeSessionId).toBe(config.sessionId);
    const servers = JSON.parse(disk[2]!).mcpServers;
    expect(expand(servers.http.headers.Authorization, prepared.env)).toBe('Bearer fixture-http-secret');
    expect(expand(servers.sse.url, prepared.env)).toBe('https://example.invalid/sse');
    expect(expand(servers.stdio.command, prepared.env)).toBe('fixture-executable');
    expect(expand(servers.stdio.args[1], prepared.env)).toBe('fixture-argument-secret');
    expect(expand(servers.stdio.env.KEY, prepared.env)).toBe('fixture-env-secret');
    expect(config.env.LEX_CLAUDE_MCP).toBeUndefined();
    expect(prepared.args).not.toContain('--print'); expect(prepared.args).not.toContain('--input-format');
    expect(prepared.args).not.toContain('--allow-dangerously-skip-permissions');
    await prepared.dispose(); await prepared.dispose();
    await expect(fs.stat(path.dirname(settingsPath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires every in-process MCP to keep its exact name and cleans its registration on rejection', async () => {
    const instance = { circular: undefined as unknown }; instance.circular = instance;
    const config = await launch({ mcpServers: { cindy_helper: { type: 'sdk', name: 'cindy_helper', instance: instance as any } } });
    await expect(prepareClaudeNativeLaunch(config)).rejects.toThrow('host MCP bridge');
    const dispose = vi.fn();
    await expect(prepareClaudeNativeLaunch(config, async servers => {
      expect(servers.cindy_helper).toBe(config.mcpServers!.cindy_helper);
      return { servers: { wrong: { type: 'http', url: 'http://127.0.0.1:1' } }, dispose };
    })).rejects.toThrow('tool surface');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('projects an in-process server without serializing its instance or exposing its bridge token', async () => {
    const dispose = vi.fn(), revoke = vi.fn();
    const config = await launch({ mcpServers: { helper: { type: 'sdk', name: 'helper', instance: {} as any } } });
    const prepared = await prepareClaudeNativeLaunch(config, async () => ({
      servers: { helper: { type: 'http', url: 'http://127.0.0.1:1', headers: { Authorization: 'Bearer fixture-bridge-key' } } }, revoke, dispose,
    })); cleanups.push(prepared.dispose);
    const wire = await fs.readFile(argument(prepared.args, '--mcp-config'), 'utf8');
    expect(wire).not.toContain('fixture-bridge-key'); expect(wire).not.toContain('instance');
    expect(Object.keys(JSON.parse(wire).mcpServers)).toEqual(['helper']);
    expect(prepared.env.ANTHROPIC_API_KEY).toBe('fixture-provider-secret');
    prepared.revoke(); prepared.revoke();
    expect(revoke).toHaveBeenCalledOnce(); expect(dispose).not.toHaveBeenCalled();
    expect((await fs.stat(argument(prepared.args, '--mcp-config'))).isFile()).toBe(true);
    await prepared.dispose(); await prepared.dispose(); expect(dispose).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledOnce();
  });

  it('cleans the MCP registration when launch is cancelled while it is being prepared', async () => {
    const config = await launch({ mcpServers: { helper: { type: 'sdk', name: 'helper', instance: {} as any } } });
    const dispose = vi.fn();
    await expect(prepareClaudeNativeLaunch(config, async () => {
      config.abortController.abort();
      return { servers: { helper: { type: 'http', url: 'http://127.0.0.1:1' } }, dispose };
    })).rejects.toThrow('cancelled');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('never silently starts a new history or drops a configured subscription refresh callback', async () => {
    await expect(prepareClaudeNativeLaunch(await launch({ resumeSessionAt: 'existing-history' }))).rejects.toThrow('history restore');
    const refresh = vi.fn(async () => 'fixture-oauth');
    await expect(prepareClaudeNativeLaunch(await launch({ getOAuthToken: refresh }))).rejects.toThrow('subscription refresh');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('preserves native single-pass MCP expansion, including empty values, defaults and literal braces inside credentials', async () => {
    const ref = (name: string) => '$' + '{' + name + '}';
    const config = await launch({ env: { EMPTY: '', TOKEN: ref('NOT_A_VARIABLE') }, mcpServers: {
      http: { type: 'http', url: 'http://127.0.0.1:1', headers: {
        Empty: ref('EMPTY:-fallback'), Missing: ref('MISSING:-fallback'), Authorization: 'Bearer ' + ref('TOKEN'),
      } },
    } });
    const prepared = await prepareClaudeNativeLaunch(config); cleanups.push(prepared.dispose);
    const wire = JSON.parse(await fs.readFile(argument(prepared.args, '--mcp-config'), 'utf8')).mcpServers.http;
    expect(expand(wire.headers.Empty, prepared.env)).toBe('');
    expect(expand(wire.headers.Missing, prepared.env)).toBe('fallback');
    expect(expand(wire.headers.Authorization, prepared.env)).toBe('Bearer ' + ref('NOT_A_VARIABLE'));
    const missing = await launch({ mcpServers: { http: { type: 'http', url: ref('MISSING') } } });
    await expect(prepareClaudeNativeLaunch(missing)).rejects.toThrow('environment variable is missing');
  });
});
