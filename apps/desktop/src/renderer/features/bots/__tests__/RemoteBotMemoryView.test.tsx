// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_RESOURCE_GET_CHANNEL, REMOTE_RESOURCE_INVOKE_CHANNEL } from '@cindy/device-link';
import { RemoteBotMemoryView } from '../RemoteBotMemoryView';
import type { RemoteBot } from '../remoteBotRoster';

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

const bot: RemoteBot = {
  id: 'bot-a', deviceId: 'device-a', deviceName: 'Desktop', name: 'Sora', avatar: '', avatarColor: 'teal',
  description: '', preview: '', activityAt: 0, sessionId: null, online: true,
};
const baseId = 'settings:bot-a/memory';
const entryId = 'settings:bot-a/memory/feedback_style';
const listResource = {
  ref: { collectionId: 'teammates', kind: 'bot', id: baseId }, revision: 'list-1',
  display: { title: 'Saved Memories' }, links: [], blocks: [{
    id: 'memory-feedback', primitive: 'list', fallbackMarkdown: '- Original', title: 'Your preferences',
    data: { count: 1, entries: [{ id: 'feedback_style', title: 'Original', subtitle: 'Body', resourceId: entryId }] },
  }],
};
const detailResource = (revision: string, title: string, body: string) => ({
  ref: { collectionId: 'teammates', kind: 'bot', id: entryId }, revision,
  display: { title }, links: [], blocks: [{
    id: 'entry', primitive: 'form', fallbackMarkdown: body,
    data: { values: { title, body, expectedUpdatedAt: revision } },
  }],
});

describe('RemoteBotMemoryView state guards', () => {
  afterEach(cleanup);

  it('keeps edits while adopting the latest CAS baseline, then saves against it', async () => {
    const invoke = vi.fn();
    let current = detailResource('r1', 'Original', 'Body');
    invoke.mockImplementation(async (_device: string, channel: string, payload: unknown[]) => {
      const request = payload[0] as { ref?: { id?: string }; actionId?: string; input?: Record<string, unknown> };
      if (channel === REMOTE_RESOURCE_GET_CHANNEL) {
        return request.ref?.id === baseId ? listResource : current;
      }
      if (channel === REMOTE_RESOURCE_INVOKE_CHANNEL && request.actionId === 'memory-update') {
        current = detailResource('r3', String(request.input?.title), String(request.input?.body));
      }
      return { effects: [] };
    });
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { deviceLink: { invoke } } });
    render(<RemoteBotMemoryView bot={bot} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Original/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Original/ }));
    await waitFor(() => expect(screen.getByDisplayValue('Body')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('bots.memory.bodyLabel'), { target: { value: 'Mine body' } });
    current = detailResource('r2', 'Host', 'Host body');
    fireEvent.click(screen.getByRole('button', { name: 'bots.save' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'bots.memory.keepMine' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'bots.memory.keepMine' }));
    fireEvent.click(screen.getByRole('button', { name: 'bots.save' }));
    await waitFor(() => expect(screen.getByDisplayValue('Mine body')).toBeTruthy());
    expect(invoke).toHaveBeenCalledWith('device-a', REMOTE_RESOURCE_INVOKE_CHANNEL, [expect.objectContaining({
      actionId: 'memory-update', input: expect.objectContaining({ expectedUpdatedAt: 'r2', body: 'Mine body' }),
    })]);
  });
});
