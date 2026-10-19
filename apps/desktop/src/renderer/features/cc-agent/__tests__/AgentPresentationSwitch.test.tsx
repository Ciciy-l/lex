// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, expect, it } from 'vitest';
import { AgentPresentationUnavailable } from '../AgentPresentationSwitch';
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
