export type CodexImageGenerationRestartPolicy = 'interrupt';

import type { ProviderWireProtocol } from '@cindy/model-providers';

export type ProviderChannelKeys = Record<string, Partial<Record<ProviderWireProtocol, string>>>;

export interface CustomProviderUpdateOptions {
  /** Main-only mutation input. Never included in a provider view or persisted JSON. */
  channelKeys?: ProviderChannelKeys;
  source?: 'manual-settings';
  codexImageGenerationRestartPolicy?: CodexImageGenerationRestartPolicy;
}

export type CustomProviderUpdateResult =
  | { ok: true }
  | {
      ok: false;
      confirmationRequired: 'codex-image-generation-reload';
      busyCount: number;
    };
