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

export function resolveSshSessionModelSelection(args: {
  providers: ProviderView[];
  loading: boolean;
  loadFailed: boolean;
  agentKind: AgentKind;
  preferred: { model: string; providerId?: string | null; effort: Effort; fastMode: boolean };
  getPresetEffort?: (agent: AgentKind, providerId: string, model: string) => Effort | undefined;
  getPresetFast?: (agent: AgentKind, providerId: string, model: string) => boolean | undefined;
}):
  | { ok: false; reason: SshModelSelectionErrorReason }
  | { ok: true; model: string; providerId: string; effort: Effort; fastMode: boolean } {
  if (args.loadFailed) return { ok: false, reason: 'catalog-error' };
  if (args.loading) return { ok: false, reason: 'catalog-loading' };

  const { agentKind, preferred } = args;
  if (agentKind === 'codex' && preferred.providerId && preferred.providerId !== 'openai') {
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
      (preferred.providerId === provider.id &&
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
  if (!preferred.model || !models.some((model) => model.id === preferred.model)) {
    return { ok: false, reason: 'no-route' };
  }

  const providerId = effectiveSourceIdForModel(
    routeProviders,
    preferred.providerId ?? null,
    preferred.model,
    agentKind,
  );
  const provider = routeProviders.find((candidate) => candidate.id === providerId);
  const descriptor = provider && getModel(provider, preferred.model, agentKind);
  if (!providerId || !descriptor) return { ok: false, reason: 'no-route' };

  return {
    ok: true,
    model: preferred.model,
    providerId,
    effort: resolveNewMakerDraftEffort({
      currentEffort: preferred.effort,
      presetEffort: args.getPresetEffort?.(agentKind, providerId, preferred.model),
      efforts: descriptor.efforts ?? [],
      defaultEffort: descriptor.defaultEffort ?? null,
    }),
    fastMode:
      descriptor.supportsFastMode === true &&
      (args.getPresetFast?.(agentKind, providerId, preferred.model) ?? preferred.fastMode),
  };
}
