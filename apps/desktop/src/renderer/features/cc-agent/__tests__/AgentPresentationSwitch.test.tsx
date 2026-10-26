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
import { useDisableTab } from '../../../hooks/useDisableTab';

afterEach(cleanup);

it.each([['en', en], ['ja', ja], ['ko', ko], ['zh-CN', zhCN], ['zh-TW', zhTW]] as const)(
  'describes only the active native GUI text semantics in %s without changing switch behavior', async (language, locale) => {
    const i18n = createInstance();
    await i18n.init({ lng: language, fallbackLng: false, resources: { [language]: { translation: locale } } });
    const change = vi.fn();
    const { rerender } = render(<I18nextProvider i18n={i18n}><AgentPresentationSwitch mode="gui" onChange={change} guiInputMode="plain-text" /></I18nextProvider>);
    const gui = screen.getByRole('button', { name: locale.ccAgent.presentation.guiDescription });
    expect(gui.title).toBe(locale.ccAgent.presentation.guiBodyText);
    expect(gui.getAttribute('aria-description')).toBe(gui.title);
    fireEvent.click(gui); expect(change).toHaveBeenCalledExactlyOnceWith('gui');
    rerender(<I18nextProvider i18n={i18n}><AgentPresentationSwitch mode="tui" onChange={change} guiInputMode="append-plain-text" /></I18nextProvider>);
    expect(gui.title).toBe(locale.ccAgent.presentation.guiAppendText);
    rerender(<I18nextProvider i18n={i18n}><AgentPresentationSwitch mode="gui" onChange={change} /></I18nextProvider>);
    expect(gui.getAttribute('title')).toBeNull();
    expect(gui.getAttribute('aria-description')).toBeNull();
  },
);

it('keeps local Tab and arrow navigation available under the desktop Tab gate without changing the selected view', async () => {
  const i18n = createInstance();
  await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
  const change = vi.fn();
  function View() {
    useDisableTab();
    return <AgentPresentationSwitch mode="gui" onChange={change} />;
  }
  render(<I18nextProvider i18n={i18n}><View /></I18nextProvider>);
  const gui = screen.getByRole('button', { name: en.ccAgent.presentation.guiDescription });
  const tui = screen.getByRole('button', { name: en.ccAgent.presentation.tuiDescription });
  gui.focus();
  expect(fireEvent.keyDown(gui, { key: 'Tab' })).toBe(true);
  fireEvent.keyDown(gui, { key: 'ArrowRight' });
  expect(document.activeElement).toBe(tui);
  fireEvent.keyDown(tui, { key: 'Home' });
  expect(document.activeElement).toBe(gui);
  expect(change).not.toHaveBeenCalled();
  expect(fireEvent.keyDown(document.body, { key: 'Tab' })).toBe(false);
});

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
