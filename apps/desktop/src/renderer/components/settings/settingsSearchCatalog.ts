import type { TFunction } from 'i18next';

import { TAB_IDS, TAB_LABEL_KEY, type SettingsTab, type VisibleSettingsTab } from '@/lib/tabLabels';

import type {
  SettingsSearchContext,
  SettingsSearchDocument,
  SettingsSearchEntry,
  SettingsSearchModule,
} from './settingsSearchTypes';

export type { SettingsSearchDocument, SettingsSearchEntry, SettingsSearchModule } from './settingsSearchTypes';

const modules = import.meta.glob<SettingsSearchModule>('./**/*.settings-search.ts', {
  eager: true,
  import: 'default',
});

export const SETTINGS_SEARCH_MODULES = Object.values(modules).sort(
  (left, right) => left.order - right.order || left.id.localeCompare(right.id),
);

export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = SETTINGS_SEARCH_MODULES.flatMap(
  (module) => module.entries,
);

const TAB_ALIASES: Partial<Record<VisibleSettingsTab, readonly string[]>> = {
  general: ['general settings', 'app settings', '通用设置', '应用设置'],
  personalization: ['custom prompts', 'assistant behavior', '个性化', '提示词', '自定义指令'],
  providers: ['model providers', 'model sources', '供应商', '模型供应商', '模型来源'],
  billing: ['plan', 'payment', '账单', '付费'],
  usage: ['usage statistics', 'token usage', '用量统计', '使用统计'],
  'voice-input': ['dictation', 'speech to text', 'microphone', '语音输入', '听写', '麦克风'],
  'im-bot': ['chat integrations', 'messaging bots', 'IM 机器人', '聊天集成'],
  shortcuts: ['keyboard shortcuts', 'hotkeys', '快捷键', '热键'],
  'agent-island': ['dynamic island', '灵动岛'],
  import: ['session import', '导入会话', '会话导入'],
  'remote-control': ['remote access', 'device link', 'SSH', '远程控制', '设备互联', '远程主机'],
  ghosts: ['plugins', 'extension catalog', '插件'],
  'builtin-tools': ['built-in tools', '内置工具'],
  'computer-use': ['computer control', 'accessibility', 'automation', '电脑控制', '自动化'],
  help: ['help center', 'documentation', '帮助文档'],
  about: ['app version', 'updates', 'about this app', '应用版本', '更新'],
  storage: ['database', 'cache', 'cleanup', '存储', '数据库', '缓存', '清理'],
};

const rootEntries: readonly SettingsSearchEntry[] = TAB_IDS.map((tab) => ({
  id: tab,
  tab,
  targetId: 'settings-panel-' + tab,
  titleKey: TAB_LABEL_KEY[tab],
  sectionKey: TAB_LABEL_KEY[tab],
  aliases: TAB_ALIASES[tab],
}));

const rootTargetKeys = new Set(
  rootEntries.map((entry) => entry.tab + '|' + entry.targetId + '|' + entry.titleKey),
);
const allEntries: readonly SettingsSearchEntry[] = [
  ...rootEntries,
  ...SETTINGS_SEARCH_ENTRIES.filter(
    (entry) => !rootTargetKeys.has(entry.tab + '|' + entry.targetId + '|' + entry.titleKey),
  ),
];

export function normalizeSettingsSearchText(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
}

function readTranslation(t: TFunction, key: string, language?: string): string {
  const value: unknown = t(key, { ...(language ? { lng: language } : {}), defaultValue: '' });
  return typeof value === 'string' && value !== key ? value.replace(/{{[^}]+}}/g, '') : '';
}

function isEntryVisible(
  entry: SettingsSearchEntry,
  visibleTabs: ReadonlySet<VisibleSettingsTab>,
  context?: SettingsSearchContext,
): boolean {
  return visibleTabs.has(entry.tab) && (!entry.isVisible || (context !== undefined && entry.isVisible(context)));
}

