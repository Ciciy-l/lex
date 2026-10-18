import type { Provider, ProviderPreset, ProviderWireProtocol } from './types.js';
import { providerCatalogId } from './provider-identity.js';

const wires = new Set<ProviderWireProtocol>([
  'anthropic-messages',
  'openai-responses',
  'openai-chat',
  'google-generative-ai',
]);
const supportedApi = (api: string | undefined) =>
  api === undefined || api === 'openai-completions' || wires.has(api as ProviderWireProtocol);

/** OMP uses the existing managed proxy. Only native built-in connections share auth;
 * user runtimes own separate credentials and must be configured explicitly. */
export function projectBuiltinOmpProvider(provider: Provider): Provider {
  if (provider.source === 'user' && !provider.auth.native) return provider;
  // Explicit membership (including an empty roster / disabled runtime) is authoritative.
  if (provider.routing.omp !== undefined || provider.models.omp !== undefined) return provider;
  const subscription = provider.auth.method === 'oauth';
  const agents = subscription
    ? (['codex', 'claude-code'] as const)
    : (['claude-code', 'codex'] as const);
  for (const agent of agents) {
    const routing = provider.routing[agent];
    if (!provider.agents.includes(agent) || !routing || routing.disabled) continue;
    // OMP carries a process token, never the native CLI's upstream OAuth token.
    // OpenAI Responses uses the host's dedicated subscription handler; other
    // native passthrough-only routes cannot safely be advertised.
    if (
      routing.authStrategy === 'oauth-passthrough' &&
      !(providerCatalogId(provider) === 'openai' && agent === 'codex')
    )
      continue;
    const wire =
      routing.wireProtocol ?? (agent === 'claude-code' ? 'anthropic-messages' : 'openai-responses');
    if (!wires.has(wire)) continue;
    const models = (provider.models[agent] ?? []).filter(
      (model) => !model.route || wires.has(model.route.wireProtocol),
    );
    if (!models.length) continue;
    return {
      ...provider,
      agents: [...provider.agents, 'omp'],
      routing: { ...provider.routing, omp: { ...routing, wireProtocol: wire } },
      models: { ...provider.models, omp: models },
    };
  }
  return provider;
}

/** A template is not an enabled connection. The form still owns opting in and saving its key. */
export function withOmpPresetRuntime(preset: ProviderPreset): ProviderPreset {
  if (preset.runtimes.omp !== undefined) return preset;
  for (const agent of ['claude-code', 'codex', 'pi'] as const) {
    const runtime = preset.runtimes[agent];
    if (!runtime) continue;
    const wire =
      runtime.wireProtocol ??
      (agent === 'claude-code'
        ? 'anthropic-messages'
        : agent === 'codex'
          ? 'openai-responses'
          : undefined);
    if (!wire || !wires.has(wire)) continue;
    const models = runtime.models.filter(
      (model) =>
        supportedApi(model.api ?? model.piApi) &&
        (!model.route || wires.has(model.route.wireProtocol)),
    );
    if (runtime.models.length && !models.length) continue;
    return {
      ...preset,
      runtimes: {
        ...preset.runtimes,
        omp: { ...runtime, wireProtocol: wire, models },
      },
    };
  }
  return preset;
}
