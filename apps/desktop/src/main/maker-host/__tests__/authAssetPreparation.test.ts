import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PreparationCache } from '../preparation-cache.js';

const state = vi.hoisted(() => ({
  owner: { dataOwnerId: 'a', generation: 1, mode: 'cloud' },
  boundary: false,
  bridge: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getName: () => 'Lex', getPath: () => '', isPackaged: true }, safeStorage: {} }));
vi.mock('@cindy/maker-core', () => ({}));
vi.mock('../../appCapabilities.js', () => ({ getAppCapabilities: () => ({ canUseCindyGateway: false }) }));
vi.mock('../../appSessionState.js', async (original) => ({
  ...await original<typeof import('../../appSessionState.js')>(),
  getActiveAppSession: () => ({ ...state.owner }),
  isAppSessionBoundaryPending: () => state.boundary,
}));
vi.mock('../codex-global-plugins.js', () => ({ prepareCodexGlobalPluginsBridge: state.bridge }));

import { DesktopClaudeAuthAdapter, DesktopCodexAuthAdapter } from '../auth-adapters.js';

beforeEach(() => {
  state.owner = { dataOwnerId: 'a', generation: 1, mode: 'cloud' };
  state.boundary = false;
  state.bridge.mockReset().mockResolvedValue({ warnings: [], routingFailures: [] });
});

describe('asset preparation boundaries', () => {
  // Unit regression: startup must not initialize unused Codex runtime assets.
  // Existing coverage exercised launch preparation only, not the startup entry.
  it('reconciles existing login at startup without preparing runtime assets', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-codex-lazy-assets-'));
    const home = path.join(root, 'codex-home');
    try {
      const reconcile = vi.fn().mockResolvedValue(undefined);
      const adapter = Object.assign(Object.create(DesktopCodexAuthAdapter.prototype), {
        ensureInvalidationMarkerLoaded: vi.fn(),
        reconcileWithSystemCodex: reconcile,
        ensureGlobalCodexAssets: async () => { mkdirSync(home); },
      }) as DesktopCodexAuthAdapter;
      Object.defineProperty(adapter, 'codexHome', { value: home });
      adapter.warmUp();
      expect(existsSync(home)).toBe(false);
      expect(reconcile).toHaveBeenCalledOnce();
      expect(await adapter.getAuthEnv({ credentialMode: 'gateway-key' })).toEqual({ CODEX_HOME: home });
      expect(existsSync(home)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rechecks plugin capability revocation and Skill projections at each launch', async () => {
    const skills = vi.fn(async () => true);
    // Avoid constructor credential reconciliation; exercise the real preparation entry points.
    const adapter = Object.assign(Object.create(DesktopCodexAuthAdapter.prototype), {
      pendingAssetsPrep: new PreparationCache(0),
      runEnsureGlobalCodexSkills: skills,
    }) as DesktopCodexAuthAdapter;
    Object.defineProperty(adapter, 'codexHome', { value: 'unused-test-home' });
    await adapter.ensureGlobalCodexAssets();
    state.bridge.mockResolvedValueOnce({ warnings: [], routingFailures: ['revoked'] });
    await expect(adapter.ensureGlobalCodexAssets()).rejects.toThrow('Cannot start Codex safely');
    expect(skills).toHaveBeenCalledTimes(2);
    expect(state.bridge).toHaveBeenCalledTimes(2);
    state.bridge.mockRejectedValueOnce(new Error('unreadable'));
    await expect(adapter.ensureGlobalCodexAssets()).rejects.toThrow('unreadable');
  });

  it('does not reuse a completion across owner generations or an in-progress boundary', async () => {
    const prepare = vi.fn(async () => true);
    const adapter = Object.assign(Object.create(DesktopClaudeAuthAdapter.prototype), {
      sharedSkillsPreparation: new PreparationCache(30_000), runEnsureSharedGlobalSkills: prepare,
    }) as DesktopClaudeAuthAdapter;
    await adapter.ensureSharedGlobalSkills();
    await adapter.ensureSharedGlobalSkills();
    expect(prepare).toHaveBeenCalledTimes(1);
    state.boundary = true;
    await adapter.ensureSharedGlobalSkills();
    await adapter.ensureSharedGlobalSkills();
    expect(prepare).toHaveBeenCalledTimes(3);
    state.boundary = false; state.owner.generation++;
    await adapter.ensureSharedGlobalSkills();
    expect(prepare).toHaveBeenCalledTimes(4);
  });
});
