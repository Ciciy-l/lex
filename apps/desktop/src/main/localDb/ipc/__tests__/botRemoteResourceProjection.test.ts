import { describe, expect, it } from 'vitest';

import {
  botRemoteCollectionItemFromSource,
  visibleBotRemoteResourceSources,
} from '../botRemoteResourceProjection.js';

const source = {
  id: 'bot-1',
  name: 'Sora',
  description: 'Product designer',
  avatar: 'cindy://avatar/preset/whitecat',
  avatarColor: 'teal',
  status: 'active',
  canonicalSessionId: 'session-1',
  lastMessagePreview: 'The mobile flow is ready.',
  lastMessageAt: 1_725_000_000_000,
  lastMessageRole: 'assistant' as const,
  needsAttention: false,
  hiddenAt: null,
  pinnedAt: null,
  activityAt: 1_725_000_000_100,
  currentVersion: 3,
  updatedAt: 1_725_000_000_100,
};

describe('bot remote resource projection', () => {
  it('projects user-facing primitives and a standard session link', () => {
    expect(botRemoteCollectionItemFromSource(source)).toMatchObject({
      ref: { collectionId: 'teammates', kind: 'bot', id: 'bot-1' },
      display: {
        title: 'Sora',
        subtitle: 'Product designer',
        preview: 'The mobile flow is ready.',
        timestamp: 1_725_000_000_100,
        avatar: {
          kind: 'asset',
          value: 'cindy://avatar/preset/whitecat',
          fallbackText: 'S',
        },
        status: { tone: 'positive' },
      },
    });
    expect(botRemoteCollectionItemFromSource(source).links).toEqual(expect.arrayContaining([
      {
        rel: 'conversation',
        target: { kind: 'session', sessionId: 'session-1' },
      },
      {
        label: expect.objectContaining({ fallback: 'Saved Memories' }),
        rel: 'memories',
        target: {
          kind: 'resource',
          ref: { collectionId: 'teammates', kind: 'bot', id: 'settings:bot-1/memory' },
        },
      },
      {
        label: expect.objectContaining({ fallback: 'Settings' }),
        rel: 'settings',
        target: {
          kind: 'resource',
          ref: { collectionId: 'teammates', kind: 'bot', id: 'settings:bot-1' },
        },
      },
    ]));
  });

  it('uses generic attention presentation without exposing Bot internals', () => {
    const projected = botRemoteCollectionItemFromSource({
      ...source,
      needsAttention: true,
    });
    expect(projected.display.status).toMatchObject({ tone: 'warning' });
    expect(projected.display.badges).toHaveLength(1);
    expect(projected).not.toHaveProperty('identitySource');
    expect(projected).not.toHaveProperty('capabilities');
    expect(projected).not.toHaveProperty('homeDir');
    expect(projected).not.toHaveProperty('lastMessageRole');
  });

  it('keeps a resource discoverable while its replaceable canonical task is absent', () => {
    expect(botRemoteCollectionItemFromSource({
      ...source,
      canonicalSessionId: undefined,
    }).links).toEqual([{
      label: {
        fallback: 'Saved Memories',
        translations: {
          'zh-CN': '已存记忆',
          'zh-TW': '已存記憶',
          ja: '保存した記憶',
          ko: '저장된 기억',
        },
      },
      rel: 'memories',
      target: {
        kind: 'resource',
        ref: { collectionId: 'teammates', kind: 'bot', id: 'settings:bot-1/memory' },
      },
    }, {
      label: {
        fallback: 'Settings',
        translations: {
          'zh-CN': '设置',
          'zh-TW': '設定',
          ja: '設定',
          ko: '설정',
        },
      },
      rel: 'settings',
      target: {
        kind: 'resource',
        ref: { collectionId: 'teammates', kind: 'bot', id: 'settings:bot-1' },
      },
    }]);
  });

  it('keeps managed artwork portable without rendering its address as emoji text', () => {
    const avatar = `cindy-media://blobs/${'a'.repeat(64)}.png`;
    expect(botRemoteCollectionItemFromSource({ ...source, avatar }).display.avatar).toMatchObject({
      kind: 'media',
      value: avatar,
      fallbackText: 'S',
    });
  });

  it('hides desktop-hidden rows and keeps pinned/provider activity order', () => {
    const ordered = visibleBotRemoteResourceSources([
      { ...source, id: 'recent', activityAt: 90 },
      { ...source, id: 'hidden', hiddenAt: 1, activityAt: 100 },
      { ...source, id: 'pinned-old', pinnedAt: 1, activityAt: 10 },
      { ...source, id: 'old', activityAt: 20 },
    ]);

    expect(ordered.map((item) => item.id)).toEqual(['pinned-old', 'recent', 'old']);
  });
});
