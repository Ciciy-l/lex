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
  /** Release every pane's PTY and xterm instance when the tab is really closed. */
  onBeforeClose: async (rawState, ctx) => {
    const state = hydrateTerminalState(rawState);
    const { disposeXterm } = await import('./lib/xtermPool');
    const paneIds = collectPaneIds(state.layout);
    await Promise.all(
      paneIds.map(async (paneId) => {
        const ptyId = terminalPtyId(ctx.tabId, paneId);
        try {
          await window.electronAPI.terminal.dispose(ptyId);
        } catch {
          /* already disposed / app shutdown */
        }
        disposeXterm(ptyId);
      }),
    );
    // Pre-workbench tabs used the tab id directly. Keep this one-shot cleanup
    // for users upgrading from that schema.
    try {
      await window.electronAPI.terminal.dispose(ctx.tabId);
    } catch {
      /* no legacy session */
    }
    disposeXterm(ctx.tabId);
  },
};

export function terminalPtyId(tabId: string, paneId: string): string {
  return `${tabId}:${paneId}`;
}

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
