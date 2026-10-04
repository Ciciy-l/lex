// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteBotMemoryPage } from '@/session/RemoteBotMemoryPage';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  action: vi.fn(),
  invoke: vi.fn(),
  alert: vi.fn(),
  routerBack: vi.fn(),
  buttons: [] as Array<{ text?: string; style?: string; onPress?: () => void }>,
}));

vi.mock('react-native', () => ({
  Alert: { alert: h.alert },
  ActivityIndicator: () => createElement('span', { 'data-testid': 'activity' }),
  Pressable: ({ children, onPress, disabled, accessibilityLabel, testID }: any) => createElement(
    'button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel, 'data-testid': testID }, children,
  ),
  ScrollView: ({ children }: any) => createElement('div', {}, children),
  StyleSheet: { create: (value: any) => value, hairlineWidth: 1 },
  View: ({ children }: any) => createElement('div', {}, children),
}));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: any) => createElement('div', {}, children),
}));
vi.mock('@/components/AppText', () => ({
  Text: ({ children, accessibilityRole }: any) => createElement('span', { role: accessibilityRole }, children),
  TextInput: ({ multiline, value, onChangeText, accessibilityLabel, editable = true }: any) => createElement(
    multiline ? 'textarea' : 'input',
    { 'aria-label': accessibilityLabel, value, disabled: !editable, onInput: (event: any) => onChangeText?.(event.target.value) },
  ),
}));
vi.mock('@/components/MobilePrimitives', () => ({
  MainWindowActionButton: ({ action }: any) => createElement(
    'button', { onClick: action.onPress, disabled: action.disabled || action.busy, 'aria-label': action.accessibilityLabel ?? action.label }, action.label,
  ),
}));
vi.mock('@/platform/chrome', () => ({
  SimpleStackHeader: ({ onBack, backTestID, title }: any) => createElement(
    'header', {}, createElement('button', { onClick: onBack, 'data-testid': backTestID, 'aria-label': backTestID }, title),
  ),
  simpleScreenSafeAreaEdges: () => undefined,
}));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: h.invoke }) }));
vi.mock('@/device-link/remoteResources', () => ({
  getRemoteResource: h.get,
  invokeRemoteResourceAction: h.action,
}));
vi.mock('@/device-link/remoteStatus', () => ({ formatRemoteError: (cause: unknown) => cause instanceof Error ? cause.message : String(cause) }));
vi.mock('@/theme', () => ({
  useTheme: () => ({ colors: {
    surface: '', surfaceElevated: '', textPrimary: '', textSecondary: '', textTertiary: '',
    border: '', errorText: '',
  } }),
  useThemedStyles: (factory: (colors: Record<string, string>) => unknown) => factory({
    surface: '', surfaceElevated: '', textPrimary: '', textSecondary: '', textTertiary: '', border: '', errorText: '',
  }),
}));
vi.mock('@/theme/tokens', () => ({
  fontWeight: { medium: '500', regular: '400' }, lineHeight: { bodyRelaxed: 20, caption: 16 },
  radius: { container: 8, pill: 20, control: 8 }, spacing: { lg: 16, md: 12, sm: 8, xs: 4 },
  typeScale: { body: 16, caption: 12, footnote: 13, listBody: 14, micro: 11, subtitle: 18 },
}));
vi.mock('@/utils/backGuard', () => ({ goBackGuarded: h.routerBack }));
vi.mock('expo-router', () => ({ useRouter: () => ({}) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));

const host = { deviceId: 'device-a', deviceName: 'Desktop' };
const baseId = 'settings:bot-a/memory';
const entryA = 'settings:bot-a/memory/feedback_a';
const entryB = 'settings:bot-a/memory/feedback_b';
const listResource = () => ({
  ref: { collectionId: 'teammates', kind: 'bot', id: baseId }, revision: 'list-1',
  display: { title: 'Saved Memories' }, links: [], blocks: [{
    id: 'memory-feedback', primitive: 'list', fallbackMarkdown: '- A\n- B', title: 'Your preferences',
    data: { count: 2, entries: [
      { id: 'feedback_a', title: 'A', subtitle: 'A body', resourceId: entryA },
      { id: 'feedback_b', title: 'B', subtitle: 'B body', resourceId: entryB },
    ] },
  }],
});
const detailResource = (id: string, revision: string, title: string, body: string) => ({
  ref: { collectionId: 'teammates', kind: 'bot', id }, revision,
  display: { title }, links: [], blocks: [{ id: 'entry', primitive: 'form', fallbackMarkdown: body,
    data: { values: { title, body, expectedUpdatedAt: revision } } }],
});
const flush = async () => { await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); };
let root: Root;
let node: HTMLDivElement;

function button(label: string): HTMLButtonElement {
  const found = [...node.querySelectorAll('button')].find((candidate) => candidate.getAttribute('aria-label') === label || candidate.textContent?.includes(label));
  if (!found) throw new Error('missing button ' + label + ' html=' + node.innerHTML + ' getCalls=' + h.get.mock.calls.length);
  return found;
}
function renderPage(resourceId = baseId) {
  root.render(createElement(RemoteBotMemoryPage, { host, resourceId }));
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  node = document.createElement('div');
  document.body.append(node);
  root = createRoot(node);
  h.get.mockReset();
  h.action.mockReset();
  h.alert.mockReset().mockImplementation((_title: string, _body: string, buttons: Array<{ text?: string; style?: string; onPress?: () => void }>) => { h.buttons = buttons; });
  h.routerBack.mockReset();
  h.get.mockImplementation(async (_invoke: unknown, _target: unknown, ref: { id?: string }) => ref.id === baseId ? listResource() : detailResource(ref.id ?? entryA, 'r1', ref.id === entryB ? 'B' : 'A', ref.id === entryB ? 'B body' : 'A body'));
  h.action.mockResolvedValue({ effects: [] });
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  vi.useRealTimers();
});

