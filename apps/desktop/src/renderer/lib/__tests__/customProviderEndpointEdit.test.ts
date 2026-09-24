import { describe, expect, it } from 'vitest';
import type { ProviderRuntimeModelConfig } from '@cindy/model-providers';

import { modelsAfterProviderEndpointEdit } from '../customProviderEndpointEdit';

describe('modelsAfterProviderEndpointEdit', () => {
  const oldBase = 'https://old.example.test/v1';
  const models: ProviderRuntimeModelConfig[] = [
    { id: 'inherited', name: 'Inherited' },
    {
      id: 'connection-route', name: 'Connection Route',
      route: { baseUrl: oldBase, wireProtocol: 'openai-responses', requestPath: '/responses' },
    },
    {
      id: 'independent-route', name: 'Independent Route', piApi: 'anthropic-messages',
      route: {
        baseUrl: 'https://old.example.test/anthropic?version=1',
        wireProtocol: 'anthropic-messages', requestPath: '/messages',
      },
    },
    {
      id: 'unrelated-route', name: 'Unrelated Route',
      route: { baseUrl: 'https://other.example.test/v1', wireProtocol: 'openai-chat' },
    },
  ];

  it.each([
    'https://new.example.test/v2',
    'http://127.0.0.1:1234/v2',
    'http://192.168.1.12:8000/v1',
    'https://old.example.test/proxy/v2',
  ])('rebases routes from the saved endpoint to %s', (nextBase) => {
    const original = structuredClone(models);
    const result = modelsAfterProviderEndpointEdit(models, oldBase, nextBase);
    expect(result[0]).toBe(models[0]);
    expect(result[1]?.route?.baseUrl).toBe(nextBase);
    expect(result[2]?.route?.baseUrl)
      .toBe(new URL(nextBase).origin + '/anthropic?version=1');
    expect(result[3]).toBe(models[3]);
    expect(models).toEqual(original);
  });

  it('treats a trailing slash as the same base and preserves an independent path', () => {
    const route = { ...models[1]!, route: { ...models[1]!.route!, baseUrl: oldBase + '/' } };
    const nextBase = 'https://old.example.test/proxy';
    expect(modelsAfterProviderEndpointEdit([route], oldBase, nextBase)[0]?.route?.baseUrl)
      .toBe(nextBase);
  });

  it('leaves unchanged, newly discovered, unrelated, and invalid routes alone', () => {
    expect(modelsAfterProviderEndpointEdit(models, oldBase, oldBase)).toBe(models);
    expect(modelsAfterProviderEndpointEdit(models, undefined, 'http://localhost:1234')).toBe(models);
    const newlyDiscovered = {
      ...models[1]!, route: { ...models[1]!.route!, baseUrl: 'https://new.example.test/v1' },
    };
    expect(modelsAfterProviderEndpointEdit([newlyDiscovered], oldBase, 'https://new.example.test/v1')[0])
      .toBe(newlyDiscovered);
    for (const endpoint of ['', 'ftp://old.example.test/v1', 'https://user:secret@old.example.test/v1']) {
      expect(modelsAfterProviderEndpointEdit(models, oldBase, endpoint)).toBe(models);
      expect(modelsAfterProviderEndpointEdit(models, endpoint, 'https://new.example.test/v1')).toBe(models);
    }
  });
});
