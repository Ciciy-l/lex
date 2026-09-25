import type { AgentKind } from '@cindy/maker-core';
import {
  connectedProvidersForAgent,
  effectiveSourceIdForModel,
  findModelRegistryRoute,
  isOpenAiSubscriptionProvider,
  isModelSelectableForNewRoute,
  isLocalOnlyProviderForAgent,
  type Catalog,
  type ProviderView,
} from '@cindy/model-providers';

import type { ProviderService } from '../maker-host/provider-service.js';
import { usesControllerProviderProxyForSsh } from '../../shared/sshAgentProviderRouting.js';
import {
  providerRouteRequiresExplicitSelection,
  type OrcaWorkerModelCapabilities,
  type OrcaWorkerProviderRoutingContext,
} from './orcaWorkerCreationService.js';

export function sshCodexWorkerRoutingContext(views: ProviderView[]): OrcaWorkerProviderRoutingContext {
  const provider = views.find(
    (candidate) => candidate.id === 'openai' && isOpenAiSubscriptionProvider(candidate),
  );
  const models = (provider?.models.codex ?? []).filter((model) =>
    isModelSelectableForNewRoute(model, { userProvider: provider?.source === 'user' }),
  );
  const remoteCodexModels: OrcaWorkerModelCapabilities[] = models.map((model) => ({
    id: model.id,
    efforts: model.efforts,
    defaultEffort: model.defaultEffort,
    supportsFastMode: model.supportsFastMode,
  }));
  const codexAvailability = provider && models.length > 0
    ? [{
        id: 'openai',
        name: provider.name,
        models: models.map((model) => model.id),
        fastModels: models.filter((model) => model.supportsFastMode).map((model) => model.id),
        effortMetaByModel: Object.fromEntries(models.map((model) => [
          model.id,
          { efforts: model.efforts, defaultEffort: model.defaultEffort },
        ])),
        requiresExplicitRoute: false,
        localOnlyForSsh: false,
      }]
    : [];
  const modelIds = new Set(models.map((model) => model.id));

  return {
    remoteCodexModels,
    availability: { 'claude-code': [], codex: codexAvailability, pi: [], omp: [] },
    resolveDefaultProviderIdForModel: (agent, model) =>
      agent === 'codex' && modelIds.has(model) ? 'openai' : null,
  };
}

/**
 * Build the Orca worker route snapshot from one post-claim full catalog.
 *
 * `listProviders` invokes `getCatalog` after all connection readers settle. Keeping the exact
 * object returned by that callback lets the registry identity lookup use the same catalog as the
 * provider views, instead of mixing a pre-claim selectable projection with post-claim views.
 */
export async function readOrcaWorkerProviderRoutingContext(deps: {
  providerService: ProviderService;
  getCatalog: () => Catalog;
}): Promise<OrcaWorkerProviderRoutingContext> {
  let postClaimCatalog: Catalog | undefined;
  const views = await deps.providerService.listProviders({
    allowSideEffects: true,
    waitForDiscovery: true,
    getCatalog: () => {
      postClaimCatalog = deps.getCatalog();
      return postClaimCatalog;
    },
  });
  const catalog = postClaimCatalog ?? deps.getCatalog();
  const modelRegistry = catalog.modelRegistry;

  // Keep the route policy aligned with modelList.ts: disabled/non-chat capability entries do not
  // enter a new worker route, while the model registry identity remains provider-specific.
  const routableModels = (provider: ProviderView, agent: AgentKind) =>
    (provider.models[agent] ?? []).filter((model) =>
      isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' }),
    );
  const availabilityFor = (agent: AgentKind) =>
    connectedProvidersForAgent(views, agent).map((provider) => {
      const models = routableModels(provider, agent);
      const registryIdentityByModel = Object.fromEntries(
        models.flatMap((model) => {
          const matched = findModelRegistryRoute(
            modelRegistry,
            provider.id,
            model.id,
            agent === 'pi' || agent === 'omp' ? undefined : agent,
          );
          return matched ? [[model.id, matched.entry.id]] : [];
        }),
      );
      return {
        id: provider.id,
        name: provider.name,
        models: models.map((model) => model.id),
        registryIdentityByModel,
        fastModels: models.filter((model) => model.supportsFastMode).map((model) => model.id),
        effortMetaByModel: Object.fromEntries(
          models.map((model) => [
            model.id,
            { efforts: model.efforts, defaultEffort: model.defaultEffort },
          ]),
        ),
        requiresExplicitRoute: providerRouteRequiresExplicitSelection(
          provider.routing[agent]?.authStrategy,
        ),
        // Remote OMP reaches this controller-owned catalog through its own
        // authenticated reverse-forward, so a provider that is local-only for
        // a native SSH adapter is still routable for OMP. Other engines retain
        // the existing direct-provider restriction.
        localOnlyForSsh:
          !usesControllerProviderProxyForSsh(agent) &&
          isLocalOnlyProviderForAgent(provider, agent),
      };
    });

  return {
    availability: {
      'claude-code': availabilityFor('claude-code'),
      codex: availabilityFor('codex'),
      pi: availabilityFor('pi'),
      // OMP 与 Pi 共用网关目录(registry 身份同样交给 modelRegistry 解析),
      // 故这里的可用性快照与 Pi 完全同构。
      omp: availabilityFor('omp'),
    },
    resolveDefaultProviderIdForModel: (agent, model) =>
      effectiveSourceIdForModel(views, null, model, agent),
  };
}