describe('RemoteBotMemoryPage state guards', () => {
  it('releases busy after delete transition and keeps the next entry writable', async () => {
    let deleted = false;
    let currentB = detailResource(entryB, 'b1', 'B', 'B body');
    h.get.mockImplementation(async (_invoke: unknown, _target: unknown, ref: { id?: string }) => {
      if (ref.id === baseId) return deleted ? { ...listResource(), blocks: [{ ...listResource().blocks[0], data: { ...listResource().blocks[0].data, count: 1, entries: [listResource().blocks[0].data.entries[1]] } }] } : listResource();
      if (ref.id === entryB) return currentB;
      return detailResource(entryA, 'a1', 'A', 'A body');
    });
    h.action.mockImplementation(async (_invoke: unknown, _target: unknown, request: { actionId?: string; input?: Record<string, unknown> }) => {
      if (request.actionId === 'memory-delete') deleted = true;
      if (request.actionId === 'memory-update') currentB = detailResource(entryB, 'b2', String(request.input?.title ?? 'B'), String(request.input?.body ?? 'B body'));
      return { effects: [] };
    });
    await act(async () => renderPage());
    await flush();
    await act(async () => button('A').click());
    await flush();
    await act(async () => button('devices.companionProfile.memory.delete').click());
    await act(async () => h.buttons.find((candidate) => candidate.style === 'destructive')?.onPress?.());
    await flush();
    await act(async () => button('B').click());
    await flush();
    await act(async () => button('devices.companionProfile.memory.edit').click());
    const body = node.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => { body.value = 'B mine'; body.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => button('devices.companionProfile.memory.done').click());
    await flush();
    expect(h.action).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ actionId: 'memory-update', input: expect.objectContaining({ body: 'B mine' }) }), 'en');
    expect(node.textContent).toContain('B mine');
  });

  it('preserves the scoped draft when leaving and reopening an entry', async () => {
    await act(async () => renderPage());
    await flush();
    await act(async () => button('A').click());
    await flush();
    await act(async () => button('devices.companionProfile.memory.edit').click());
    const body = node.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => { body.value = 'A unsaved'; body.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => button('remoteMemory.back').click());
    await flush();
    await act(async () => button('A').click());
    await flush();
    await act(async () => button('devices.companionProfile.memory.edit').click());
    expect((node.querySelector('textarea') as HTMLTextAreaElement).value).toBe('A unsaved');
  });

  it('ignores a late save response after returning to the list and opening another entry', async () => {
    const pending = (() => {
      let resolve!: (value: ReturnType<typeof detailResource>) => void;
      const promise = new Promise<ReturnType<typeof detailResource>>((done) => { resolve = done; });
      return { promise, resolve };
    })();
    let aGets = 0;
    h.get.mockImplementation(async (_invoke: unknown, _target: unknown, ref: { id?: string }) => {
      if (ref.id === baseId) return listResource();
      if (ref.id === entryB) return detailResource(entryB, 'b1', 'B', 'B body');
      aGets += 1;
      if (aGets === 2) return pending.promise;
      return detailResource(entryA, 'a1', 'A', 'A body');
    });
    await act(async () => renderPage());
    await flush();
    await act(async () => button('A').click());
    await flush();
    await act(async () => button('devices.companionProfile.memory.edit').click());
    const body = node.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => { body.value = 'A mine'; body.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => button('devices.companionProfile.memory.done').click());
    await act(async () => button('remoteMemory.back').click());
    await flush();
    await act(async () => button('B').click());
    await flush();
    pending.resolve(detailResource(entryA, 'a2', 'A', 'A late response'));
    await flush();
    expect(node.textContent).toContain('B body');
    expect(node.textContent).not.toContain('A late response');
  });

  it('reconciles an update timeout without resending and reports a hidden delete failure', async () => {
    let current = detailResource(entryA, 'r1', 'A', 'A body');
    h.get.mockImplementation(async (_invoke: unknown, _target: unknown, ref: { id?: string }) => ref.id === baseId ? listResource() : current);
    let updateCalls = 0;
    h.action.mockImplementation(async (_invoke: unknown, _target: unknown, request: { actionId?: string; input?: Record<string, unknown> }) => {
      if (request.actionId === 'memory-update') {
        updateCalls += 1;
        current = detailResource(entryA, 'r2', 'A', 'A committed');
        throw new Error('timeout');
      }
      throw new Error('NOT_FOUND');
    });
    await act(async () => renderPage());
    await flush();
    await act(async () => button('A').click());
    await flush();
    await act(async () => button('devices.companionProfile.memory.edit').click());
    const body = node.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => { body.value = 'A committed'; body.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => button('devices.companionProfile.memory.done').click());
    await flush();
    expect(updateCalls).toBe(1);
    expect(node.textContent).toContain('A committed');
    await act(async () => button('devices.companionProfile.memory.delete').click());
    await act(async () => h.buttons.find((candidate) => candidate.style === 'destructive')?.onPress?.());
    await flush();
    expect(node.textContent).toContain('NOT_FOUND');
    expect(node.textContent).toContain('A committed');
  });
});
