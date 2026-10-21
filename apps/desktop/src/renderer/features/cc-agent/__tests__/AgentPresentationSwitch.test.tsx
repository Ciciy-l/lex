// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentPresentationSwitch, AgentPresentationUnavailable } from '../AgentPresentationSwitch';
import { hasLocalNativePresentation } from '../../../../shared/agentPresentation';
import en from '../../../i18n/locales/en/common.json';
import ja from '../../../i18n/locales/ja/common.json';
import ko from '../../../i18n/locales/ko/common.json';
import zhCN from '../../../i18n/locales/zh-CN/common.json';
import zhTW from '../../../i18n/locales/zh-TW/common.json';

afterEach(cleanup);

// Use the real locale objects: duplicate JSON members previously erased these
// children at runtime while the existing terminal string remained valid.
it.each([['en', en], ['ja', ja], ['ko', ko], ['zh-CN', zhCN], ['zh-TW', zhTW]] as const)(
  'renders the task connection explanation from the actual %s locale', async (language, locale) => {
    const i18n = createInstance();
    await i18n.init({ lng: language, fallbackLng: false, resources: { [language]: { translation: locale } } });
    render(<I18nextProvider i18n={i18n}><AgentPresentationUnavailable /></I18nextProvider>);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe(locale.ccAgent.presentation.startupUnavailable.label);
    expect(status.title).toBe(locale.ccAgent.presentation.startupUnavailable.startup);
    expect(status.title).not.toContain('ccAgent.presentation.');
    expect(typeof i18n.t('ccAgent.presentation.unavailable')).toBe('string');
    expect(i18n.t('ccAgent.presentation.unavailable')).toBe(locale.ccAgent.presentation.unavailable);
  },
);

it('offers all four local native hosts while keeping an unsupported transport visible with its explanation', async () => {
  expect(hasLocalNativePresentation('claude-code')).toBe(true);
  expect(hasLocalNativePresentation('cc')).toBe(true);
  expect(hasLocalNativePresentation(undefined)).toBe(false);
  expect(hasLocalNativePresentation('unknown-engine')).toBe(false);
  expect(hasLocalNativePresentation('codex')).toBe(true);
  expect(hasLocalNativePresentation('pi')).toBe(true); expect(hasLocalNativePresentation('omp')).toBe(true);
  const i18n = createInstance();
  await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
  const change = vi.fn();
  render(<I18nextProvider i18n={i18n}><AgentPresentationSwitch mode="gui" onChange={change}
    tuiUnavailable={en.ccAgent.presentation.startupUnavailable.unsupported} /></I18nextProvider>);
  const terminal = screen.getByRole('button', { name: en.ccAgent.presentation.tuiDescription });
  expect(terminal.getAttribute('aria-disabled')).toBe('true');
  expect(terminal.title).toBe(en.ccAgent.presentation.startupUnavailable.unsupported);
  fireEvent.click(terminal); expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: en.ccAgent.presentation.guiDescription }));
  expect(change).toHaveBeenCalledExactlyOnceWith('gui');
});
