import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildUserProviderChannels,
  type CustomProviderConfig,
  type CustomProviderRuntimeConfig,
  type OAuthAuthorizationCodeDescriptor,
} from '@cindy/model-providers';

function oauthConfig(authorizeUrl = 'https://example.invalid/auth'): OAuthAuthorizationCodeDescriptor {
  return { authorizeUrl, tokenUrl: 'https://example.invalid/token', clientId: 'fixture-public-client', scopes: 'models:read' };
}

const state = vi.hoisted(() => ({
  loggedIn: false, proxyReady: true, sharedSkillRefreshes: 0,
  owner: 'local:owner-a', pending: false, changeOwnerDuringRead: false, changeOwnerDuringKeyRead: false,
  configs: [] as CustomProviderConfig[], channelKey: 'fixture-channel-key' as string | null,
  onConfigRead: null as (() => void) | null,
}));
const readKey = vi.hoisted(() => vi.fn((providerId: string, _agent: string, protocol?: string): string | null => {
  if (state.changeOwnerDuringKeyRead) state.owner = 'local:owner-b';
  return providerId === 'xai' ? 'legacy-custom-key' :
    providerId === 'loopback-channel' && protocol === 'anthropic-messages' ? state.channelKey : null;
}));
const ensureLocalReady = vi.hoisted(() => vi.fn());
vi.mock('../../appSessionState.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../appSessionState.js')>(),
  activeOwnerScopeKey: () => state.owner,
  isAppSessionBoundaryPending: () => state.pending,
}));
vi.mock('../../local-model-runtime/preflight.js', () => ({
  ensureManagedOllamaReadyForSession: ensureLocalReady,
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => '/tmp/cindy-pi-byom-auth-test',
  },
}));
vi.mock('../auth-adapters.js', () => ({
  readClaudeApiKey: () => null,
  desktopClaudeAuthAdapter: {
    ensureSharedGlobalSkills: async () => {
      state.sharedSkillRefreshes += 1;
    },
  },
  desktopCodexAuthAdapter: { getState: async () => ({ authenticated: false }) },
}));
vi.mock('../custom-provider-header-secrets.js', () => ({
  listCustomProvidersWithSecureHeaders: async (): Promise<CustomProviderConfig[]> => {
    if (state.changeOwnerDuringRead) state.owner = 'local:owner-b';
    state.onConfigRead?.();
    return [
    ...state.configs,
    {
      id: 'local-keyless',
      name: 'Local keyless',
      auth: { method: 'none' },
      runtimes: {
        pi: {
          baseUrl: 'http://127.0.0.1:11434/v1',
          wireProtocol: 'openai-chat',
          models: [{ id: 'local-model', name: 'Local model' }],
        },
      },
    },
    {
      id: 'openrouter-oauth',
      name: 'OpenRouter OAuth',
      auth: { method: 'oauth', oauth: oauthConfig('https://openrouter.ai/auth') },
      runtimes: {
        pi: {
          baseUrl: 'https://openrouter.ai/api/v1',
          wireProtocol: 'openai-chat',
          models: [{ id: 'google/gemini-test', name: 'Gemini test', api: 'openai-completions' }],
        },
      },
    },
    {
      id: 'xai',
      name: 'Legacy custom xAI',
      auth: { method: 'apiKey' },
      runtimes: {
        pi: {
          baseUrl: 'https://private-xai.example/v1',
          wireProtocol: 'openai-chat',
          models: [{ id: 'private-grok', name: 'Private Grok' }, { id: 'grok-4.6', name: 'Grok 4.6' }],
        },
      },
    },
  ]; },
}));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  readCustomProviderKey: readKey,
}));
vi.mock('../grok-oauth-login.js', () => ({
  hasGrokOAuthLogin: () => state.loggedIn,
  getGrokAccessToken: async () => 'grok-test-token',
  peekGrokAccessToken: () => (state.loggedIn ? 'grok-test-token' : null),
  recoverGrokAuthAfterRejection: async () => 'superseded' as const,
}));
vi.mock('../anthropic-compat-proxy-host.js', () => ({
  getClaudeEndpoint: () => 'http://127.0.0.1:18765',
  isAnthropicCompatProxyHandleReady: () => state.proxyReady,
}));

