import type { AgentKind, ProviderWireProtocol } from '@cindy/model-providers';

export type CustomProviderCodexWireProtocol = Extract<
  ProviderWireProtocol,
  'openai-responses' | 'openai-chat' | 'anthropic-messages' | 'google-generative-ai'
>;

interface CustomProviderWireProtocolOption {
  value: CustomProviderCodexWireProtocol;
  labelKey: string;
  helpKey: string;
  defaultRequestPath: string;
}

export const CUSTOM_PROVIDER_CODEX_WIRE_PROTOCOLS = [
  {
    value: 'openai-responses',
    labelKey: 'settings.providers.custom.wireProtocol.responses',
    helpKey: 'settings.providers.custom.wireProtocol.responsesHelp',
    defaultRequestPath: '/responses',
  },
  {
    value: 'openai-chat',
    labelKey: 'settings.providers.custom.wireProtocol.chat',
    helpKey: 'settings.providers.custom.wireProtocol.chatHelp',
    defaultRequestPath: '/chat/completions',
  },
  {
    value: 'anthropic-messages',
    labelKey: 'settings.providers.custom.wireProtocol.anthropic',
    helpKey: 'settings.providers.custom.wireProtocol.anthropicHelp',
    defaultRequestPath: '/v1/messages',
  },
  {
    value: 'google-generative-ai',
    labelKey: 'settings.providers.custom.modelProtocol.google',
    helpKey: 'settings.providers.custom.wireProtocol.googleHelp',
    defaultRequestPath: '',
  },
] as const satisfies readonly CustomProviderWireProtocolOption[];

/** The pinned OMP runtime supports all four native provider APIs. */
export const CUSTOM_PROVIDER_OMP_WIRE_PROTOCOLS = CUSTOM_PROVIDER_CODEX_WIRE_PROTOCOLS;

/**
 * Keep the settings choices aligned with the host's executable protocols.
 */
export function customProviderWireProtocolsForAgent(
  agent: AgentKind,
): readonly CustomProviderWireProtocolOption[] {
  return agent === 'omp'
    ? CUSTOM_PROVIDER_OMP_WIRE_PROTOCOLS
    : CUSTOM_PROVIDER_CODEX_WIRE_PROTOCOLS;
}

export function customProviderCodexWireProtocolOption(
  protocol: ProviderWireProtocol,
): (typeof CUSTOM_PROVIDER_CODEX_WIRE_PROTOCOLS)[number] {
  return CUSTOM_PROVIDER_CODEX_WIRE_PROTOCOLS.find((option) => option.value === protocol)
    ?? CUSTOM_PROVIDER_CODEX_WIRE_PROTOCOLS[0];
}
