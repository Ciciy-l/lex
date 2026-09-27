import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogModel, ProviderView } from '@cindy/model-providers';
import {
  assertSshCodexModel,
  isVerifiedSshCodexResume,
  readSshCodexModelList,
} from '../codex-model-list.js';

function provider(models: CatalogModel[]): ProviderView {
  return {
    id: 'openai',
    name: 'OpenAI Codex',
    source: 'builtin',
    connected: true,
    agents: ['codex'],
    auth: { method: 'oauth', native: 'codex' },
    routing: {
      codex: {
        upstream: 'https://chatgpt.com/backend-api/codex',
        authStrategy: 'oauth-passthrough',
      },
    },
    models: { codex: models },
  };
}

const model = (id: string): CatalogModel => ({
  id,
  name: id,
  contextWindow: 200_000,
  efforts: ['low', 'high'],
  defaultEffort: 'high',
});
const makerRegister = readFileSync(resolve(__dirname, '../../maker-ipc/register.ts'), 'utf8')
  .replace(/\r\n?/g, '\n');
const modelListSource = readFileSync(resolve(__dirname, '../codex-model-list.ts'), 'utf8')
  .replace(/\r\n?/g, '\n');

describe('SSH Codex model route boundary', () => {
  it('validates the host id, returns only the native subscription view, and hides remote errors', async () => {
    const read = vi.fn(async () => [provider([model('remote-model')])]);

    await expect(readSshCodexModelList({ id: 'builder' }, read))
      .resolves.toEqual([provider([model('remote-model')])]);
    expect(read).toHaveBeenCalledExactlyOnceWith('builder');
    await expect(readSshCodexModelList({ id: 'x'.repeat(257) }, read)).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    await expect(readSshCodexModelList({ id: 'builder' }, vi.fn().mockRejectedValue(new Error('private remote detail'))))
      .rejects.toThrow('Unable to read SSH Codex models; reconnect and retry');
  });

  it('rejects a model missing from the host catalog and a non-native provider', () => {
    const providers = [provider([model('remote-model')])];

    expect(() => assertSshCodexModel(providers, 'remote-model', 'openai')).not.toThrow();
    expect(() => assertSshCodexModel(providers, 'remote-model', null)).not.toThrow();
    expect(() => assertSshCodexModel(providers, 'remote-model', 'custom'))
      .toThrow('remote native subscription route');
    expect(() => assertSshCodexModel(providers, 'different-model', 'openai'))
      .toThrow('unavailable on this SSH host');
  });

  it('allows hidden models only for an exact persisted host/thread/model/source resume', () => {
    const request = {
      id: 'session-a',
      agentKind: 'codex',
      model: 'hidden-model',
      providerId: 'openai',
      remoteHostId: 'builder',
      resumeSessionId: 'thread-a',
    };
    const stored = {
      agentKind: 'codex',
      model: 'hidden-model',
      providerId: 'openai',
      remoteHostId: 'builder',
      sdkSessionId: 'thread-a',
    };

    expect(isVerifiedSshCodexResume(request, stored)).toBe(true);
    expect(isVerifiedSshCodexResume({ ...request, remoteHostId: 'other-host' }, stored)).toBe(false);
    expect(isVerifiedSshCodexResume({ ...request, resumeSessionId: 'other-thread' }, stored)).toBe(false);
    expect(isVerifiedSshCodexResume({ ...request, model: 'other-model' }, stored)).toBe(false);
    expect(isVerifiedSshCodexResume({ ...request, providerId: 'custom' }, stored)).toBe(false);
    expect(isVerifiedSshCodexResume({ ...request, id: undefined }, stored)).toBe(false);

    const implicitNativeRequest = { ...request, providerId: null };
    const implicitNativeStored = { ...stored, providerId: null };
    expect(isVerifiedSshCodexResume(implicitNativeRequest, implicitNativeStored)).toBe(true);
    expect(isVerifiedSshCodexResume(request, implicitNativeStored)).toBe(false);
  });

  it('wires the exact resume exception before requiring a currently visible remote model', () => {
    const start = makerRegister.indexOf('let verifiedResume = false;');
    const end = makerRegister.indexOf('session = await maker.createSession(', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const preflight = makerRegister.slice(start, end);
    expect(preflight).toContain('isVerifiedSshCodexResume(o, row ?');
    expect(preflight).toContain('if (!verifiedResume)');
    expect(preflight).toContain('assertModelRouteUsable(');
    expect(modelListSource).toContain('stored.sdkSessionId === request.resumeSessionId');
    expect(makerRegister.slice(end, end + 550)).toContain('assertCurrent: assertSshCodexOwnerCurrent');
  });
});
