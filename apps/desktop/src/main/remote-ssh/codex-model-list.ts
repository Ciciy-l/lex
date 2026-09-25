import { isOpenAiSubscriptionProvider, type ProviderView } from '@cindy/model-providers';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';

export async function readSshCodexModelList(
  input: unknown,
  read: (hostId: string) => Promise<ProviderView[]>,
): Promise<ProviderView[]> {
  const hostId = requireString(requireObject(input).id, 'id');
  if (hostId.length > 256) throwIpcError('INVALID_PARAMS', 'SSH host id is too long');
  try {
    const providers = await read(hostId);
    const native = providers.find(
      (provider) => provider.id === 'openai' && isOpenAiSubscriptionProvider(provider),
    );
    if (!native?.models.codex?.length) throw new Error('Empty SSH Codex model list');
    return [native];
  } catch {
    throwIpcError('SSH_EXEC_FAILED', 'Unable to read SSH Codex models; reconnect and retry');
  }
}

export function assertSshCodexModel(
  providers: readonly ProviderView[],
  model: string,
  providerId?: string | null,
): void {
  if (providerId && providerId !== 'openai') {
    throwIpcError('INVALID_PARAMS', 'SSH Codex uses the remote native subscription route');
  }
  const native = providers.find(
    (provider) => provider.id === 'openai' && isOpenAiSubscriptionProvider(provider),
  );
  if (!native?.models.codex?.some((candidate) => candidate.id === model)) {
    throwIpcError('INVALID_PARAMS', 'Model is unavailable on this SSH host; select a remote Codex model');
  }
}

export function isVerifiedSshCodexResume(
  request: {
    agentKind: string;
    id?: string;
    model?: string;
    providerId?: string | null;
    remoteHostId?: string | null;
    resumeSessionId?: string;
  },
  stored: {
    agentKind: string;
    model: string;
    providerId: string | null;
    remoteHostId: string | null;
    sdkSessionId: string | null;
  } | undefined,
): boolean {
  return !!stored && request.agentKind === 'codex' && stored.agentKind === 'codex' &&
    !!request.id && !!request.remoteHostId && !!request.resumeSessionId &&
    stored.remoteHostId === request.remoteHostId &&
    stored.sdkSessionId === request.resumeSessionId &&
    stored.model === request.model &&
    (stored.providerId ?? null) === (request.providerId ?? null) &&
    (!request.providerId || request.providerId === 'openai');
}
