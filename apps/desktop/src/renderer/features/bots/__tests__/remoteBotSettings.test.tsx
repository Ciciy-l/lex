// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  confirm: vi.fn(async () => true),
  currentOwner: { dataOwnerId: 'owner-a', generation: 1 },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: h.confirm }),
}));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => h.currentOwner,
  isDataOwnerGenerationCurrent: (captured: typeof h.currentOwner) => captured === h.currentOwner,
}));
vi.mock('@/lib/remoteDataOwnerPushFence', () => ({
  isDeviceLinkRemotePushCurrent: () => true,
}));
vi.mock('../BotModelChainEditor', () => ({ BotModelChainEditor: () => null }));
vi.mock('../BotPortraitPicker', () => ({ BotPortraitPicker: () => null }));

import { RemoteBotSettings } from '../RemoteBotSettings';

const getChannel = 'maker:remote-resources:get';
const invokeChannel = 'maker:remote-resources:invoke';
const bot = (id = 'bot-a') => ({
  id,
  deviceId: 'desktop-a',
  deviceName: 'Desktop A',
  name: id === 'bot-a' ? 'Cindy' : 'Other',
  avatar: '',
  avatarColor: 'teal',
  description: '',
  preview: '',
  activityAt: 0,
  sessionId: `session-${id}`,
  online: true,
});

function resource(revision = '1', id = 'bot-a') {
  return {
    ref: { collectionId: 'teammates', kind: 'bot', id },
    revision,
    display: { title: id === 'bot-a' ? 'Cindy' : 'Other' },
    links: [],
    actions: [
      { id: 'profile', label: 'Profile', fields: [
        { id: 'name', label: 'Name', kind: 'text', required: true },
      ] },
      {
        id: 'delete',
        label: 'Delete',
        tone: 'destructive',
        confirmation: { title: 'Delete teammate', confirmLabel: 'Delete' },
      },
    ],
    blocks: [
      { id: 'profile', primitive: 'form', fallbackMarkdown: '', data: { actionId: 'profile', values: { name: id === 'bot-a' ? 'Cindy' : 'Other' } } },
      { id: 'delete', primitive: 'action', fallbackMarkdown: '', data: { actionId: 'delete', values: {} } },
    ],
  };
}

function renderSettings(id = 'bot-a') {
  const beforeCloseRef: { current: (() => Promise<boolean>) | null } = { current: null };
  const onDeleted = vi.fn();
  const rendered = render(
    <RemoteBotSettings bot={bot(id)} beforeCloseRef={beforeCloseRef} onDeleted={onDeleted} />,
  );
  return { ...rendered, beforeCloseRef, onDeleted };
}

beforeEach(() => {
  h.currentOwner = { dataOwnerId: 'owner-a', generation: 1 };
  h.confirm.mockReset().mockResolvedValue(true);
  h.invoke.mockReset();
  h.invoke.mockImplementation(async (_device: string, channel: string) => {
    if (channel === getChannel) return resource();
    return { effects: [{ kind: 'toast', message: 'Saved' }] };
  });
  window.electronAPI = {
    deviceLink: {
      invoke: h.invoke,
      onRemotePush: vi.fn(() => vi.fn()),
    },
  } as unknown as Window['electronAPI'];
});

afterEach(cleanup);

describe('RemoteBotSettings renderer request boundary', () => {
  it('keeps the edited draft when the host revision changes before save', async () => {
    let reads = 0;
    h.invoke.mockImplementation(async (_device: string, channel: string) => {
      if (channel === getChannel) return resource(reads++ === 0 ? '1' : '2');
      return { effects: [] };
    });
    renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Profile' }));
    const name = await screen.findByRole('textbox', { name: 'Name' });
    fireEvent.change(name, { target: { value: 'My draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'bots.save' }));
    expect((await screen.findByRole('alert')).textContent).toContain('bots.remoteSettings.conflict');
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('My draft');
    expect(h.invoke.mock.calls.filter((call) => call[1] === invokeChannel)).toHaveLength(0);
  });

  it('keeps the draft when navigating back would encounter a newer host revision', async () => {
    let reads = 0;
    h.invoke.mockImplementation(async (_device: string, channel: string) => {
      if (channel === getChannel) return resource(reads++ === 0 ? '1' : '2');
      return { effects: [] };
    });
    renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Profile' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), { target: { value: 'Unsaved draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'bots.settingsBack' }));
    expect((await screen.findByRole('alert')).textContent).toContain('bots.remoteSettings.conflict');
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Unsaved draft');
  });

  it('does not invoke a confirmed delete after leaving for another Bot while the dialog is open', async () => {
    let resolveConfirm!: (value: boolean) => void;
    h.confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveConfirm = resolve; }));
    const view = renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(h.confirm).toHaveBeenCalled());
    await act(async () => {
      view.rerender(
        <RemoteBotSettings bot={bot('bot-b')} beforeCloseRef={view.beforeCloseRef} onDeleted={view.onDeleted} />,
      );
    });
    resolveConfirm(true);
    await act(async () => { await Promise.resolve(); });
    expect(h.invoke.mock.calls.filter((call) => call[1] === invokeChannel)).toHaveLength(0);
    expect(view.onDeleted).not.toHaveBeenCalled();
  });

  it('only leaves the page after a real delete acknowledgement', async () => {
    const { onDeleted } = renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(h.invoke.mock.calls.some((call) => call[1] === invokeChannel)).toBe(true));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it('keeps a hidden or unavailable delete failure visible instead of treating it as success', async () => {
    const { onDeleted } = renderSettings();
    h.invoke.mockImplementation(async (_device: string, channel: string) => {
      if (channel === getChannel) return resource();
      throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect((await screen.findByRole('alert')).textContent).toContain('bots.remoteSettings.saveFailed');
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
