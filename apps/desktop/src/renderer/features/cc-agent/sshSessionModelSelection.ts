import {
  connectedProvidersForAgent,
  effectiveSourceIdForModel,
  getModel,
  isOpenAiSubscriptionProvider,
  isModelSelectableForNewRoute,
  type AgentKind,
  type ProviderView,
} from '@cindy/model-providers';
import { deriveModelsFromProviders, filterChatBridgedCodexProviders } from '@/lib/providerModels';
import type { Effort } from '@/lib/userPreferences.types';
import { isSubscriptionDirectModel } from '../../../shared/subscriptionModels';
import { usesControllerProviderProxyForSsh } from '../../../shared/sshAgentProviderRouting';
import { resolveNewMakerDraftEffort } from './newMakerDraftModelPrefs';

export type SshModelSelectionErrorReason =
  'catalog-loading' | 'catalog-error' | 'no-route' | 'unsupported-codex-source';

export const sshModelSelectionErrorKeys: Record<SshModelSelectionErrorReason, string> = {
  'catalog-loading': 'settings.remote.startSession.modelCatalogLoading',
  'catalog-error': 'settings.remote.startSession.modelCatalogFailed',
  'no-route': 'settings.remote.startSession.noCompatibleModel',
  'unsupported-codex-source': 'settings.remote.startSession.unsupportedCodexSource',
};

export class SshModelSelectionError extends Error {
  constructor(readonly reason: SshModelSelectionErrorReason) {
    super(reason);
    this.name = 'SshModelSelectionError';
  }
}

export type ResolvedSshSessionModelSelection = Extract<
  ReturnType<typeof resolveSshSessionModelSelection>,
  { ok: true }
>;

export interface SshSessionModelPreference {
  model?: string;
  providerId?: string | null;
  effort?: Effort;
  fastMode?: boolean;
}

export function isSameSshSessionModelSelection(
  expected: ResolvedSshSessionModelSelection,
  actual: ResolvedSshSessionModelSelection,
): boolean {
  return (
    expected.model === actual.model &&
    expected.providerId === actual.providerId &&
    expected.effort === actual.effort &&
    expected.fastMode === actual.fastMode
  );
}

export async function loadSshSessionModelSelection(
  hostId: string,
  args: {
    agentKind?: AgentKind;
    preferred?: SshSessionModelPreference;
    getPresetEffort?: (agent: AgentKind, providerId: string, model: string) => Effort | undefined;
    getPresetFast?: (agent: AgentKind, providerId: string, model: string) => boolean | undefined;
  } = {},
): Promise<ReturnType<typeof resolveSshSessionModelSelection>> {
  const agentKind = args.agentKind ?? 'codex';
  if (agentKind !== 'codex') {
    return { ok: false, reason: 'no-route' };
  }
  if (args.preferred?.providerId && args.preferred.providerId !== 'openai') {
    return { ok: false, reason: 'unsupported-codex-source' };
  }
  try {
    const providers = await window.electronAPI.remoteSsh.listCodexModels(hostId);
    return resolveSshSessionModelSelection({
      providers,
      loading: false,
      loadFailed: false,
      agentKind,
      preferred: args.preferred,
      getPresetEffort: args.getPresetEffort,
      getPresetFast: args.getPresetFast,
    });
  } catch {
    return { ok: false, reason: 'catalog-error' };
  }
}

export function resolveSshSessionModelSelection(args: {
  providers: ProviderView[];
  loading: boolean;
  loadFailed: boolean;
  agentKind: AgentKind;
  preferred?: SshSessionModelPreference;
  getPresetEffort?: (agent: AgentKind, providerId: string, model: string) => Effort | undefined;
  getPresetFast?: (agent: AgentKind, providerId: string, model: string) => boolean | undefined;
}):
  | { ok: false; reason: SshModelSelectionErrorReason }
  | { ok: true; model: string; providerId: string; effort: Effort; fastMode: boolean } {
  if (args.loadFailed) return { ok: false, reason: 'catalog-error' };
  if (args.loading) return { ok: false, reason: 'catalog-loading' };

  const { agentKind, preferred } = args;
  if (agentKind === 'codex' && preferred?.providerId && preferred.providerId !== 'openai') {
    return { ok: false, reason: 'unsupported-codex-source' };
  }

  const sourceCandidates =
    agentKind === 'codex'
      ? args.providers.filter(
          (provider) => provider.id === 'openai' && isOpenAiSubscriptionProvider(provider),
        )
      : args.providers;
  const connected = filterChatBridgedCodexProviders(
    connectedProvidersForAgent(sourceCandidates, agentKind),
    agentKind,
    true,
  ).filter(
    (provider) =>
      !provider.modelDiscoveryFailure ||
      (preferred?.providerId === provider.id &&
        (provider.models[agentKind] ?? []).some((model) => model.id === preferred.model)),
  );
  const excludeSubscriptionDirect = !usesControllerProviderProxyForSsh(agentKind);
  const routeProviders = connected.map((provider) => ({
    ...provider,
    models: {
      ...provider.models,
      [agentKind]: (provider.models[agentKind] ?? []).filter(
        (model) =>
          isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' }) &&
          !(excludeSubscriptionDirect && isSubscriptionDirectModel(model.id)),
      ),
    },
  }));
  const models = deriveModelsFromProviders(routeProviders, agentKind, { admissionFiltered: true });
  const selectedModel = preferred?.model
    ? (models.find((model) => model.id === preferred.model)?.id ?? null)
    : (models[0]?.id ?? null);
  if (!selectedModel) {
    return { ok: false, reason: 'no-route' };
  }

  const providerId = effectiveSourceIdForModel(
    routeProviders,
    preferred?.providerId ?? null,
    selectedModel,
    agentKind,
  );
  const provider = routeProviders.find((candidate) => candidate.id === providerId);
  const descriptor = provider && getModel(provider, selectedModel, agentKind);
  if (!providerId || !descriptor) return { ok: false, reason: 'no-route' };

  return {
    ok: true,
    model: selectedModel,
    providerId,
    effort: resolveNewMakerDraftEffort({
      currentEffort: preferred?.effort ?? descriptor.defaultEffort ?? descriptor.efforts?.[0] ?? 'medium',
      presetEffort: args.getPresetEffort?.(agentKind, providerId, selectedModel),
      efforts: descriptor.efforts ?? [],
      defaultEffort: descriptor.defaultEffort ?? null,
    }),
    fastMode:
      descriptor.supportsFastMode === true &&
      (args.getPresetFast?.(agentKind, providerId, selectedModel) ?? preferred?.fastMode ?? false),
  };
}
