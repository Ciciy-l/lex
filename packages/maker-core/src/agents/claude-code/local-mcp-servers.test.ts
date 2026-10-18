import { describe, expect, it, vi } from 'vitest';
import { prepareClaudeLocalMcp } from './local-mcp-servers.js';
import type { McpProvider, McpProviderContext } from '../../interfaces/mcp-provider.js';

describe('Claude selected MCP sources', () => {
  it('preserves context, first registration, memory policy and process configs across transports', () => {
    const context: McpProviderContext = { agentKind: 'claude-code', workingDir: '/fixture', sessionId: 'task',
      sessionInstanceId: 'instance', vendorOptions: { value: 'before' } };
    context.getSessionContext = () => context;
    const sdk = vi.fn((_context: McpProviderContext) => ({ type: 'sdk', name: 'original', instance: {} }));
    const ignored = vi.fn(() => null), duplicate = vi.fn();
    const http = { type: 'http', url: 'https://example.invalid/mcp' };
    const providers: McpProvider[] = [
      { name: 'helper', toClaudeSdkConfig: sdk }, { name: 'helper', toClaudeSdkConfig: ignored },
      { name: 'disabled', isEnabled: () => false, toClaudeSdkConfig: ignored },
      { name: 'cindy_memory', toClaudeSdkConfig: ignored },
      { name: 'custom', toClaudeSdkConfig: () => http },
      { name: '__proto__', toClaudeSdkConfig: sdk },
    ];
    const { servers, sources } = prepareClaudeLocalMcp({ providers, context, makerMemoryEnabled: false, remote: false, onDuplicate: duplicate });
    expect(Object.keys(servers!)).toEqual(['helper', 'custom', '__proto__']);
    expect(Object.keys(sources.factories)).toEqual(['helper', '__proto__']);
    expect(servers!.custom).toBe(http); expect(ignored).not.toHaveBeenCalled();
    expect(duplicate).toHaveBeenCalledWith('helper');
    context.vendorOptions!.value = 'after';
    const next = sources.factories.helper!();
    expect(next).not.toBe(servers!.helper);
    expect(sdk).toHaveBeenLastCalledWith(context);
    expect(sources.context.getSessionContext!()!.vendorOptions!.value).toBe('after');
  });

  it('retains local memory only when enabled and rejects reconnects that changed transport', () => {
    const sdk = vi.fn((): unknown => ({ type: 'sdk', name: 'memory', instance: {} }));
    const options = { providers: [{ name: 'cindy_memory', toClaudeSdkConfig: sdk }],
      context: { agentKind: 'claude-code' as const, workingDir: '/fixture' }, makerMemoryEnabled: true, remote: false, onDuplicate() {} };
    expect(prepareClaudeLocalMcp({ ...options, remote: true }).servers).toBeUndefined();
    expect(sdk).not.toHaveBeenCalled();
    const selected = prepareClaudeLocalMcp(options);
    expect(Object.keys(selected.servers!)).toEqual(['cindy_memory']);
    sdk.mockReturnValue({ type: 'http', url: 'https://example.invalid/mcp' });
    expect(() => selected.sources.factories.cindy_memory!()).toThrow('transport changed');
  });
});
