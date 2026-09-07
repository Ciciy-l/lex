import type { TerminalRuntimeRecord } from '../../../../shared/terminal-bridge';
import type { TabState } from '../types';
import { collectPaneIds, hydrateTerminalState } from '../plugins/terminal/terminal-layout';
import { terminalPtyId } from '../plugins/terminal/terminalIdentity';

export type CliSessionItem = Omit<TerminalRuntimeRecord, 'status'> & {
  status: TerminalRuntimeRecord['status'] | 'missing';
};

/** Runtime truth plus saved views: a missing process remains discoverable, not restarted. */
export function cliSessionItems(
  sessionId: string,
  tabs: TabState[],
  runtimes: TerminalRuntimeRecord[],
): CliSessionItem[] {
  const items = new Map<string, CliSessionItem>(
    runtimes.filter((r) => r.sessionId === sessionId).map((r) => [r.terminalId, r]),
  );
  for (const tab of tabs) {
    if (tab.kind !== 'terminal') continue;
    const state = hydrateTerminalState(tab.state);
    for (const pane of Object.values(state.panes)) {
      const terminalId = pane.terminalId || terminalPtyId(tab.id, pane.id);
      const runtime = items.get(terminalId);
      items.set(terminalId, {
        terminalId,
        sessionId,
        profile: pane.profile,
        cwd: state.cwd || '',
        status: 'missing',
        pid: 0,
        exit: null,
        ...runtime,
        title: pane.title || runtime?.title || pane.shellDisplayName || pane.profile,
        detached: state.viewHidden === true || pane.viewHidden === true,
      });
    }
  }
  return [...items.values()];
}

export interface CliSessionGroup {
  id: string;
  title?: string;
  unplaced: boolean;
  items: CliSessionItem[];
}

export function cliSessionGroups(sessionId: string, tabs: TabState[], runtimes: TerminalRuntimeRecord[]): CliSessionGroup[] {
  const remaining = new Map(cliSessionItems(sessionId, tabs, runtimes).map(item => [item.terminalId, item]));
  const groups: CliSessionGroup[] = [];
  for (const tab of tabs) {
    if (tab.kind !== 'terminal') continue;
    const state = hydrateTerminalState(tab.state);
    const items: CliSessionItem[] = [];
    for (const paneId of collectPaneIds(state.layout)) {
      const pane = state.panes[paneId];
      const id = pane.terminalId || terminalPtyId(tab.id, pane.id);
      const item = remaining.get(id);
      if (item) { items.push(item); remaining.delete(id); }
    }
    if (items.length) groups.push({ id: tab.id, title: state.customTitle, unplaced: false, items });
  }
  if (remaining.size) groups.push({ id: 'unplaced', unplaced: true, items: [...remaining.values()] });
  return groups;
}