import { desktopPiAuthAdapter, resolvePiNativeProviders } from '../pi-host.js';
import { setCustomProviders } from '../active-catalog.js';
import { beginProviderRouteMutation, setCustomProviderHeaderReader, setCustomProviderKeyReader, setOAuthTokenReader } from '../provider-route.js';

describe('Pi pure BYOM auth without a Cindy account', () => {
  beforeEach(() => {
    state.loggedIn = false;
    state.proxyReady = true;
    state.sharedSkillRefreshes = 0;
    state.owner = 'local:owner-a'; state.pending = false; state.changeOwnerDuringRead = false;
    state.changeOwnerDuringKeyRead = false; state.onConfigRead = null;
    state.configs = []; state.channelKey = 'fixture-channel-key';
    setCustomProviders([]);
    setCustomProviderKeyReader(readKey);
    setOAuthTokenReader(() => null);
    setCustomProviderHeaderReader((id, _agent, protocol) => protocol
      ? state.configs.flatMap(config => config.channels?.channels ?? [])
        .find(channel => channel.id === id)?.protocols[protocol]?.headers ?? null
      : null);
    readKey.mockClear();
    ensureLocalReady.mockReset();
  });

  const channelConnection = (): CustomProviderRuntimeConfig => ({ baseUrl: 'http://127.0.0.1:5489',
    wireProtocol: 'anthropic-messages', models: [{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }] });
  const channelConfig = (): CustomProviderConfig => ({
    id: 'loopback-supplier', name: 'Loopback supplier', auth: { method: 'apiKey' }, runtimes: {},
    channels: { version: 1, channels: [{ id: 'loopback-channel', name: 'Saved channel',
      protocols: { 'anthropic-messages': channelConnection() } }], legacyBindings: { pi: 'loopback-channel' } },
  });
  const installChannel = (config = channelConfig()) => {
    state.configs = [config];
    setCustomProviders(state.configs.flatMap(config => buildUserProviderChannels(config)));
  };

  it.each(['loopback-channel', 'loopback-channel--anthropic-messages', 'loopback-supplier'])(
    'authenticates the selected saved channel %s without a Cindy key and keeps keys in the host', async providerId => {
      const config = channelConfig();
      // Migrated aliases retain their original runtime/protocol; new channels need none.
      if (providerId === 'loopback-supplier') config.runtimes.pi = channelConnection();
      installChannel(config);
      expect(await desktopPiAuthAdapter.getState({ providerId })).toMatchObject({ authenticated: true, identity: 'Loopback supplier' });
      expect(readKey).toHaveBeenCalledWith('loopback-channel', 'pi', 'anthropic-messages');
      expect(await desktopPiAuthAdapter.getAuthEnv({ providerId })).toEqual({ CINDY_PI_API_KEY: 'cindy-pi-provider-auth-placeholder' });
    },
  );

  it('refuses a saved channel with a missing key or unknown encrypted headers and never consults another channel', async () => {
    const config = channelConfig(); installChannel(config); state.channelKey = null;
    expect(await desktopPiAuthAdapter.getState({ providerId: 'loopback-channel' })).toMatchObject({ authenticated: false });
    state.channelKey = 'fixture-channel-key';
    const unknown: CustomProviderConfig = { ...config, channels: { version: 1, channels: [{
      id: 'loopback-channel', name: 'Saved channel', protocols: {
        'anthropic-messages': { ...channelConnection(), headersState: 'unknown' },
      },
    }] } };
    installChannel(unknown);
    expect(await desktopPiAuthAdapter.getState({ providerId: 'loopback-channel' })).toMatchObject({ authenticated: false });
    expect(readKey.mock.calls.every(([id, agent, protocol]) => id === 'loopback-channel' && agent === 'pi' && protocol === 'anthropic-messages')).toBe(true);
  });

  it.each(['proxy', 'owner', 'pending'] as const)('refuses channel authentication across the %s boundary', async boundary => {
    installChannel();
    if (boundary === 'proxy') state.proxyReady = false;
    else if (boundary === 'owner') state.changeOwnerDuringRead = true;
    else state.pending = true;
    expect(await desktopPiAuthAdapter.getState({ providerId: 'loopback-channel' })).toMatchObject({ authenticated: false });
    expect(readKey).not.toHaveBeenCalled();
  });

  it('refuses an owner switch during the host credential read', async () => {
    installChannel(); state.changeOwnerDuringKeyRead = true;
    expect(await desktopPiAuthAdapter.getState({ providerId: 'loopback-channel' }))
      .toMatchObject({ authenticated: false, errorReason: 'pi_native_auth_changed' });
  });

  it('refuses a supplier mutation before reading a channel credential', async () => {
    installChannel();
    const release = beginProviderRouteMutation('loopback-supplier');
    try {
      expect(await desktopPiAuthAdapter.getState({ providerId: 'loopback-channel' }))
        .toMatchObject({ authenticated: false, errorReason: 'pi_native_auth_changed' });
      expect(readKey).not.toHaveBeenCalled();
    } finally { release(); }
  });

  it('refuses a completed credential mutation while the saved configuration is being read', async () => {
    installChannel();
    state.onConfigRead = () => {
      const release = beginProviderRouteMutation('loopback-supplier');
      release.commit(); release();
    };
    expect(await desktopPiAuthAdapter.getState({ providerId: 'loopback-channel' }))
      .toMatchObject({ authenticated: false, errorReason: 'pi_native_auth_changed' });
    expect(readKey).not.toHaveBeenCalled();
  });

  it('rejects a disabled remote keyless route and a legacy alias whose original protocol is gone', async () => {
    const config = channelConfig();
    installChannel({ ...config, auth: { method: 'none' }, channels: { version: 1, channels: [{
      id: 'loopback-channel', name: 'Saved channel', protocols: {
        'anthropic-messages': { ...channelConnection(), baseUrl: 'https://example.invalid' },
      },
    }] } });
    expect(await desktopPiAuthAdapter.getState({ providerId: 'loopback-channel' })).toMatchObject({ authenticated: false });
    config.runtimes.pi = { ...channelConnection(), wireProtocol: 'openai-chat' };
    installChannel(config);
    expect(await desktopPiAuthAdapter.getState({ providerId: 'loopback-supplier' })).toMatchObject({ authenticated: false });
  });

  it('keeps channel OAuth credentials on the host and refuses a missing token', async () => {
    installChannel({ ...channelConfig(), auth: { method: 'oauth', oauth: oauthConfig() } });
    expect(await desktopPiAuthAdapter.getState({ providerId: 'loopback-channel' })).toMatchObject({ authenticated: false });
    setOAuthTokenReader(() => 'fake-host-oauth-token');
    const result = await desktopPiAuthAdapter.getState({ providerId: 'loopback-channel' });
    expect(result).toMatchObject({ authenticated: true, authSource: 'oauth' });
    expect(JSON.stringify(result)).not.toContain('fake-host-oauth-token');
    expect(await desktopPiAuthAdapter.getAuthEnv({ providerId: 'loopback-channel' }))
      .toEqual({ CINDY_PI_API_KEY: 'cindy-pi-provider-auth-placeholder' });
  });

  it('allows a keyless channel and secure header credentials through their exact host route', async () => {
    state.channelKey = null; installChannel({ ...channelConfig(), auth: { method: 'none' } });
    expect(await desktopPiAuthAdapter.getState({ providerId: 'loopback-channel' })).toMatchObject({ authenticated: true });
    const config = channelConfig();
    installChannel({ ...config, channels: { version: 1, channels: [{ id: 'loopback-channel', name: 'Saved channel',
      protocols: { 'anthropic-messages': { ...channelConnection(), headers: { 'x-api-key': 'fake-host-header' } } } }] } });
    expect(await desktopPiAuthAdapter.getState({ providerId: 'loopback-channel' })).toMatchObject({ authenticated: true });
  });

  it.each(['cindy-local-llamacpp', 'cindy-local-ollama'])('starts %s on demand during local Pi provider resolution only', async providerId => {
    await resolvePiNativeProviders({ workingDir: '/tmp/project', providerId, model: 'local-model' });
    expect(ensureLocalReady).toHaveBeenCalledWith(expect.objectContaining({ providerId, remoteHostId: null }));
    ensureLocalReady.mockClear();
    await resolvePiNativeProviders({ workingDir: '/tmp/project', providerId, model: 'local-model', purpose: 'preview' });
    expect(ensureLocalReady).not.toHaveBeenCalled();
    await resolvePiNativeProviders({ workingDir: '/remote/project', providerId, model: 'local-model', remoteHostId: 'remote-1' });
    expect(ensureLocalReady).not.toHaveBeenCalled();
  });

  it('fails closed when an official SuperGrok route has no local compat proxy', async () => {
    state.proxyReady = false;
    await expect(resolvePiNativeProviders({
      workingDir: '/tmp/project',
      providerId: 'xai',
      model: 'grok-4.6',
    })).rejects.toThrow('local compatibility proxy is not ready');
  });

  it('refreshes local shared skills before provider resolution and skips remote homes', async () => {
    await resolvePiNativeProviders({
      workingDir: '/tmp/project',
      providerId: 'local-keyless',
      model: 'local-model',
    });
    expect(state.sharedSkillRefreshes).toBe(1);

    await resolvePiNativeProviders({
      workingDir: '/remote/project',
      remoteHostId: 'remote-1',
      providerId: 'local-keyless',
      model: 'local-model',
    });
    expect(state.sharedSkillRefreshes).toBe(1);
  });

  it('authenticates the native provider and only uses an inert gateway placeholder', async () => {
    expect(await desktopPiAuthAdapter.getState({ providerId: 'local-keyless' })).toMatchObject({
      authenticated: true,
      identity: 'Local keyless',
    });
    expect(await desktopPiAuthAdapter.getAuthEnv({ providerId: 'local-keyless' })).toEqual({
      CINDY_PI_API_KEY: 'cindy-pi-provider-auth-placeholder',
    });
    expect(await desktopPiAuthAdapter.getState({ providerId: 'xd' })).toMatchObject({
      authenticated: false,
      errorReason: 'cindy_gateway_key_unavailable',
    });
  });

  it('keeps a legacy custom xai credential usable without a SuperGrok login', async () => {
    expect(await desktopPiAuthAdapter.getState({ providerId: 'custom:xai' })).toMatchObject({
      authenticated: true,
      identity: 'Legacy custom xAI',
    });
    expect(await desktopPiAuthAdapter.getState({ providerId: 'xai' })).toEqual({
      authenticated: false,
      errorReason: 'xai_oauth_unavailable',
    });
  });

  it('keeps an official xai resume on SuperGrok when a custom provider has the same model', async () => {
    state.loggedIn = true;
    const resolved = await resolvePiNativeProviders({
      workingDir: '/tmp/project',
      providerId: 'xai',
      model: 'grok-4.6',
      resumeSessionId: '/tmp/pi/official-session.jsonl',
    });

    expect(resolved.providers).toContainEqual(
      expect.objectContaining({
        id: 'xai',
        sourceProviderId: 'xai',
        baseUrl: 'http://127.0.0.1:18765/v1',
      }),
    );
    expect(resolved.providers).toContainEqual(
      expect.objectContaining({
        id: 'custom:xai',
        baseUrl: 'https://private-xai.example/v1',
      }),
    );
  });

  it('restores a migrated custom:xai session from its saved endpoint after SuperGrok is connected', async () => {
    state.loggedIn = true;
    const resolved = await resolvePiNativeProviders({
      workingDir: '/tmp/project',
      providerId: 'custom:xai',
      model: 'private-grok',
      resumeSessionId: '/tmp/pi/legacy-custom-session.jsonl',
    });

    expect(resolved.providers).toContainEqual(
      expect.objectContaining({
        id: 'custom:xai',
        baseUrl: 'https://private-xai.example/v1',
        models: expect.arrayContaining([expect.objectContaining({ id: 'private-grok' })]),
      }),
    );
    expect(Object.values(resolved.env)).toContain('legacy-custom-key');
  });

  it('does not give remote OAuth Pi a local proxy endpoint', async () => {
    const resolved = await resolvePiNativeProviders({
      workingDir: '/remote/project',
      remoteHostId: 'remote-1',
      providerId: 'openrouter-oauth',
      model: 'google/gemini-test',
    });
    expect(resolved.providers.some((provider) => provider.id.includes('openrouter-oauth'))).toBe(false);
    expect(resolved.providers.some((provider) =>
      provider.baseUrl?.includes('127.0.0.1:18765') && !provider.hostProxyForward)).toBe(false);
  });
});
