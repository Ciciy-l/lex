import { describe, expect, it } from 'vitest';
import { isOpenAiSubscriptionProvider } from '@cindy/model-providers';
import type { CodexModelListItem } from '@cindy/maker-core';
import { remoteCodexProvider } from '../ssh-codex-models.js';

function model(id: string, patch: Partial<CodexModelListItem> = {}): CodexModelListItem {
  return {
    id,
    model: id,
    displayName: id,
    description: '',
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'balanced' }],
    defaultReasoningEffort: 'medium',
    additionalSpeedTiers: [],
    serviceTiers: [],
    isDefault: false,
    ...patch,
  };
}

describe('SSH Codex host model projection', () => {
  it('projects only visible host models into the native OpenAI OAuth route and leads with the host default', () => {
    const provider = remoteCodexProvider([
      model('remote-default', { isDefault: true }),
      model('remote-hidden', { hidden: true }),
      model('remote-other'),
    ]);

    expect(provider).toMatchObject({
      id: 'openai',
      auth: { method: 'oauth', native: 'codex' },
      routing: { codex: { authStrategy: 'oauth-passthrough' } },
    });
    expect(isOpenAiSubscriptionProvider(provider)).toBe(true);
    expect(provider.models.codex?.map((item) => item.id)).toEqual(['remote-default', 'remote-other']);
    expect(provider.models.codex?.every((item) => item.defaultEnabled === true)).toBe(true);
    expect(provider.models.codex?.[0]?.defaultEffort).toBe('medium');
    expect(provider).not.toHaveProperty('credentials');
  });
});
