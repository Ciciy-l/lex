import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  recoverViteDependencyLoad,
  type ViteDependencyRecoveryEvent,
} from '../vite-dependency-recovery';

function makeEvent(destroyed = false): ViteDependencyRecoveryEvent & {
  sender: { isDestroyed: ReturnType<typeof vi.fn>; reloadIgnoringCache: ReturnType<typeof vi.fn> };
} {
  return {
    sender: {
      isDestroyed: vi.fn(() => destroyed),
      reloadIgnoringCache: vi.fn(),
    },
  };
}

describe('Vite dependency recovery IPC', () => {
  it('reloads a trusted development renderer without using its HTTP cache', () => {
    const event = makeEvent();
    const trace: string[] = [];

    recoverViteDependencyLoad(event, {
      isDevelopment: true,
      assertTrustedAppRendererEvent: () => trace.push('trusted'),
    });

    expect(trace).toEqual(['trusted']);
    expect(event.sender.reloadIgnoringCache).toHaveBeenCalledOnce();
  });

  it('keeps production and destroyed renderers as no-ops after sender validation', () => {
    const production = makeEvent();
    const destroyed = makeEvent(true);
    const assertTrustedAppRendererEvent = vi.fn();

    recoverViteDependencyLoad(production, {
      isDevelopment: false,
      assertTrustedAppRendererEvent,
    });
    recoverViteDependencyLoad(destroyed, {
      isDevelopment: true,
      assertTrustedAppRendererEvent,
    });

    expect(assertTrustedAppRendererEvent).toHaveBeenCalledTimes(2);
    expect(production.sender.reloadIgnoringCache).not.toHaveBeenCalled();
    expect(destroyed.sender.reloadIgnoringCache).not.toHaveBeenCalled();
  });

  it('does not reload when the Main sender guard rejects the request', () => {
    const event = makeEvent();

    expect(() =>
      recoverViteDependencyLoad(event, {
        isDevelopment: true,
        assertTrustedAppRendererEvent: () => {
          throw new Error('untrusted sender');
        },
      }),
    ).toThrow('untrusted sender');
    expect(event.sender.reloadIgnoringCache).not.toHaveBeenCalled();
  });

  it('wires the fixed no-argument channel through the trusted Main boundary', () => {
    const source = readFileSync(resolve(__dirname, '..', 'bootstrap-electron.ts'), 'utf8');
    const start = source.indexOf("ipcMain.on('renderer:recover-vite-deps'");
    const end = source.indexOf('// Renderer → main 日志转发', start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const handler = source.slice(start, end);
    expect(handler).toContain('recoverViteDependencyLoad(event, {');
    expect(handler).toContain('isDevelopment: Boolean(MAIN_WINDOW_VITE_DEV_SERVER_URL)');
    expect(handler).toContain('assertTrustedAppRendererEvent');
  });
});
