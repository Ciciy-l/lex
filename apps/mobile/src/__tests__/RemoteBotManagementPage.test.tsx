// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  invoke: vi.fn(),
  alertButtons: null as Array<{ onPress?: () => void }> | null,
}));

vi.mock('react-native', () => ({
  Alert: {
    alert: (_title: unknown, _body: unknown, buttons: Array<{ onPress?: () => void }> = []) => { h.alertButtons = buttons; },
  },
  ActivityIndicator: () => createElement('span', { 'data-testid': 'loading' }),
  Pressable: ({ children, onPress, disabled }: any) => createElement('button', { onClick: onPress, disabled }, children),
  ScrollView: ({ children }: any) => createElement('div', {}, children),
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  Switch: ({ value, onValueChange, disabled }: any) => createElement('input', { type: 'checkbox', checked: value, disabled, onChange: (event: any) => onValueChange(event.currentTarget.checked) }),
  View: ({ children }: any) => createElement('div', {}, children),
}));
vi.mock('@/components/AppText', () => ({
  Text: ({ children, ...props }: any) => createElement('span', props, children),
  TextInput: ({ value, onChangeText, style: _style, editable: _editable, multiline: _multiline, placeholderTextColor: _placeholderTextColor, ...props }: any) => createElement('input', { ...props, value, onChange: (event: any) => onChangeText(event.currentTarget.value) }),
}));
vi.mock('@/components/MobilePrimitives', () => ({
  MainWindowActionButton: ({ action }: any) => createElement('button', { onClick: action.onPress, disabled: action.disabled }, action.label),
}));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: h.invoke }) }));
vi.mock('@/device-link/remoteResources', () => ({
  getRemoteResource: (...args: any[]) => h.get(...args),
  invokeRemoteResourceAction: (...args: any[]) => h.invoke(...args),
}));
vi.mock('@/device-link/remoteStatus', () => ({ formatRemoteError: (error: unknown) => String(error) }));
vi.mock('@/platform/chrome', () => ({
  SimpleStackHeader: ({ onBack, title }: any) => createElement('button', { 'data-testid': 'back', onClick: onBack }, title),
  simpleScreenSafeAreaEdges: [],
}));
vi.mock('@/utils/backGuard', () => ({ goBackGuarded: vi.fn() }));
vi.mock('expo-router', () => ({ useRouter: () => ({}) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/theme', () => ({
  useTheme: () => ({ colors: { textSecondary: '', textTertiary: '', textPrimary: '', surface: '', surfaceElevated: '', border: '', borderStrong: '', surfaceChip: '', errorText: '' } }),
  useThemedStyles: () => ({ safeArea: {}, content: {}, group: {}, form: {}, groupTitle: {}, row: {}, rowTitle: {}, chevron: {}, field: {}, label: {}, input: {}, multiline: {}, toggleRow: {}, selectRow: {}, options: {}, option: {}, optionSelected: {}, optionText: {}, markdown: {}, note: {}, error: {} }),
}));
vi.mock('@/theme/tokens', () => ({ fontWeight: { medium: '500' }, radius: { container: 1, control: 1, pill: 1 }, spacing: { lg: 1, md: 1, sm: 1, xs: 1 }, typeScale: { body: 1, footnote: 1, title: 1 } }));

import { RemoteBotManagementPage } from '@/session/RemoteBotManagementPage';

const hostA = { deviceId: 'desktop-a', deviceName: 'A' };
const hostB = { deviceId: 'desktop-b', deviceName: 'B' };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const resource = (id: string, name: string, includeChild = false) => ({
  ref: { collectionId: 'teammates', kind: 'bot', id },
  revision: name,
  display: { title: name },
  links: [],
  blocks: [
    ...(includeChild ? [{ id: 'children', primitive: 'list', fallbackMarkdown: '', data: { entries: [{ id: 'child', title: 'Child', resourceId: 'child' }] } }] : []),
    { id: 'profile', primitive: 'form', fallbackMarkdown: '', data: { actionId: 'save', values: { name } } },
  ],
  actions: [{ id: 'save', label: 'Save', fields: [{ id: 'name', label: 'Name', kind: 'text' }] }],
});

let root: Root;
let node: HTMLDivElement;
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  node = document.createElement('div');
  document.body.append(node);
  root = createRoot(node);
  h.get.mockReset();
  h.invoke.mockReset().mockResolvedValue({ effects: [] });
  h.alertButtons = null;
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
});

