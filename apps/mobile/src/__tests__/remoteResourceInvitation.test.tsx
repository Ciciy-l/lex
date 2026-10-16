// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  router: { replace: vi.fn() }, generation: 1,
  params: { collectionId: 'teammates', resourceId: 'bot-1', resourceKind: 'bot', deviceId: 'mac', deviceName: 'Mac' },
  translation: { t: (key: string) => key, i18n: { language: 'en' } },
  read: vi.fn(), action: vi.fn(), upsert: vi.fn(), push: null as null | ((device: string, payload: any) => void),
  link: { connectionEpoch: 1, status: 'online', invoke: vi.fn(), onRemoteResourceChanged: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() },
}));
vi.mock('react-native', async () => {
  const { createElement: el } = await import('react');
  const view = ({ children, testID }: any) => el('div', { 'data-testid': testID }, children);
  return { View: view, ActivityIndicator: () => null, StyleSheet: { create: (s: any) => s }, AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } };
});
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return { Redirect: ({ href }: { href: string }) => { h.router.replace(href); return null; }, useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]), useRouter: () => h.router, useLocalSearchParams: () => h.params };
});
vi.mock('react-i18next', () => ({ useTranslation: () => h.translation }));
vi.mock('react-native-safe-area-context', async () => { const { createElement: el } = await import('react'); return { SafeAreaView: ({ children }: any) => el('div', {}, children) }; });
vi.mock('@/components/AppText', () => ({ Text: 'span' }));

vi.mock('@/components/MobilePrimitives', async () => {
  const { createElement: el } = await import('react');
  return { MainWindowEmptyState: ({ copy }: any) => el('span', {}, copy), MainWindowActionButton: ({ action }: any) => el('button', { onClick: action.onPress, 'data-testid': action.testID }, action.label) };
});
vi.mock('@/platform/chrome', () => ({ SimpleStackHeader: () => null, simpleScreenSafeAreaEdges: () => [] }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: h.generation }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => h.link }));
vi.mock('@/device-link/remoteStatus', () => ({ formatRemoteError: String }));
vi.mock('@/device-link/focusedTopicSubscription', () => ({ startFocusedTopicSubscription: () => () => {} }));
vi.mock('@/device-link/remoteResources', () => ({ getRemoteResource: h.read, invokeRemoteResourceAction: h.action }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: { getSessionDeviceId: () => null, upsertDeviceSession: h.upsert } }));
vi.mock('@/theme', () => ({ useThemedStyles: () => ({}), useTheme: () => ({ colors: {} }) }));
vi.mock('@/utils/backGuard', () => ({ goBackGuarded: vi.fn() }));
import Screen from '../../app/resources/[collectionId]/[resourceId]';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks(); h.generation = 1;
  h.link.onRemoteResourceChanged.mockImplementation(callback => { h.push = callback; return () => { h.push = null; }; });
  h.link.invoke.mockResolvedValue({ id: 'chat-1', source: 'bot' });
  container = document.createElement('div'); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); });
it.each([
  ['teammates', 'bot'], ['bot-groups', 'bot-group'], ['routines', 'routine'],
  [['teammates'], ['bot']], [['bot-groups'], ['bot-group']], [['routines'], ['routine']],
  ['projects', 'bot'], ['projects', 'bot-group'],
])('redirects the retired %j deep link without reading or resuming it', async (collectionId, resourceKind) => {
  Object.assign(h.params, { collectionId, resourceKind });
  await act(async () => root.render(createElement(Screen)));
  expect(h.router.replace).toHaveBeenCalledWith('/devices');
  expect(h.read).not.toHaveBeenCalled();
  expect(h.action).not.toHaveBeenCalled();
  expect(h.link.invoke).not.toHaveBeenCalled();
  expect(h.link.onRemoteResourceChanged).not.toHaveBeenCalled();
  expect(h.upsert).not.toHaveBeenCalled();
});
