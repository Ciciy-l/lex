// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomProviderConfig } from '@cindy/model-providers';

const calls = vi.hoisted(() => ({ update: vi.fn(), create: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ serviceRealm: 'global' }) }));
vi.mock('@/lib/customProviders', () => ({
  updateCustomProvider: calls.update,
  createCustomProvider: calls.create,
  appendDiscoveredCustomProviderModels: vi.fn(),
}));
import { ProviderChannelsDialog } from '@/components/settings/ProviderChannelsDialog';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

const config: CustomProviderConfig = {
  id: 'supplier', name: 'Supplier', runtimes: {}, readRevision: 7,
  channels: { version: 1, channels: [{
    id: 'primary', name: 'Primary', protocols: {
      'openai-responses': { baseUrl: 'https://provider.example/v1', models: [{ id: 'm', name: 'M' }] },
    },
  }] },
};
beforeEach(() => {
  calls.update.mockReset();
  calls.create.mockReset();
  setDataOwnerGeneration('owner-a', 1);
  window.electronAPI = { maker: { listProviderPresets: vi.fn(async () => ({ presets: [] })) } } as unknown as typeof window.electronAPI;
});
afterEach(cleanup);
function mount(onSpecializedSetup?: () => void) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(<ProviderChannelsDialog initial={config} onSaved={onSaved} onClose={onClose}
    onSpecializedSetup={onSpecializedSetup} />);
  return { onSaved, onClose };
}
function escape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}
describe('protocol-channel form requests', () => {
  it('keeps an idle draft open on outside clicks while allowing explicit cancellation', async () => {
    const { onClose, onSaved } = mount();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByDisplayValue('Supplier')));
    fireEvent.pointerDown(document.body, { button: 0, pointerType: 'mouse' });
    fireEvent.click(document.body);
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(calls.update).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('Supplier')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('focuses the supplier field and prevents duplicate saves and dismissal until settlement', async () => {
    let reject!: (error: Error) => void;
    calls.update.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const { onSaved, onClose } = mount();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByDisplayValue('Supplier')));
    const save = screen.getByRole('button', { name: 'common.save' });
    act(() => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      escape();
    });
    expect(calls.update).toHaveBeenCalledOnce();
    expect(calls.update.mock.calls[0][0]).toMatchObject({ readRevision: 7, channels: config.channels });
    expect(calls.update.mock.calls[0][2]).toEqual({ source: 'manual-settings', channelKeys: {} });
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.cancel' }));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { reject(new Error('Save failed; retry')); });
    expect(screen.getByRole('alert').textContent).toBe('models.channels.requestFailed');
    expect((save as HTMLButtonElement).disabled).toBe(false);
    calls.update.mockResolvedValueOnce({ ok: true });
    await act(async () => { fireEvent.click(save); });
    expect(calls.update).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenCalledOnce();
  });
  it('allows Escape in an idle form and ignores a save receipt from an old owner', async () => {
    let resolve!: (result: { ok: true }) => void;
    calls.update.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const { onClose, onSaved } = mount();
    act(escape);
    expect(onClose).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    setDataOwnerGeneration('owner-b', 2);
    await act(async () => { resolve({ ok: true }); });
    expect(onSaved).not.toHaveBeenCalled();
    expect(calls.update).toHaveBeenCalledOnce();
  });
  it('blocks specialized setup during a pending save and permits it after a failure', async () => {
    let reject!: (error: Error) => void;
    calls.update.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const onSpecializedSetup = vi.fn();
    const { onSaved, onClose } = mount(onSpecializedSetup);
    const entry = screen.getByRole('button', { name: 'models.channels.specializedSetup' });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
      fireEvent.click(entry);
    });
    expect(calls.update).toHaveBeenCalledOnce();
    expect((entry as HTMLButtonElement).disabled).toBe(true);
    expect(onSpecializedSetup).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    await act(async () => { reject(new Error('Save failed; retry')); });
    expect((entry as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(entry);
    expect(onSpecializedSetup).toHaveBeenCalledOnce();
    expect(calls.update).toHaveBeenCalledOnce();
  });
});
