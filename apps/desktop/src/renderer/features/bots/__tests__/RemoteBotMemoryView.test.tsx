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
const botB: RemoteBot = { ...bot, id: 'bot-b', name: 'Kira' };
const entryBId = 'settings:bot-a/memory/feedback_tone';
const listWithBoth = () => ({
  ...listResource,
  blocks: [{ ...listResource.blocks[0], data: { count: 2, entries: [
    ...listResource.blocks[0].data.entries,
    { id: 'feedback_tone', title: 'Tone', subtitle: 'Tone body', resourceId: entryBId },
  ] } }],
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

describe('RemoteBotMemoryView state guards', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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

  it('releases busy after delete navigation so the next memory can be saved', async () => {
    let deleted = false;
    let tone = detailResource('b1', 'Tone', 'Tone body');
    tone.ref.id = entryBId;
    const invoke = vi.fn(async (_device: string, channel: string, payload: unknown[]) => {
      const request = payload[0] as { ref?: { id?: string }; actionId?: string; input?: Record<string, unknown> };
      if (channel === REMOTE_RESOURCE_GET_CHANNEL) {
        if (request.ref?.id === baseId) return deleted ? { ...listWithBoth(), blocks: [{ ...listWithBoth().blocks[0], data: { count: 1, entries: [listWithBoth().blocks[0].data.entries[1]] } }] } : listWithBoth();
        if (request.ref?.id === entryBId) return tone;
        return detailResource('a1', 'Original', 'Body');
      }
      if (channel === REMOTE_RESOURCE_INVOKE_CHANNEL && request.actionId === 'memory-delete') { deleted = true; return { effects: [] }; }
      if (channel === REMOTE_RESOURCE_INVOKE_CHANNEL && request.actionId === 'memory-update') {
        tone = detailResource('b2', String(request.input?.title ?? 'Tone'), String(request.input?.body ?? 'Tone body'));
        tone.ref.id = entryBId;
      }
      return { effects: [] };
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { deviceLink: { invoke } } });
    render(<RemoteBotMemoryView bot={bot} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Original/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Original/ }));
    await waitFor(() => expect(screen.getByDisplayValue('Body')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'bots.memory.delete' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Tone/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Tone/ }));
    await waitFor(() => expect(screen.getByDisplayValue('Tone body')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('bots.memory.bodyLabel'), { target: { value: 'Tone mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'bots.save' }));
    await waitFor(() => expect(screen.getByDisplayValue('Tone mine')).toBeTruthy());
    expect(invoke).toHaveBeenCalledWith('device-a', REMOTE_RESOURCE_INVOKE_CHANNEL, [expect.objectContaining({
      actionId: 'memory-update', input: expect.objectContaining({ body: 'Tone mine' }),
    })]);
  });

  it('keeps a scoped draft when navigating away and reopening the same memory', async () => {
    const invoke = vi.fn(async (_device: string, channel: string, payload: unknown[]) => {
      const request = payload[0] as { ref?: { id?: string } };
      if (channel === REMOTE_RESOURCE_GET_CHANNEL) return request.ref?.id === baseId ? listResource : detailResource('r1', 'Original', 'Body');
      return { effects: [] };
    });
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { deviceLink: { invoke } } });
    render(<RemoteBotMemoryView bot={bot} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Original/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Original/ }));
    await waitFor(() => expect(screen.getByDisplayValue('Body')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('bots.memory.bodyLabel'), { target: { value: 'Unsaved body' } });
    fireEvent.click(screen.getByRole('button', { name: 'bots.settingsBack' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Original/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Original/ }));
    await waitFor(() => expect(screen.getByDisplayValue('Unsaved body')).toBeTruthy());
  });

  it.each(['resolve', 'reject'] as const)('ignores a late %s save response after opening another memory', async (outcome) => {
    const pending = deferred<ReturnType<typeof detailResource>>();
    let aGets = 0;
    const invoke = vi.fn(async (_device: string, channel: string, payload: unknown[]) => {
      const request = payload[0] as { ref?: { id?: string }; actionId?: string };
      if (channel === REMOTE_RESOURCE_GET_CHANNEL) {
        if (request.ref?.id === baseId) return listWithBoth();
        if (request.ref?.id === entryBId) return detailResource('b1', 'Tone', 'Tone body');
        aGets += 1;
        if (aGets === 2) return pending.promise;
        return detailResource('a1', 'Original', 'Body');
      }
      return { effects: [] };
    });
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { deviceLink: { invoke } } });
    render(<RemoteBotMemoryView bot={bot} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Original/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Original/ }));
    await waitFor(() => expect(screen.getByDisplayValue('Body')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('bots.memory.bodyLabel'), { target: { value: 'A mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'bots.save' }));
    fireEvent.click(screen.getByRole('button', { name: 'bots.settingsBack' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Tone/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Tone/ }));
    await waitFor(() => expect(screen.getByDisplayValue('Tone body')).toBeTruthy());
    if (outcome === 'resolve') pending.resolve(detailResource('a2', 'Original', 'A committed'));
    else pending.reject(new Error('late timeout'));
    await waitFor(() => expect(screen.getByDisplayValue('Tone body')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['resolve', 'reject'] as const)('ignores a late %s delete response after opening another memory', async (outcome) => {
    const pending = deferred<ReturnType<typeof detailResource>>();
    let aGets = 0;
    const invoke = vi.fn(async (_device: string, channel: string, payload: unknown[]) => {
      const request = payload[0] as { ref?: { id?: string }; actionId?: string };
      if (channel === REMOTE_RESOURCE_GET_CHANNEL) {
        if (request.ref?.id === baseId) return listWithBoth();
        if (request.ref?.id === entryBId) return detailResource('b1', 'Tone', 'Tone body');
        aGets += 1;
        if (aGets === 2) return pending.promise;
        return detailResource('a1', 'Original', 'Body');
      }
      return { effects: [] };
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { deviceLink: { invoke } } });
    render(<RemoteBotMemoryView bot={bot} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Original/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Original/ }));
    await waitFor(() => expect(screen.getByDisplayValue('Body')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'bots.memory.delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'bots.settingsBack' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Tone/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Tone/ }));
    await waitFor(() => expect(screen.getByDisplayValue('Tone body')).toBeTruthy());
    if (outcome === 'resolve') pending.resolve(detailResource('a2', 'Original', 'A late delete'));
    else pending.reject(new Error('late delete timeout'));
    await waitFor(() => expect(screen.getByDisplayValue('Tone body')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not let a late old-bot response overwrite the newly selected bot', async () => {
    const pending = deferred<ReturnType<typeof detailResource>>();
    let aGets = 0;
    const invoke = vi.fn(async (_device: string, channel: string, payload: unknown[]) => {
      const request = payload[0] as { ref?: { id?: string } };
      if (channel === REMOTE_RESOURCE_GET_CHANNEL) {
        if (request.ref?.id === 'settings:bot-b/memory') return { ...listResource, ref: { ...listResource.ref, id: 'settings:bot-b/memory' }, blocks: [] };
        if (request.ref?.id === baseId) return listResource;
        aGets += 1;
        if (aGets === 2) return pending.promise;
        return detailResource('a1', 'Original', 'Body');
      }
      return { effects: [] };
    });
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { deviceLink: { invoke } } });
    const view = render(<RemoteBotMemoryView bot={bot} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Original/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Original/ }));
    await waitFor(() => expect(screen.getByDisplayValue('Body')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('bots.memory.bodyLabel'), { target: { value: 'A mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'bots.save' }));
    view.rerender(<RemoteBotMemoryView bot={botB} />);
    await waitFor(() => expect(screen.queryByDisplayValue('Body')).toBeNull());
    pending.resolve(detailResource('a2', 'Original', 'A committed'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.queryByDisplayValue('A committed')).toBeNull();
  });
});
