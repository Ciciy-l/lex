import { describe, expect, it } from 'vitest';
import { mergeCodexNativeThreadStart } from './native-start-params.js';

describe('owning-host fresh native configuration', () => {
  it('retains the original nine-tool MCP executor while keeping Core route, prompt and permissions', () => {
    const executor = { url: 'http://127.0.0.1:31415/mcp', http_headers: { Authorization: 'Bearer fixture-only' },
      default_tools_approval_mode: 'approve', tools: { create_thread: { approval_mode: 'prompt' } } };
    const owned = { model: 'selected', cwd: '/selected', sandbox: 'workspace-write' as const, developerInstructions: 'unchanged product bytes',
      config: { 'permissions.selected': { mode: 'read-only' } } };
    const result = mergeCodexNativeThreadStart(owned, { model: 'other', cwd: '/other', sandbox: 'danger-full-access',
      developerInstructions: 'other', config: { 'mcp_servers.codex_tui': executor, 'permissions.selected': { mode: 'full' } } }, new Set(['memory']));
    expect(result).toEqual({ ...owned, config: { ...owned.config, 'mcp_servers.codex_tui': executor } });
    expect(result.config!['mcp_servers.codex_tui']).not.toBe(executor);
  });
  it('keeps dynamic declarations in order and rejects name conflicts instead of dropping tools', () => {
    const first = { type: 'function' as const, name: 'host', description: 'host', inputSchema: {} };
    const second = { type: 'function' as const, name: 'codex_tui', description: 'original executor', inputSchema: {} };
    expect(mergeCodexNativeThreadStart({ dynamicTools: [first] }, { dynamicTools: [second] }, new Set()).dynamicTools).toEqual([first, second]);
    expect(() => mergeCodexNativeThreadStart({ dynamicTools: [first] }, { dynamicTools: [first] }, new Set())).toThrow('Conflicting');
  });
  it('refuses an existing namespace and non-local executor without changing the request', () => {
    const native = { config: { 'mcp_servers.codex_tui': { url: 'http://127.0.0.1:31415/mcp' } } };
    expect(() => mergeCodexNativeThreadStart({}, native, new Set(['codex_tui']))).toThrow('namespace');
    expect(() => mergeCodexNativeThreadStart({}, { config: { 'mcp_servers.codex_tui': { url: 'https://example.invalid/mcp' } } }, new Set())).toThrow('local');
  });
});
