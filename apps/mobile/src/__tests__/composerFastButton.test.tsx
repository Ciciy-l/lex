// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ComposerFastButton } from '@/session/ComposerFastButton';

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  Pressable: ({ children, onPress, disabled, accessibilityLabel, accessibilityState }: any) =>
    createElement('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel, 'aria-checked': accessibilityState.checked }, children),
}));
vi.mock('lucide-react-native', () => ({ Zap: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/theme', () => ({ iconSize: { sm: 14 }, iconStroke: { regular: 1.5 }, radius: { pill: 9999 }, useTheme: () => ({ colors: {} }) }));
afterEach(cleanup);

it('uses the same controlled on/off value and prevents changes while locked', () => {
  const onChange = vi.fn();
  const view = render(<ComposerFastButton enabled={false} onChange={onChange} />);
  const button = screen.getByRole('button');
  fireEvent.click(button);
  expect(onChange).toHaveBeenLastCalledWith(true);
  expect(button.getAttribute('aria-checked')).toBe('false');
  view.rerender(<ComposerFastButton enabled onChange={onChange} />);
  expect(button.getAttribute('aria-label')).toBe('models.options.fastDisable');
  fireEvent.click(button);
  expect(onChange).toHaveBeenLastCalledWith(false);
  view.rerender(<ComposerFastButton enabled disabled onChange={onChange} />);
  fireEvent.click(button);
  expect(onChange).toHaveBeenCalledTimes(2);
});

it('wires both composers to their existing preference writers and targets the displayed selection', () => {
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
  const draft = read('app/sessions/new.tsx');
  const session = read('app/sessions/[sessionId].tsx');
  expect(draft).toContain('onChange={changeSelectedFastMode}');
  expect(draft).toContain('enabled={draft.fastMode}');
  expect(session).toContain('changeComposerSelectedFastMode(enabled, composerDisplayAgentKind)');
  expect(session).toContain('if (agentSwitchIntent?.targetAgentKind === targetAgent)');
  expect(session).toContain('hasFastModeCap: composerDisplayCapabilities?.hasFastMode === true');
  expect(session).toContain('disabled={controlBusy || !canUseRemoteSessionControls || modelSheetOpen}');
});
