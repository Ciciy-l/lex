import { lazy } from 'react';
import { GitFork } from 'lucide-react';
import { registerTabKind } from '../../registry';
import type { TabKindPlugin } from '../../types';
import { hydrateGraphState, type GitGraphState } from './state';

const TabBody = lazy(() =>
  import('./GitGraphTabBody').then((module) => ({ default: module.GitGraphTabBody })),
);
const plugin: TabKindPlugin<GitGraphState> = {
  kind: 'git-graph',
  menu: {
    kind: 'git-graph',
    labelKey: 'rightSidebar.gitGraph.title',
    icon: GitFork,
    order: 16,
    enabled: true,
    singleton: true,
    hiddenFromMenu: true,
  },
  TabPillTitle: ({ t }) => <>{t('rightSidebar.gitGraph.title')}</>,
  TabPillIcon: () => <GitFork size={13} />,
  TabBody,
  defaultState: () => hydrateGraphState(null),
  hydrateState: hydrateGraphState,
};
registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
