import { describe, expect, it } from 'vitest';
import { buildUserProvider } from '../user-provider.js';
import { modelProtocolComparison, nativeModelAgents } from '../modelProtocol.js';
import { pickRecommendedAgent, resolveAgentCapability } from '../unifiedSelection.js';
import type { CatalogModel, PiModelApi, Provider } from '../types.js';

const model: CatalogModel = {
  id: 'future/model',
  name: 'Future',
  contextWindow: 1048576,
  efforts: [],
  defaultEffort: null,
};
function fixture(api?: PiModelApi) {
  const byAgent: Record<'claude-code' | 'codex' | 'pi', CatalogModel> = {
    'claude-code': { ...model },
    codex: { ...model },
    pi: { ...model, ...(api ? { piApi: api, nativeApi: api } : {}) },
  };
  const provider = {
    id: 'xd',
    agents: ['claude-code', 'codex', 'pi'],
    routing: {
      'claude-code': { wireProtocol: 'anthropic-messages' },
      codex: { wireProtocol: 'openai-responses' },
      pi: { wireProtocol: 'openai-responses' },
    },
    models: Object.fromEntries(Object.entries(byAgent).map(([agent, entry]) => [agent, [entry]])),
  } as Provider;
  return { provider, byAgent };
}

describe('per-model protocol comparison', () => {
  it('compares a newly delivered Google API with both compatibility harnesses and recommends Pi', () => {
    const { provider, byAgent } = fixture('google-generative-ai');
    const result = modelProtocolComparison(provider, byAgent);
    expect(result.reference).toBe('google-generative-ai');
    expect(result.forAgent('claude-code')).toMatchObject({
      harness: 'anthropic-messages',
      outbound: 'anthropic-messages',
      mode: 'compatibility',
      localConversion: false,
    });
    expect(result.forAgent('codex')).toMatchObject({
      harness: 'openai-responses',
      outbound: 'openai-responses',
      mode: 'compatibility',
      localConversion: false,
    });
    expect(result.forAgent('pi')).toMatchObject({
      harness: 'google-generative-ai',
      outbound: 'google-generative-ai',
      mode: 'matching',
    });
    expect(pickRecommendedAgent(provider, model.id, provider.agents)).toBe('pi');
    expect(pickRecommendedAgent(provider, model.id, ['claude-code', 'codex'])).toBe('claude-code');
  });

  it.each(['openai-chat', 'openai-responses'] as const)(
    'marks Chat Completions via %s as compatibility without misreporting the native CLI transport',
    (wireProtocol) => {
      const { provider, byAgent } = fixture('openai-completions');
      provider.routing.codex!.wireProtocol = wireProtocol;
      expect(modelProtocolComparison(provider, byAgent).forAgent('codex')).toMatchObject({
        harness: 'openai-responses',
        outbound: wireProtocol === 'openai-chat' ? 'openai-completions' : 'openai-responses',
        localConversion: wireProtocol === 'openai-chat',
        mode: 'compatibility',
      });
      expect(resolveAgentCapability([{ ...provider, connected: true }], 'xd', model.id, 'codex')?.protocolMode)
        .toBe('compatibility');
    },
  );

  it('does not infer a native Google route or recommendation from a Gemini name', () => {
    const { provider, byAgent } = fixture('openai-responses');
    for (const entry of Object.values(byAgent)) entry.id = 'google/gemini-future';
    expect(pickRecommendedAgent(provider, 'google/gemini-future', provider.agents)).toBe('codex');
    expect(modelProtocolComparison(provider, byAgent).forAgent('pi')?.outbound).toBe(
      'openai-responses',
    );
  });

  it('only recommends a native candidate when its effective route also matches', () => {
    const { provider, byAgent } = fixture('openai-responses');
    byAgent.codex.route = {
      baseUrl: 'https://example.invalid',
      wireProtocol: 'anthropic-messages',
    };
    expect(pickRecommendedAgent(provider, model.id, provider.agents)).toBe('pi');
    byAgent.pi.nativeApi = 'google-generative-ai';
    expect(modelProtocolComparison(provider, byAgent).forAgent('pi')?.mode).toBe('matching');
    expect(pickRecommendedAgent(provider, model.id, provider.agents)).toBe('pi');
  });

  it('uses model route overrides for local conversion, ignoring obsolete compatibility annotations', () => {
    const { provider, byAgent } = fixture('anthropic-messages');
    const codex = {
      ...model,
      route: {
        baseUrl: 'https://example.invalid',
        wireProtocol: 'anthropic-messages' as const,
      },
    };
    expect(
      modelProtocolComparison(provider, { ...byAgent, codex }).forAgent('codex'),
    ).toMatchObject({
      harness: 'openai-responses',
      outbound: 'anthropic-messages',
      mode: 'compatibility',
      localConversion: true,
    });
    expect(
      modelProtocolComparison(provider, {
        ...byAgent,
        codex: { ...model, codexCompatibilityWireProtocol: 'openai-chat' },
      }).forAgent('codex')?.outbound,
    ).toBe('openai-responses');
  });

  it('projects protocol support with the same provider and real bridge model identity', () => {
    const { provider } = fixture('google-generative-ai');
    const other = {
      ...provider,
      id: 'other',
      models: { codex: [{ ...model, nativeApi: 'openai-responses' as const }] },
    };
    const providers = [
      { ...provider, connected: true },
      { ...other, connected: true },
    ];
    expect(resolveAgentCapability(providers, 'xd', model.id, 'pi')).toMatchObject({
      protocolMode: 'matching',
      nativeApi: 'google-generative-ai',
      outboundApi: 'google-generative-ai',
    });
    expect(resolveAgentCapability(providers, 'xd', model.id, 'codex')).toMatchObject({
      protocolMode: 'compatibility',
      nativeApi: 'google-generative-ai',
      outboundApi: 'openai-responses',
    });
    expect(resolveAgentCapability(providers, 'other', model.id, 'codex')?.protocolMode).toBe(
      'matching',
    );
    const subscription = {
      ...provider,
      id: 'openai',
      connected: true,
      models: {
        codex: [{ ...model, id: 'gpt-test' }],
        'claude-code': [{ ...model, id: 'chatgpt/gpt-test' }],
      },
    };
    expect(
      resolveAgentCapability([subscription], 'openai', 'gpt-test', 'claude-code'),
    ).toMatchObject({
      wireModelId: 'chatgpt/gpt-test',
      protocolMode: 'compatibility',
    });
  });

  it('keeps absent declarations unknown and does not invent a route in redacted views', () => {
    const { provider, byAgent } = fixture();
    const result = modelProtocolComparison(provider, byAgent);
    expect(result.reference).toBeNull();
    expect(result.forAgent('pi')?.mode).toBe('matching');
    expect(
      modelProtocolComparison(
        { id: 'xd', routing: { codex: {} } as Provider['routing'] },
        byAgent,
      ).forAgent('codex')?.outbound,
    ).toBeNull();
    expect(modelProtocolComparison(provider, {}).forAgent('pi')).toBeNull();
  });
});


