import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import { TAB_IDS } from '@/lib/tabLabels';
import {
  buildSettingsSearchDocuments,
  createSettingsSearchParams,
  normalizeSettingsSearchText,
  resolveSettingsSearchEntry,
  searchSettings,
  validateSettingsSearchCatalog,
} from '../settingsSearchCatalog';
import type { SettingsSearchContext } from '../settingsSearchTypes';

const localMessages: Record<string, string> = {
  'settings.tabs.general': '通用',
  'settings.sections.appearance': '外观',
  'settings.appearance.modeLabel': '外观模式',
  'settings.sections.bots': '伙伴',
  'settings.remoteControl.sections.myDevices': '我的设备',
};

const englishMessages: Record<string, string> = {
  'settings.tabs.general': 'General',
  'settings.sections.appearance': 'Appearance',
  'settings.appearance.modeLabel': 'Appearance mode',
  'settings.sections.bots': 'Teammates',
  'settings.remoteControl.sections.myDevices': 'My devices',
};

const translate = ((key: string, options?: { lng?: string; defaultValue?: string }) => {
  const messages = options?.lng === 'en' ? englishMessages : localMessages;
  return messages[key] ?? key.split('.').pop() ?? options?.defaultValue ?? '';
}) as unknown as TFunction;

const context: SettingsSearchContext = {
  region: 'global',
  mode: 'cloud',
  membershipKind: 'personal',
  platform: 'darwin',
  teammatesEnabled: true,
};

describe('settings search catalog', () => {
  it('has a unique, routable category entry for every visible Settings tab', () => {
    expect(validateSettingsSearchCatalog()).toEqual([]);
    const documents = buildSettingsSearchDocuments(translate, TAB_IDS, context);
    for (const tab of TAB_IDS) {
      expect(documents.some((document) => document.entry.id === tab)).toBe(true);
    }
    expect(documents.some((document) => String(document.entry.tab) === 'cindy-make')).toBe(false);
    expect(documents.filter((document) => document.entry.tab === 'ghosts').map((document) => document.entry.id)).toEqual([
      'ghosts',
    ]);
  });

  it('normalizes compatibility forms and searches localized labels plus synonyms', () => {
    expect(normalizeSettingsSearchText('  ＤＡＲＫ　 Mode  ')).toBe('dark mode');
    const documents = buildSettingsSearchDocuments(translate, ['general'], context);
    expect(searchSettings(documents, 'dark mode')[0]?.entry.id).toBe('settings.appearance.modeLabel');
    expect(searchSettings(documents, '外观模式')[0]?.title).toBe('外观模式');
    const allDocuments = buildSettingsSearchDocuments(translate, TAB_IDS, context);
    expect(searchSettings(allDocuments, 'device link').some((document) => document.entry.id === 'remoteControl.devices')).toBe(true);
    expect(searchSettings(allDocuments, '提示词').some((document) => document.entry.id === 'personalization.userPrompt')).toBe(true);
  });

  it('hides unavailable tabs and feature-gated entries from results and deep links', () => {
    const unavailableContext = { ...context, mode: 'local' as const, teammatesEnabled: false };
    const documents = buildSettingsSearchDocuments(translate, ['general', 'remote-control'], unavailableContext);
    expect(documents.some((document) => document.entry.id === 'general.bots')).toBe(false);
    expect(documents.some((document) => document.entry.id === 'remoteControl.devices')).toBe(false);
    expect(resolveSettingsSearchEntry('billing', 'billing', ['general'], context)).toBeNull();
    expect(resolveSettingsSearchEntry('remote-control', 'remoteControl.devices', ['remote-control'], unavailableContext)).toBeNull();
  });

  it('filters settings that are unavailable on the current operating system', () => {
    const linuxContext = { ...context, platform: 'linux' };
    const documents = buildSettingsSearchDocuments(
      translate,
      ['general', 'voice-input', 'computer-use'],
      linuxContext,
    );
    expect(documents.some((document) => document.entry.id === 'settings.voiceInput.muteSystemAudio.label')).toBe(false);
    expect(documents.some((document) => document.entry.id === 'settings.voiceInput.shortcut.label')).toBe(false);
    expect(documents.some((document) => document.entry.id === 'settings.computerUse.directControl.permissions.title')).toBe(false);
    expect(documents.some((document) => document.entry.id === 'settings.windowBehavior.closeBehavior.label')).toBe(true);
  });

  it('resolves existing section aliases and changes only Settings navigation parameters', () => {
    const entry = resolveSettingsSearchEntry('general', 'collaboration', TAB_IDS, context);
    expect(entry?.id).toBe('general.collaboration');
    const next = createSettingsSearchParams(
      new URLSearchParams('tab=ghosts&ghost=selected&panel=skills&openPanel=pi-extensions&debug=keep'),
      entry!,
    );
    expect(next.get('tab')).toBeNull();
    expect(next.get('section')).toBe('general.collaboration');
    expect(next.get('debug')).toBe('keep');
    expect(next.has('ghost')).toBe(false);
    expect(next.has('panel')).toBe(false);
    expect(next.has('openPanel')).toBe(false);
  });
});
