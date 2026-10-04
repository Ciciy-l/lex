// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PendingSendBubble, type PendingSendBubbleActions } from '@/session/PendingSendBubble';
import type { MobilePendingSendItem } from '@/session/pendingSendItems';

vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const view = (tag: string) => (props: Record<string, unknown> & { children?: ReactNode }) =>
    createElement(tag, { 'data-testid': props.testID, onClick: props.disabled ? undefined : props.onPress }, props.children);
  return { View: view('div'), Text: view('span'), Pressable: view('button'), ActivityIndicator: () => null,
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 } };
});
vi.mock('@/components/AppText', async () => ({ Text: (await import('react-native')).Text }));
vi.mock('lucide-react-native', () => ({ Check: () => null, AlertCircle: () => null, ArrowUp: () => null,
  ListEnd: () => null, Paperclip: () => null, Pencil: () => null, RotateCcw: () => null, Trash2: () => null }));
vi.mock('@/session/SentInlineAtomBody', () => ({ SentInlineAtomBody: () => null }));
vi.mock('@/session/sentAttachmentThumbStore', () => ({ getSentAttachmentThumbUri: () => null,
  useSentAttachmentThumbsVersion: () => 0 }));
vi.mock('react-i18next', () => ({ initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  return { ...tokens, useTheme: () => ({ colors: tokens.lightColors }),
    useThemedStyles: (make: (colors: typeof tokens.lightColors) => unknown) => make(tokens.lightColors) };
});

let root: Root;
let host: HTMLDivElement;
const removeOutbox = vi.fn();
const retryOutbox = vi.fn();
const item: MobilePendingSendItem = {
  type: 'pending_send', key: 'local-send', clientId: 'local-send', phase: 'sending', text: 'hello',
  queueIndex: null, sentInlineTokens: [], thumbs: [], fileCount: 0, attachmentCount: 0, uploadedCount: 0,
  errorText: null, hint: null, actions: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); });

function show(itemOverrides: Partial<MobilePendingSendItem> = {}) {
  const actions: PendingSendBubbleActions = {
    selectedClientId: 'local-send', onSelect: vi.fn(), onRemove: vi.fn(), onBeginEdit: vi.fn(),
    onSteer: vi.fn(), onRetryOutbox: retryOutbox, onRemoveOutbox: removeOutbox,
  };
  act(() => root.render(<PendingSendBubble item={{ ...item, ...itemOverrides }} actions={actions}
    renderImage={() => null} renderFile={() => null} renderText={() => null} />));
}

it.each(['uploading', 'sending'] as const)('offers cancel while a local outbox message is %s', (phase) => {
  show({ phase, queueIndex: null, ...(phase === 'uploading' ? { attachmentCount: 1, uploadedCount: 0 } : {}) });
  const cancel = host.querySelector<HTMLButtonElement>('[data-testid="pendingSend.outboxRemove.local-send"]');
  expect(cancel?.textContent).toBe('message.queue.cancel');
  act(() => cancel?.click());
  expect(removeOutbox).toHaveBeenCalledExactlyOnceWith('local-send');
  expect(retryOutbox).not.toHaveBeenCalled();
});

it('keeps delete/retry for failed outbox items and hides actions for settling or recovery-owned creation', () => {
  show({ phase: 'failed', queueIndex: null });
  const remove = host.querySelector<HTMLButtonElement>('[data-testid="pendingSend.outboxRemove.local-send"]');
  const retry = host.querySelector<HTMLButtonElement>('[data-testid="pendingSend.outboxRetry.local-send"]');
  expect(remove?.textContent)
    .toBe('message.queue.delete');
  expect(retry?.textContent)
    .toBe('message.queue.retry');
  act(() => remove?.click());
  act(() => retry?.click());
  expect(removeOutbox).toHaveBeenCalledExactlyOnceWith('local-send');
  expect(retryOutbox).toHaveBeenCalledExactlyOnceWith('local-send');

  removeOutbox.mockClear();
  retryOutbox.mockClear();
  show({ phase: 'settling', queueIndex: null });
  expect(host.querySelector('[data-testid="pendingSend.outboxActions.local-send"]')).toBeNull();
  show({ phase: 'sending', queueIndex: null, canCancel: false });
  expect(host.querySelector('[data-testid="pendingSend.outboxActions.local-send"]')).toBeNull();
  expect(removeOutbox).not.toHaveBeenCalled();
  expect(retryOutbox).not.toHaveBeenCalled();
});
