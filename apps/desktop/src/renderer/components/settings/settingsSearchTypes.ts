import type { VisibleSettingsTab } from '@/lib/tabLabels';
import type { ImBotIdentity } from './imBotVisibility';

export interface SettingsSearchContext extends ImBotIdentity {
  platform: string;
  teammatesEnabled: boolean;
}

export interface SettingsSearchEntry {
  id: string;
  tab: VisibleSettingsTab;
  targetId: string;
  fallbackTargetId?: string;
  titleKey: string;
  sectionKey: string;
  descriptionKey?: string;
  aliases?: readonly string[];
  isVisible?: (context: SettingsSearchContext) => boolean;
}

export interface SettingsSearchDocument {
  entry: SettingsSearchEntry;
  title: string;
  section: string;
  category: string;
  searchText: string;
}

export interface SettingsSearchModule {
  id: string;
  order: number;
  entries: readonly SettingsSearchEntry[];
}