export function buildSettingsSearchDocuments(
  t: TFunction,
  visibleTabIds: readonly VisibleSettingsTab[],
  context?: SettingsSearchContext,
): SettingsSearchDocument[] {
  const visibleTabs = new Set(visibleTabIds);

  return allEntries.filter((entry) => isEntryVisible(entry, visibleTabs, context)).map((entry) => {
    const title = readTranslation(t, entry.titleKey);
    const section = readTranslation(t, entry.sectionKey);
    const category = readTranslation(t, TAB_LABEL_KEY[entry.tab]);
    const english = [
      readTranslation(t, entry.titleKey, 'en'),
      readTranslation(t, entry.sectionKey, 'en'),
      readTranslation(t, TAB_LABEL_KEY[entry.tab], 'en'),
      ...(entry.descriptionKey ? [readTranslation(t, entry.descriptionKey, 'en')] : []),
    ];
    const localDescription = entry.descriptionKey ? readTranslation(t, entry.descriptionKey) : '';
    const searchText = normalizeSettingsSearchText(
      [title, section, category, localDescription, ...english, ...(entry.aliases ?? [])].join(' '),
    );

    return { entry, title, section, category, searchText };
  }).filter((document) => document.title.length > 0 && document.category.length > 0);
}

export function searchSettings(
  documents: readonly SettingsSearchDocument[],
  query: string,
): SettingsSearchDocument[] {
  const normalizedQuery = normalizeSettingsSearchText(query);
  if (!normalizedQuery) return [];
  const tokens = normalizedQuery.split(' ').filter(Boolean);

  return documents
    .map((document, index) => {
      const title = normalizeSettingsSearchText(document.title);
      const section = normalizeSettingsSearchText(document.section);
      const category = normalizeSettingsSearchText(document.category);
      if (!document.searchText.includes(normalizedQuery) && !tokens.every((token) => document.searchText.includes(token))) {
        return null;
      }
      let score = 100;
      if (title === normalizedQuery) score += 1000;
      else if (title.startsWith(normalizedQuery)) score += 700;
      else if (title.includes(normalizedQuery)) score += 500;
      if (section.includes(normalizedQuery)) score += 300;
      if (category.includes(normalizedQuery)) score += 100;
      return { document, score, index };
    })
    .filter((match): match is { document: SettingsSearchDocument; score: number; index: number } => match !== null)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((match) => match.document);
}

export function resolveSettingsSearchEntry(
  tab: SettingsTab,
  section: string | null,
  visibleTabIds: readonly VisibleSettingsTab[],
  context?: SettingsSearchContext,
): SettingsSearchEntry | null {
  if (!section) return null;
  const normalized = normalizeSettingsSearchText(section);
  const visibleTabs = new Set(visibleTabIds);

  return allEntries.find((entry) => {
    if (entry.tab !== tab || !isEntryVisible(entry, visibleTabs, context)) return false;
    const aliases = [entry.id, entry.id.split('.').at(-1) ?? '', entry.targetId, ...(entry.aliases ?? [])];
    return aliases.some((alias) => normalizeSettingsSearchText(alias) === normalized);
  }) ?? null;
}

export function createSettingsSearchParams(
  current: URLSearchParams,
  entry: SettingsSearchEntry,
): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const key of ['openPanel', 'ghost', 'panel', 'imGroup', 'connect', 'wizard', 'intent']) {
    next.delete(key);
  }
  if (entry.tab === 'general') next.delete('tab');
  else next.set('tab', entry.tab);
  next.set('section', entry.id);
  return next;
}

export function validateSettingsSearchCatalog(): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const tabRoots = new Set<VisibleSettingsTab>();

  for (const entry of allEntries) {
    if (ids.has(entry.id)) errors.push('duplicate id: ' + entry.id);
    ids.add(entry.id);
    if (!entry.tab || !entry.targetId || !entry.titleKey || !entry.sectionKey) {
      errors.push('incomplete entry: ' + entry.id);
    }
    if (entry.id === entry.tab) tabRoots.add(entry.tab);
    if (!(TAB_IDS as readonly string[]).includes(entry.tab)) errors.push('unroutable tab: ' + entry.tab);
  }

  for (const tab of TAB_IDS) {
    if (!tabRoots.has(tab)) errors.push('missing category entry: ' + tab);
  }
  return errors;
}
