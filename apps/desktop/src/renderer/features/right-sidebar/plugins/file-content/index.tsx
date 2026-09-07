import { lazy } from 'react';
import { File } from 'lucide-react';
import { registerTabKind } from '../../registry';
import type { TabKindPlugin } from '../../types';
import { hydrateFileContentTab, type FileContentTabState } from './state';

const plugin: TabKindPlugin<FileContentTabState> = {
  kind: 'file-content',
  menu: {
    kind: 'file-content',
    labelKey: 'rightSidebar.tabs.kinds.fileBrowser',
    icon: File,
    order: 11,
    enabled: true,
    hiddenFromMenu: true,
  },
  TabBody: lazy(() =>
    import('./FileContentTabBody').then((m) => ({ default: m.FileContentTabBody })),
  ),
  TabPillTitle: ({ state, t }) => (
    <span className={state.preview ? 'italic' : undefined}>{state.path.split(/[\/]/).pop() || t('rightSidebar.tabs.kinds.fileBrowser')}</span>
  ),
  TabPillIcon: () => <File size={13} />,
  defaultState: () => ({ path: '', workdir: '', external: false }),
  hydrateState: hydrateFileContentTab,
};
registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
