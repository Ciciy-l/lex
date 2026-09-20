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

/** OMP's managed bridge implements the three non-Google wire formats. */
export const CUSTOM_PROVIDER_OMP_WIRE_PROTOCOLS = Object.freeze(
  CUSTOM_PROVIDER_CODEX_WIRE_PROTOCOLS.filter(
    (option) => option.value !== 'google-generative-ai',
  ),
);

/**
 * The generic settings control is shared by the four engines, but OMP has no
 * Google-native proxy front door.  Keep the UI in lockstep with Main's
 * persistence validator rather than letting a user save an unexecutable route.
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