describe('RemoteBotManagementPage request boundary', () => {
  it('ignores a late resource response after switching hosts', async () => {
    const first = deferred<any>();
    const oldChild = deferred<any>();
    const nextHost = deferred<any>();
    h.get.mockReturnValueOnce(first.promise).mockReturnValueOnce(oldChild.promise).mockReturnValueOnce(nextHost.promise);
    await act(async () => root.render(createElement(RemoteBotManagementPage, { host: hostA, resourceId: 'bot-a' })));
    first.resolve(resource('bot-a', 'A', true));
    await flush();
    const child = [...node.querySelectorAll('button')].find((button) => button.textContent?.includes('Child'));
    expect(child).toBeTruthy();
    await act(async () => (child as HTMLButtonElement).click());
    await act(async () => root.render(createElement(RemoteBotManagementPage, { host: hostB, resourceId: 'bot-b' })));
    nextHost.resolve(resource('bot-b', 'B'));
    await flush();
    oldChild.resolve(resource('child', 'OLD CHILD'));
    await flush();
    expect(node.textContent).toContain('B');
    expect(node.textContent).not.toContain('OLD CHILD');
  });

  it('keeps a draft when navigating away and returning to the same host/resource', async () => {
    const base = deferred<any>();
    const child = deferred<any>();
    const returned = deferred<any>();
    h.get.mockReturnValueOnce(base.promise).mockReturnValueOnce(child.promise).mockReturnValueOnce(returned.promise);
    await act(async () => root.render(createElement(RemoteBotManagementPage, { host: hostA, resourceId: 'bot-a' })));
    base.resolve(resource('bot-a', 'Original', true));
    await flush();
    const input = node.querySelector('input:not([type="checkbox"])') as HTMLInputElement;
    expect(input).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'Local draft');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const open = [...node.querySelectorAll('button')].find((button) => button.textContent?.includes('Child'));
    await act(async () => (open as HTMLButtonElement).click());
    child.resolve(resource('child', 'Child'));
    await flush();
    await act(async () => (node.querySelector('[data-testid="back"]') as HTMLButtonElement).click());
    returned.resolve(resource('bot-a', 'Original', true));
    await flush();
    expect((node.querySelector('input:not([type="checkbox"])') as HTMLInputElement).value).toBe('Local draft');
  });

  it('keeps one create requestId across an ACK-loss retry', async () => {
    const firstGrant = 'create-grant-a';
    const refreshedGrant = 'create-grant-b';
    const createResource = {
      ref: { collectionId: 'teammates', kind: 'bot', id: 'create' },
      revision: '1',
      display: { title: 'Create' },
      links: [],
      blocks: [{ id: 'create', primitive: 'form', fallbackMarkdown: '', data: { actionId: firstGrant, operationActions: { create: firstGrant }, values: { name: 'New Bot', avatarImageBase64: 'image' } } }],
      actions: [{ id: firstGrant, label: 'Create', fields: [
        { id: 'name', label: 'Name', kind: 'text' },
        { id: 'avatarImageBase64', label: 'Avatar', kind: 'text' },
      ] }],
    };
    const refreshedResource = {
      ...createResource,
      blocks: [{ ...createResource.blocks[0], data: { ...createResource.blocks[0].data, actionId: refreshedGrant, operationActions: { create: refreshedGrant } } }],
      actions: [{ ...createResource.actions[0], id: refreshedGrant }],
      revision: '2',
    };
    h.get.mockResolvedValueOnce(createResource).mockResolvedValueOnce(refreshedResource);
    const firstAttempt = deferred<any>();
    h.invoke.mockReset().mockReturnValueOnce(firstAttempt.promise).mockResolvedValue({ effects: [] });
    await act(async () => root.render(createElement(RemoteBotManagementPage, { host: hostA, resourceId: 'create' })));
    await flush();
    const create = [...node.querySelectorAll('button')].find((button) => button.textContent === 'Create' && !button.dataset.testid);
    expect(create).toBeTruthy();
    await act(async () => (create as HTMLButtonElement).click());
    await flush();
    const firstInput = h.invoke.mock.calls[0]?.[2]?.input;
    expect(h.invoke.mock.calls[0]?.[2]?.actionId).toBe(firstGrant);
    expect(firstInput.requestId).toMatch(/^[A-Za-z0-9_-]{16,80}$/);
    firstAttempt.reject(new Error('ACK lost'));
    await flush();
    await act(async () => root.render(createElement(RemoteBotManagementPage, { host: { ...hostA, deviceName: 'A refreshed' }, resourceId: 'create' })));
    await flush();
    const refreshedCreate = [...node.querySelectorAll('button')].find((button) => button.textContent === 'Create' && !button.dataset.testid);
    expect(refreshedCreate).toBeTruthy();
    await act(async () => (refreshedCreate as HTMLButtonElement).click());
    await flush();
    const secondInput = h.invoke.mock.calls[1]?.[2]?.input;
    expect(h.invoke.mock.calls[1]?.[2]?.actionId).toBe(refreshedGrant);
    expect(secondInput.requestId).toBe(firstInput.requestId);
  });

  it('ignores a late action response after switching to another host', async () => {
    const action = deferred<any>();
    h.get.mockResolvedValueOnce(resource('bot-a', 'A')).mockResolvedValueOnce(resource('bot-b', 'B'));
    h.invoke.mockReturnValueOnce(action.promise);
    await act(async () => root.render(createElement(RemoteBotManagementPage, { host: hostA, resourceId: 'bot-a' })));
    await flush();
    const save = [...node.querySelectorAll('button')].find((button) => button.textContent === 'Save');
    expect(save).toBeTruthy();
    await act(async () => (save as HTMLButtonElement).click());
    await act(async () => root.render(createElement(RemoteBotManagementPage, { host: hostB, resourceId: 'bot-b' })));
    await flush();
    action.resolve({ effects: [{ kind: 'toast', message: 'old host' }] });
    await flush();
    expect(node.textContent).toContain('B');
    expect(node.textContent).not.toContain('old host');
  });

  it('does not invoke a captured confirmation after switching host or resource', async () => {
    const confirmationResource = {
      ...resource('bot-a', 'A'),
      blocks: [{ id: 'delete', primitive: 'action', fallbackMarkdown: '', data: { actionId: 'delete-grant' } }],
      actions: [{ id: 'delete-grant', label: 'Delete', tone: 'destructive', confirmation: { title: 'Delete', body: 'Confirm' } }],
    };
    h.get.mockResolvedValueOnce(confirmationResource).mockResolvedValueOnce(resource('bot-b', 'B'));
    await act(async () => root.render(createElement(RemoteBotManagementPage, { host: hostA, resourceId: 'bot-a' })));
    await flush();
    const deleteButton = [...node.querySelectorAll('button')].find((button) => button.textContent === 'Delete');
    expect(deleteButton).toBeTruthy();
    await act(async () => (deleteButton as HTMLButtonElement).click());
    expect(h.alertButtons).toHaveLength(2);
    await act(async () => root.render(createElement(RemoteBotManagementPage, { host: hostB, resourceId: 'bot-b' })));
    await flush();
    await act(async () => h.alertButtons?.at(-1)?.onPress?.());
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('invalidates a pending confirmation on return and ignores duplicate taps', async () => {
    const confirmationResource = {
      ...resource('bot-a', 'A'),
      blocks: [{ id: 'delete', primitive: 'action', fallbackMarkdown: '', data: { actionId: 'delete-grant' } }],
      actions: [{ id: 'delete-grant', label: 'Delete', tone: 'destructive', confirmation: { title: 'Delete', body: 'Confirm' } }],
    };
    const onBack = vi.fn();
    h.get.mockResolvedValue(confirmationResource);
    await act(async () => root.render(createElement(RemoteBotManagementPage, { host: hostA, resourceId: 'bot-a', onBack })));
    await flush();
    const deleteButton = [...node.querySelectorAll('button')].find((button) => button.textContent === 'Delete');
    expect(deleteButton).toBeTruthy();
    await act(async () => {
      (deleteButton as HTMLButtonElement).click();
      (deleteButton as HTMLButtonElement).click();
    });
    expect(h.alertButtons).toHaveLength(2);
    await act(async () => (node.querySelector('[data-testid="back"]') as HTMLButtonElement).click());
    expect(onBack).toHaveBeenCalledTimes(1);
    await act(async () => h.alertButtons?.at(-1)?.onPress?.());
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('shows an old host capability as an unsupported resource instead of a fake action', async () => {
    h.get.mockResolvedValue({
      ...resource('bot-a', 'A'),
      blocks: [{ id: 'unsupported', primitive: 'action', fallbackMarkdown: 'Unsupported host', data: { actionId: 'save' } }],
      actions: [],
    });
    await act(async () => root.render(createElement(RemoteBotManagementPage, { host: hostA, resourceId: 'bot-a' })));
    await flush();
    expect(node.textContent).toContain('Unsupported host');
    expect([...node.querySelectorAll('button')].some((button) => button.textContent === 'Save')).toBe(false);
  });
});
