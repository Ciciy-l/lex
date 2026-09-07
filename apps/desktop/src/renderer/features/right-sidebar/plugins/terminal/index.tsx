/**
 * Terminal workbench plugin.
 *
 * A terminal tab is a small, persisted layout of independent PTY panes.  This
 * is the Cindy-native equivalent of Orca's CLI window management: the Cindy
 * chat/Agent loop remains untouched, while Claude, Codex, Pi, or a shell can
 * run side by side in the current task's working directory.
 */

import { lazy } from 'react';
import { Terminal as TerminalIcon } from 'lucide-react';
import type { TFunction } from 'i18next';

import { registerTabKind } from '../../registry';
import { terminalPtyId } from './terminalIdentity';
export { terminalPtyId } from './terminalIdentity';
import type { TabKindPlugin } from '../../types';
import {
  collectPaneIds,
  createInitialTerminalState,
  hydrateTerminalState,
  type TerminalState,
} from './terminal-layout';

export type { TerminalState } from './terminal-layout';

const TerminalTabBody = lazy(() =>
  import('./TerminalTabBody').then((module) => ({ default: module.TerminalTabBody })),
);

function TerminalTabPillTitle({ state, t }: { state: TerminalState; t: TFunction }) {
  if (state.customTitle) return <>{state.customTitle}</>;
  const paneCount = collectPaneIds(state.layout).length;
  if (state.panes[state.activePaneId]?.title) return <>{state.panes[state.activePaneId].title}</>;
  if (paneCount > 1) return <>{t('rightSidebar.terminal.workbenchTitle', { count: paneCount })}</>;
  return <>{t('rightSidebar.terminal.defaultTitle')}</>;
}

function TerminalTabPillIcon() {
  return <TerminalIcon size={13} />;
}

const plugin: TabKindPlugin<TerminalState> = {
  kind: 'terminal',
  menu: {
    kind: 'terminal',
    labelKey: 'rightSidebar.tabs.kinds.terminal',
    icon: TerminalIcon,
    order: 30,
    enabled: true,
  },
  TabPillTitle: TerminalTabPillTitle,
  TabPillIcon: TerminalTabPillIcon,
  TabBody: TerminalTabBody,
  defaultState: () => createInitialTerminalState(),
  hydrateState: hydrateTerminalState,
  /** Closing the tab hides its view, retaining all panes and their PTYs. */
  onBeforeClose: async (rawState, ctx) => {
    const state = hydrateTerminalState(rawState);
    const paneIds = collectPaneIds(state.layout);
    await Promise.all(
      paneIds.map(async (paneId) => {
        const ptyId = state.panes[paneId].terminalId || terminalPtyId(ctx.tabId, paneId);
        try {
          await window.electronAPI.terminal.detach(ptyId);
        } catch {
          /* already disposed / app shutdown */
        }
      }),
    );
  },
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
