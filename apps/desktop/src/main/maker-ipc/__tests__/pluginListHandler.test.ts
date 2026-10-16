import { describe, expect, it, vi } from 'vitest';
import { registerPluginListHandler } from '../pluginListHandler';
import { MAKER_INVOKE } from '../channels';
import { IpcHarness } from './helpers/ipcHarness';

describe('ordinary plugin catalog and retired context', () => {
  it('preserves registry fields and the existing settings query', async () => {
    const items = [{ id: 'contacts', name: 'Contacts', description: 'Local directory', source: 'local' as const, essential: false, effectiveEnabled: true, productDefaultEnabled: true }];
    const listPlugins = vi.fn(async () => items);
    const ipc = new IpcHarness();
    registerPluginListHandler(ipc, { getPluginRegistry: () => ({ listPlugins }) } as Parameters<typeof registerPluginListHandler>[1]);
    expect(await ipc.invoke(MAKER_INVOKE.PLUGINS_LIST, '/workspace', true)).toEqual(items);
    expect(listPlugins).toHaveBeenCalledExactlyOnceWith('/workspace', true);
  });
  it.each([{ botId: 'old', agentKind: 'pi' }, { botId: 'old', agentKind: 'unknown' }])('rejects a retired context before reading settings: %j', async (context) => {
    const listPlugins = vi.fn();
    const ipc = new IpcHarness();
    registerPluginListHandler(ipc, { getPluginRegistry: () => ({ listPlugins }) });
    await expect(ipc.invoke(MAKER_INVOKE.PLUGINS_LIST, '', true, context)).rejects.toThrow('NOT_FOUND');
    expect(listPlugins).not.toHaveBeenCalled();
  });
});
