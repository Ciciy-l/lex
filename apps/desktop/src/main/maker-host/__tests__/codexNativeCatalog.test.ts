import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
const state = vi.hoisted(() => ({
  owner: { dataOwnerId: 'owner', generation: 1 }, pending: false, alive: true,
  providers: [] as unknown[], list: vi.fn(), wait: vi.fn(), visibility: new Map<string, boolean>(),
}));
vi.mock('../../appSessionState.js', () => ({ getActiveAppSession: () => state.owner, isAppSessionBoundaryPending: () => state.pending }));
vi.mock('../createDesktopProviderService.js', () => ({ getDesktopProviderService: () => ({ listProviders: state.list }) }));
vi.mock('../model-visibility-mirror.js', () => ({ waitForModelVisibilityMirror: state.wait,
  getModelVisibilityOverride: (_agent: string, provider: string, model: string) => state.visibility.get(provider + '/' + model) }));
import { createDesktopCodexNativeCatalog, type CodexNativeCatalogRuntime } from '../codexNativeCatalog.js';
function provider(id: string, overrides: Partial<ProviderView> = {}): ProviderView {
  const model = (id: string, extra = {}) => ({ id, name: id, contextWindow: 128000, efforts: ['low','high'], defaultEffort: 'high', ...extra });
  return { id, name: id, agents: ['codex'], connected: true, source: 'user', auth: { method: 'none' },
    routing: { codex: { wireProtocol: 'openai-responses' } },
    models: { codex: [model('same'), model('current', { defaultEnabled: false }), model('hidden', { defaultEnabled: false }),
      model('disabled', { disabled: true }), model('retired', { status: 'retired' }), model('fast', { supportsFastMode: true, supportsImageInput: false })] },
    ...overrides,
  } as unknown as ProviderView;
}
beforeEach(() => {
  state.owner = { dataOwnerId: 'owner', generation: 1 }; state.pending = false; state.alive = true;
  state.providers = [provider('chosen'), provider('other')]; state.visibility.clear();
  state.list.mockReset().mockImplementation(async () => state.providers); state.wait.mockReset().mockResolvedValue(undefined);
});
function fixture() {
  const runtime: CodexNativeCatalogRuntime = { model: 'current', nativeModel: 'native-current', providerId: 'chosen', effort: 'high', fastMode: false, nativeModelProvider: 'proxy' };
  const handler = createDesktopCodexNativeCatalog({ nativeSessionId: 'native', cwd: '/task', isCurrent: () => state.alive, readRuntime: () => runtime });
  const forward = vi.fn().mockImplementation(async params => params?.includeLayers === false
    ? { config: { model: 'other', instructions: 'invalid-secret' }, origins: { secret: true } }
    : { data: [{ model: 'native-current', inputModalities: ['text', 'image'], multiAgentVersion: 'v2', secret: 'invalid-secret' },
        { model: 'fast', inputModalities: ['text', 'image'], additionalSpeedTiers: ['unknown'] }], nextCursor: null });
  const controller = new AbortController();
  return { runtime, forward, controller, run: (method = 'model/list') => handler({ request: { id: 1, method }, signal: controller.signal, forward }) };
}
describe('actual Desktop catalog owns the original native model menu', () => {
  it('uses one exact connection, current hidden row and normal visibility/disabled rules', async () => {
    const f = fixture(); const result = await f.run() as { data: Array<{ model: string; hidden: boolean; isDefault: boolean; additionalSpeedTiers: string[] }> };
    expect(result.data.map(row => row.model)).toEqual(['same', 'current', 'fast']);
    expect(result.data[1]).toMatchObject({ hidden: true, isDefault: true });
    expect(result.data[2].additionalSpeedTiers).toEqual(['fast']);
    expect(state.list).toHaveBeenCalledWith({ allowSideEffects: false });
    expect(f.forward).toHaveBeenCalledWith({ cursor: null, limit: 100, includeHidden: true });
    expect(result.data[1]).toMatchObject({ inputModalities: ['text', 'image'], multiAgentVersion: 'v2' });
    expect(result.data[2]).toMatchObject({ inputModalities: ['text'] });
    expect(JSON.stringify(result)).not.toContain('invalid-secret');
  });
  it('honors explicit show/hide overrides without changing defaults', async () => {
    state.visibility.set('chosen/hidden', true); state.visibility.set('chosen/same', false);
    const result = await fixture().run() as { data: Array<{ model: string }> };
    expect(result.data.map(row => row.model)).toEqual(['current','hidden','fast']);
  });
  it('never borrows the other connection if this one is missing or disconnected', async () => {
    state.providers = [provider('other')]; await expect(fixture().run()).rejects.toThrow('provider is unavailable');
    state.providers = [provider('chosen', { connected: false }), provider('other')];
    expect(await fixture().run()).toEqual({ data: [], nextCursor: null });
  });
  it('projects current task configuration without global source data', async () => {
    const f = fixture(); expect(await f.run('config/read')).toEqual({ config: { model: 'current', model_provider: 'proxy',
      model_reasoning_effort: 'high', service_tier: null }, origins: {}, layers: null });
    expect(f.forward).toHaveBeenCalledWith({ cwd: '/task', includeLayers: false });
  });
  it('keeps model membership in the GUI catalog even when native metadata has another list', async () => {
    const f = fixture(); f.forward.mockResolvedValue({ data: [{ model: 'other-provider-model' }], nextCursor: null });
    const result = await f.run() as { data: Array<{ model: string }> };
    expect(result.data.map(row => row.model)).toEqual(['same', 'current', 'fast']);
  });
  it('collects native metadata pages and refuses repeated or malformed cursors', async () => {
    const f = fixture();
    f.forward.mockResolvedValueOnce({ data: [], nextCursor: 'next' }).mockResolvedValueOnce({
      data: [{ model: 'native-current', multiAgentVersion: 'v2' }], nextCursor: null });
    const result = await f.run() as { data: unknown[] };
    expect(result.data[1]).toMatchObject({ multiAgentVersion: 'v2' });
    expect(f.forward).toHaveBeenNthCalledWith(2, { cursor: 'next', limit: 100, includeHidden: true });
    f.forward.mockResolvedValue({ data: [], nextCursor: 'repeat' });
    await expect(f.run()).rejects.toThrow('cursor repeated');
    f.forward.mockResolvedValue({ data: [], nextCursor: 1 });
    await expect(f.run()).rejects.toThrow('response is invalid');
  });
  it('binds omitted MCP status identity to the same task', async () => {
    const f = fixture(); await f.run('mcpServerStatus/list');
    expect(f.forward).toHaveBeenCalledWith({ threadId: 'native' });
    expect(state.list).not.toHaveBeenCalled();
  });
  it('does not infer an unresolved provider from a coincident model name', async () => {
    const f = fixture(); f.runtime.providerId = null;
    await expect(f.run()).rejects.toThrow('exact task route'); expect(state.list).not.toHaveBeenCalled();
  });
  it.each(['owner','provider','model','abort'] as const)('fences %s changes during awaited catalog reads', async change => {
    const f = fixture(); state.list.mockImplementationOnce(async () => {
      if (change === 'owner') state.owner.generation++;
      if (change === 'provider') f.runtime.providerId = 'other';
      if (change === 'model') f.runtime.model = 'same';
      if (change === 'abort') f.controller.abort();
      return state.providers;
    }); await expect(f.run()).rejects.toThrow(/changed|no longer/);
  });
});