describe('custom supplier transport ownership', () => {
  it.each(['anthropic-messages', 'openai-responses', 'openai-completions', 'google-generative-ai', 'bedrock-converse-stream', 'azure-openai-responses', 'google-vertex', 'mistral-conversations'] as const)(
    'Pi uses %s directly; only mismatching fixed-protocol harnesses require conversion', api => {
      const { provider, byAgent } = fixture('google-generative-ai');
      provider.source = 'user';
      for (const model of Object.values(byAgent)) { model.api = api; model.nativeApi = api; }
      const result = modelProtocolComparison(provider, byAgent);
      expect(result.forAgent('pi')).toMatchObject({ outbound: api, mode: 'matching', localConversion: false });
      expect(result.forAgent('claude-code')?.mode).toBe(api === 'anthropic-messages' ? 'matching' : 'compatibility');
      expect(result.forAgent('codex')?.mode).toBe(['openai-responses', 'azure-openai-responses'].includes(api) ? 'matching' : 'compatibility');
    },
  );

  it.each(['builtin', 'user'] as const)('applies Gateway compatibility defaults to %s supplier front doors', source => {
    const { provider, byAgent } = fixture('google-generative-ai');
    provider.source = source;
    byAgent.pi.api = 'openai-completions';
    const comparison = modelProtocolComparison(provider, byAgent);
    expect(comparison.forAgent('claude-code')).toMatchObject({ mode: 'compatibility', localConversion: false });
    expect(comparison.forAgent('codex')).toMatchObject({ mode: 'compatibility', localConversion: false });
    expect(comparison.forAgent('pi')).toMatchObject({ mode: 'matching', outbound: 'openai-completions' });
    expect(nativeModelAgents(provider, byAgent)).toEqual(['pi']);
  });

  it('does not advertise or automatically enable unverified fixed-protocol engines', () => {
    const { provider, byAgent } = fixture();
    provider.source = 'user';
    expect(modelProtocolComparison(provider, byAgent).forAgent('codex')?.mode).toBe('unknown');
    expect(nativeModelAgents(provider, byAgent)).toEqual(['pi']);
  });
});

