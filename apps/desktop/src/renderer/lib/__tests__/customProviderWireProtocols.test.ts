import { describe, expect, it } from 'vitest';

import {
  CUSTOM_PROVIDER_CODEX_WIRE_PROTOCOLS,
  CUSTOM_PROVIDER_OMP_WIRE_PROTOCOLS,
  customProviderCodexWireProtocolOption,
  customProviderWireProtocolsForAgent,
} from '../customProviderWireProtocols';

describe('custom provider Codex wire protocols', () => {
  it('offers every supported Codex route including the Anthropic Messages bridge', () => {
    expect(CUSTOM_PROVIDER_CODEX_WIRE_PROTOCOLS.map((option) => option.value)).toEqual([
      'openai-responses',
      'openai-chat',
      'anthropic-messages',
      'google-generative-ai',
    ]);
  });

  it('uses the Anthropic Messages endpoint as its default request path', () => {
    expect(customProviderCodexWireProtocolOption('anthropic-messages')).toMatchObject({
      helpKey: 'settings.providers.custom.wireProtocol.anthropicHelp',
      defaultRequestPath: '/v1/messages',
    });
  });

  it('does not offer Google-native wire protocol to OMP', () => {
    expect(CUSTOM_PROVIDER_OMP_WIRE_PROTOCOLS.map((option) => option.value)).toEqual([
      'openai-responses',
      'openai-chat',
      'anthropic-messages',
    ]);
    expect(customProviderWireProtocolsForAgent('omp')).toBe(
      CUSTOM_PROVIDER_OMP_WIRE_PROTOCOLS,
    );
    expect(customProviderWireProtocolsForAgent('pi')).toBe(
      CUSTOM_PROVIDER_CODEX_WIRE_PROTOCOLS,
    );
  });
});
