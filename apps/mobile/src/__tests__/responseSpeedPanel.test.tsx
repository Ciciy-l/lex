// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ResponseSpeedSnapshot } from '@cindy/maker-shared/usage-format';

vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const view = (tag: string) => ({ children, testID, onPress }: { children?: ReactNode; testID?: string; onPress?: () => void }) =>
    createElement(tag, { 'data-testid': testID, onClick: onPress }, children);
  return { View: view('div'), Pressable: view('button'), StyleSheet: { create: (s: unknown) => s } };
});
vi.mock('@/components/AppText', async () => {
  const { createElement } = await import('react');
  return { Text: ({ children, testID }: { children?: ReactNode; testID?: string }) => createElement('span', { 'data-testid': testID }, children) };
});
vi.mock('react-native-svg', () => ({ default: () => null, Path: () => null }));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  return { ...tokens, useTheme: () => ({ colors: tokens.lightColors }), useThemedStyles: (make: (c: unknown) => unknown) => make(tokens.lightColors) };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => key + (values ? JSON.stringify(values) : '') }) }));
vi.mock('@/session/ContextSheet', () => ({
  ContextSheet: ({ visible, children }: { visible: boolean; children: ReactNode }) => visible ? <div>{children}</div> : null,
  ContextSheetRow: ({ label, onPress }: { label: string; onPress(): void }) => <button onClick={onPress}>{label}</button>,
}));
import { ResponseSpeedPanel } from '@/session/ResponseSpeedPanel';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root; let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); root = createRoot(host); });
afterEach(() => act(() => root.unmount()));
const speed: ResponseSpeedSnapshot = { phase: 'complete', waitOrigin: 'turn', firstResponseMs: 20,
  waitingMs: 0, outputTokens: 42, durationMs: 2000, averageRate: 21, recentRate: 21,
  estimated: false, samples: [], sampledAt: 1 };

it('reopens completed output, uses measured output only, and closes on a new task identity', async () => {
  await act(async () => root.render(<ResponseSpeedPanel key="owner:device:task" speed={speed} />));
  await act(async () => (host.querySelector('button') as HTMLButtonElement).click());
  expect(host.querySelector('[data-testid="session.responseSpeedOutput"]')?.textContent).toContain('42');
  expect(host.textContent).toContain('session.screen.averageRate');
  await act(async () => root.render(<ResponseSpeedPanel key="owner:device:task" speed={{ ...speed, phase: 'waiting', outputTokens: 0, firstResponseMs: null, recentRate: null, averageRate: null }} />));
  expect(host.querySelector('[data-testid="session.responseSpeedOutput"]')?.textContent).not.toContain('42');
  await act(async () => root.render(<ResponseSpeedPanel key="other:device:task" speed={speed} />));
  expect(host.querySelector('[data-testid="session.responseSpeedOutput"]')).toBeNull();
});
