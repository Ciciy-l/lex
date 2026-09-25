import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ScriptTarget, transpileModule } from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PINNED_CODEX_RELEASE_VERSION } from '@cindy/maker-remote-ssh';

const source = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf8')
  .replaceAll(String.fromCharCode(13), '');
const cacheStart = source.indexOf('function isAgentCacheHit(');
const cacheEnd = source.indexOf('\n/**', cacheStart);
const ensureStart = source.indexOf('export async function ensureRemoteAgentInstalled(');
const ensureEnd = source.indexOf('\n/**', ensureStart);
const silentStart = source.indexOf('export async function ensureRemoteAgentInstalledOrInstall(');
const silentEnd = source.indexOf('\nfunction remoteConnectionFieldsChanged', silentStart);
const sourceFunctions = [
  source.slice(cacheStart, cacheEnd),
  source.slice(ensureStart, ensureEnd).replace('export async function', 'async function'),
  source.slice(silentStart, silentEnd).replace('export async function', 'async function'),
].join('\n');
const compiled = transpileModule(sourceFunctions, {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;

const mocks = vi.hoisted(() => ({ probe: vi.fn(), install: vi.fn(), exec: vi.fn() }));

function harness(initialVersion: string | null = null, probeVersion: string = PINNED_CODEX_RELEASE_VERSION) {
  const cache = new Map<string, Map<string, { installedVersion: string | null }>>();
  if (initialVersion !== null) cache.set('builder', new Map([['codex', { installedVersion: initialVersion }]]));
  const host = { getStatus: () => 'ready', exec: mocks.exec };
  mocks.probe.mockResolvedValue({ installed: true, installedVersion: probeVersion });
  mocks.install.mockResolvedValue({
    ready: true,
    installed: true,
    nodeReady: true,
    nodeVersion: null,
    installedVersion: PINNED_CODEX_RELEASE_VERSION,
    installDir: '/remote/managed',
    binaryPath: '/remote/managed/codex',
    error: null,
  });
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const invoke = new Function(
    'remoteAgentInstalledCache', 'PINNED_CODEX_RELEASE_VERSION', 'PINNED_OMP_VERSION', 'PINNED_PI_VERSION',
    'getPool', 'probeRemoteAgent', 'throwIpcError', 'inFlightKey', 'inFlightInstall', 'log',
    'broadcastSilentInstallStatus', 'redactCredentialText', 'broadcastInstallProgress',
    'installRemoteAgent', 'isIpcErrorCode',
    compiled + '; return { ensureRemoteAgentInstalled, ensureRemoteAgentInstalledOrInstall, isAgentCacheHit };',
  )(
    cache, PINNED_CODEX_RELEASE_VERSION, 'unused-omp-pin', 'unused-pi-pin',
    () => new Map([['builder', host]]), mocks.probe,
    (code: string, message: string) => { throw Object.assign(new Error(message), { code }); },
    (hostId: string, agentKind: string) => hostId + ':' + agentKind,
    new Map(), logger, vi.fn(), (value: string) => value, vi.fn(), mocks.install,
    (code: string) => ['SSH_AGENT_NOT_INSTALLED', 'SSH_INSTALL_FAILED', 'SSH_HOST_NOT_FOUND', 'SSH_NOT_CONNECTED', 'INTERNAL'].includes(code),
  ) as {
    ensureRemoteAgentInstalled(hostId: string, kind: string): Promise<void>;
    ensureRemoteAgentInstalledOrInstall(hostId: string, kind: string): Promise<{ installedVersion: string | null }>;
    isAgentCacheHit(cache: Map<string, { installedVersion: string | null }> | undefined, kind: string): boolean;
  };
  return { cache, invoke };
}

beforeEach(() => {
  mocks.probe.mockReset();
  mocks.install.mockReset();
  mocks.exec.mockReset();
});

describe('SSH Codex managed package readiness', () => {
  it('probes a stale install and repairs it using the repository pin', async () => {
    const { cache, invoke } = harness('legacy-standalone', 'older-release');
    await expect(invoke.ensureRemoteAgentInstalledOrInstall('builder', 'codex'))
      .resolves.toMatchObject({ installedVersion: PINNED_CODEX_RELEASE_VERSION });
    expect(mocks.probe).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'codex');
    expect(mocks.install).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'codex', expect.any(Function));
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(cache.get('builder')?.get('codex')?.installedVersion).toBe(PINNED_CODEX_RELEASE_VERSION);
  });

  it('reuses only an exact pinned readiness cache entry', async () => {
    const { cache, invoke } = harness(PINNED_CODEX_RELEASE_VERSION);
    expect(invoke.isAgentCacheHit(cache.get('builder'), 'codex')).toBe(true);
    await invoke.ensureRemoteAgentInstalledOrInstall('builder', 'codex');
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('fails closed when a direct readiness check reports a stale release', async () => {
    const { invoke } = harness(null, 'older-release');
    await expect(invoke.ensureRemoteAgentInstalled('builder', 'codex'))
      .rejects.toMatchObject({ code: 'SSH_AGENT_NOT_INSTALLED' });
    expect(mocks.install).not.toHaveBeenCalled();
  });
});