describe('OMP protocol support', () => {
  it.each(['anthropic-messages', 'openai-responses', 'openai-chat'] as const)(
    'OMP speaks its configured %s route without fixed-Anthropic compatibility',
    (wire) => {
      const api = wire === 'openai-chat' ? 'openai-completions' : wire;
      const provider = {
        id: 'omp-source',
        routing: { omp: { wireProtocol: wire } },
      } as Provider;
      const models: { omp: CatalogModel } = { omp: { ...model, nativeApi: api } };
      expect(
        modelProtocolComparison(provider, models).forAgent('omp'),
      ).toMatchObject({
        harness: api,
        outbound: api,
        localConversion: false,
        mode: 'matching',
      });
      expect(nativeModelAgents(provider, models)).toEqual(['omp']);
      expect(
        resolveAgentCapability(
          [{ ...provider, connected: true, models: { omp: [models.omp] } }],
          provider.id,
          model.id,
          'omp',
        ),
      ).toMatchObject({ protocolMode: 'matching', outboundApi: api });
    },
  );

  it('OMP follows the actual per-model wire override instead of conflicting generic metadata', () => {
    const provider = {
      id: 'source',
      routing: { omp: { wireProtocol: 'anthropic-messages' } },
    } as Provider;
    const omp: CatalogModel = {
      ...model,
      api: 'anthropic-messages',
      route: {
        baseUrl: 'https://example.invalid',
        wireProtocol: 'openai-chat',
      },
    };
    expect(
      modelProtocolComparison(provider, { omp }).forAgent('omp'),
    ).toMatchObject({
      harness: 'openai-completions',
      outbound: 'openai-completions',
      mode: 'matching',
      localConversion: false,
    });
    omp.nativeApi = 'google-generative-ai';
    expect(
      modelProtocolComparison(provider, { omp }).forAgent('omp')?.mode,
    ).toBe('compatibility');
    expect(nativeModelAgents(provider, { omp })).toEqual([]);
  });

  it('does not invent a native OMP Google bridge or a route in a redacted view', () => {
    const provider = {
      id: 'source',
      routing: { omp: { wireProtocol: 'google-generative-ai' } },
    } as Provider;
    expect(
      modelProtocolComparison(provider, { omp: model }).forAgent('omp'),
    ).toMatchObject({
      harness: 'anthropic-messages',
      mode: 'compatibility',
      localConversion: true,
    });
    expect(
      modelProtocolComparison(
        { id: 'source', routing: {} },
        { omp: { ...model, api: 'openai-responses' } },
      ).forAgent('omp'),
    ).toMatchObject({ outbound: null, mode: 'unknown' });
  });

  it('updates only inferred OMP defaults and preserves explicit disabled models', () => {
    const provider = buildUserProvider({
      id: 'omp-user',
      name: 'OMP user',
      runtimes: {
        omp: {
          baseUrl: 'https://example.invalid/v1',
          wireProtocol: 'openai-chat',
          models: [
            { id: 'inferred', name: 'Inferred' },
            { id: 'disabled', name: 'Disabled', defaultEnabled: false },
          ],
        },
      },
    });
    expect(provider.models.omp?.map((entry) => entry.defaultEnabled)).toEqual([
      true,
      false,
    ]);
  });
});
