import type { CodexModelListItem } from '@cindy/maker-core';
import type { ProviderView } from '@cindy/model-providers';
import { mapCodexAppServerModelsToCatalog } from './codex-model-discovery.js';

export function remoteCodexProvider(models: readonly CodexModelListItem[]): ProviderView {
  const defaultModel = models.find((model) => model.isDefault && !model.hidden)?.model;
  const mapped = mapCodexAppServerModelsToCatalog(models).map((model) => ({
    ...model,
    defaultEnabled: true,
  }));
  mapped.sort((left, right) => Number(right.id === defaultModel) - Number(left.id === defaultModel));
  mapped.forEach((model, index) => { model.sortOrder = index; });

  return {
    id: 'openai',
    name: 'OpenAI Codex',
    source: 'builtin',
    connected: true,
    agents: ['codex'],
    auth: { method: 'oauth', native: 'codex' },
    routing: {
      codex: {
        upstream: 'https://chatgpt.com/backend-api/codex',
        authStrategy: 'oauth-passthrough',
      },
    },
    models: { codex: mapped },
  };
}
