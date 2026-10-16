import { describe, expect, it, vi } from 'vitest';

import { validateGhostManifest as validateProtocol } from '@cindy/plugin-protocol';
import { validateGhostManifest, type InstalledGhost } from '../../../shared/ghost.js';
import { spawnResidentGhost } from '../residentGhost.js';
import { handleRoutineRequest } from '../routineSlot.js';

const manifest = {
  schemaVersion: 3, minCindyVersion: '0.1.72', id: 'event-publisher', name: 'Events',
  description: 'Local events', version: '1.0.0', kind: 'chip', entry: 'index.html',
  routineEvents: { events: [{ type: 'mail', name: 'Mail', fields: [] }] },
};

describe.each([['desktop', validateGhostManifest], ['protocol', validateProtocol]] as const)(
  '%s publisher startup compatibility', (_name, validate) => {
    it.each([undefined, 'on-demand'])('starts an existing publisher with launch=%s without enabling the retired routine service', async (launch) => {
      const checked = validate({ ...manifest, ...(launch ? { launch } : {}) });
      if (!checked.ok) throw new Error(checked.reason);
      const ghost = { enabled: true, manifest: checked.manifest } as InstalledGhost;
      const deps = {
        isAvailable: () => true, startNode: vi.fn(), warn: vi.fn(),
        spawnBrowser: vi.fn(async (installed: InstalledGhost) => {
          const result = await handleRoutineRequest(installed, { action: 'status', status: 'listening' }, vi.fn(), () => true);
          expect(result).toEqual({ ok: false, message: 'Routine service is unavailable' });
          return { ok: true };
        }),
      };
      spawnResidentGhost(ghost, deps);
      await vi.waitFor(() => expect(deps.spawnBrowser).toHaveBeenCalledOnce());
      expect(deps.spawnBrowser).toHaveBeenCalledOnce();
      expect(deps.startNode).not.toHaveBeenCalled();
      expect(ghost.manifest.launch).toBe(launch);
    });
  },
);

it('preserves disabled/unavailable gates and ordinary on-demand startup behavior', () => {
  const checked = validateGhostManifest(manifest);
  if (!checked.ok) throw new Error(checked.reason);
  const ghost = { enabled: true, manifest: checked.manifest } as InstalledGhost;
  const deps = { isAvailable: () => true, startNode: vi.fn(), spawnBrowser: vi.fn(), warn: vi.fn() };
  spawnResidentGhost({ ...ghost, enabled: false }, deps);
  spawnResidentGhost(ghost, { ...deps, isAvailable: () => false });
  spawnResidentGhost({ ...ghost, manifest: { ...ghost.manifest, routineEvents: undefined } }, deps);
  expect(deps.startNode).not.toHaveBeenCalled();
  expect(deps.spawnBrowser).not.toHaveBeenCalled();
});
