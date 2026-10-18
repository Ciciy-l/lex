// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
function mount(onHarnessSetup?: () => void) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(<ProviderChannelsDialog initial={config} onSaved={onSaved} onClose={onClose}
    onHarnessSetup={onHarnessSetup} />);
  return { onSaved, onClose };
}
function escape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}
describe('protocol-channel form requests', () => {
  it('retains channel drafts, tests only the current route and navigates to invalid headers on save', async () => {
    const initial = structuredClone(config);
    initial.channels!.channels.push({ id: 'backup', name: 'Backup', protocols: {
      'openai-responses': { baseUrl: 'https://backup.example/v1', models: [{ id: 'm', name: 'M' }] },
    } });
    const test = vi.fn().mockResolvedValue({ ok: true });
    window.electronAPI.maker.testProviderConnection = test;
    render(<ProviderChannelsDialog initial={initial} onSaved={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('models.channels.advanced'));
    fireEvent.change(screen.getByLabelText('models.channels.headers'), { target: { value: '{invalid' } });
    fireEvent.change(screen.getByLabelText('models.channels.modelIds'), { target: { value: 'm\nsecond' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'models.channels.chooseChannel' }));
    fireEvent.click(screen.getByRole('option', { name: 'Backup' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'models.channels.test' })); });
    expect(test).toHaveBeenCalledExactlyOnceWith({ kind: 'saved', providerId: 'backup--openai-responses', agent: 'pi' });
    expect(screen.getByRole('status').textContent).toBe('models.channels.connected');
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'fake-test-key' } });
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
    expect(calls.update).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('models.channels.invalidHeaders');
    expect((screen.getByLabelText('models.channels.modelIds') as HTMLTextAreaElement).value).toBe('m\nsecond');
    expect((screen.getByLabelText('models.channels.headers') as HTMLTextAreaElement).value).toBe('{invalid');
  });
  it('guards unsaved close, preserves the draft on cancellation and keeps footer outside scrolling content', async () => {
    const { onClose } = mount();
    fireEvent.change(screen.getByLabelText('models.channels.supplierName'), { target: { value: 'Edited' } });
    act(escape);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'models.channels.keepEditing' }));
    expect(screen.getByDisplayValue('Edited')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'settings.providers.custom.save' }).closest('footer')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'models.channels.discard' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('warns only after changing a saved endpoint and reports safe actionable connection errors', async () => {
    window.electronAPI.maker.testProviderConnection = vi.fn().mockResolvedValue({ ok: false, code: 'AUTH_INVALID', detail: 'private upstream secret' });
    mount();
    expect(screen.queryByText('models.channels.endpointChanged')).toBeNull();
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://new.example/v1' } });
    expect(screen.getByText('models.channels.endpointChanged')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'models.channels.test' })); });
    expect(screen.getByRole('alert').textContent).toBe('providerError.AUTH_INVALID');
    expect(screen.queryByText('private upstream secret')).toBeNull();
    expect(window.electronAPI.maker.testProviderConnection).toHaveBeenCalledWith(expect.objectContaining({ kind: 'adhoc' }));
  });
  it('asks before discarding an edited draft on outside clicks', async () => {
    const { onClose, onSaved } = mount();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByDisplayValue('Supplier')));
    fireEvent.change(screen.getByDisplayValue('Supplier'), { target: { value: 'Edited supplier' } });
    fireEvent.pointerDown(document.body, { button: 0, pointerType: 'mouse' });
    fireEvent.click(document.body);
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(calls.update).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByDisplayValue('Edited supplier')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'models.channels.keepEditing' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'models.channels.discard' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('focuses the supplier field and prevents duplicate saves and dismissal until settlement', async () => {
    let reject!: (error: Error) => void;
    calls.update.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const { onSaved, onClose } = mount();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByDisplayValue('Supplier')));
    const save = screen.getByRole('button', { name: 'settings.providers.custom.save' });
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
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
    setDataOwnerGeneration('owner-b', 2);
    await act(async () => { resolve({ ok: true }); });
    expect(onSaved).not.toHaveBeenCalled();
    expect(calls.update).toHaveBeenCalledOnce();
  });
  it('blocks specialized setup during a pending save and permits it after a failure', async () => {
    let reject!: (error: Error) => void;
    calls.update.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const onHarnessSetup = vi.fn();
    const { onSaved, onClose } = mount(onHarnessSetup);
    const entry = screen.getByRole('tab', { name: 'models.channels.byHarness' });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
      fireEvent.click(entry);
    });
    expect(calls.update).toHaveBeenCalledOnce();
    expect((entry as HTMLButtonElement).disabled).toBe(true);
    expect(onHarnessSetup).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    await act(async () => { reject(new Error('Save failed; retry')); });
    expect((entry as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(entry);
    expect(onHarnessSetup).toHaveBeenCalledOnce();
    expect(calls.update).toHaveBeenCalledOnce();
  });
});
