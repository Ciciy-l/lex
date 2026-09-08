import { addTab, closeTab, ensureHydrated, getBucket, patchTabState, setActiveTab } from '../store';
import {
  createInitialTerminalState,
  hydrateTerminalState,
  removeTerminalPane,
} from '../plugins/terminal/terminal-layout';
import { disposeXterm } from '../plugins/terminal/lib/xtermPool';
import { terminalPtyId } from '../plugins/terminal/terminalIdentity';
import type { ShellId, TerminalProfile } from '../../../../shared/terminal-bridge';

export async function launchTerminal(
  sessionId: string,
  cwd: string,
  profile: TerminalProfile,
  shellPref?: ShellId,
) {
  await ensureHydrated(sessionId);
  const state = createInitialTerminalState(profile);
  state.cwd = cwd;
  if (shellPref !== undefined) state.panes[state.activePaneId].shellPref = shellPref;
  state.panes[state.activePaneId].terminalId = crypto.randomUUID();
  return addTab(sessionId, 'terminal', state);
}

const opening = new Map<string, Promise<void>>();

/** Remove only an ended pane; never dispose its running split siblings. */
export async function forgetTerminal(sessionId: string, terminalId: string): Promise<void> {
  const record = (await window.electronAPI.terminal.list(sessionId)).find(
    (row) => row.terminalId === terminalId,
  );
  if (record && (record.status === 'running' || record.status === 'terminating'))
    throw new Error('TERMINAL_STILL_RUNNING');
  // Main rechecks the real runtime atomically. Only mutate saved views after this succeeds.
  await window.electronAPI.terminal.forget(terminalId);
  await removeTerminalViews(sessionId, terminalId);
}

/** Both trash buttons use the same exit-confirmed Main operation. */
export async function destroyTerminal(sessionId: string, terminalId: string): Promise<void> {
  await ensureHydrated(sessionId);
  await window.electronAPI.terminal.destroy(terminalId);
  await removeTerminalViews(sessionId, terminalId);
}

async function removeTerminalViews(sessionId: string, terminalId: string): Promise<void> {
  for (const tab of getBucket(sessionId).tabs) {
    if (tab.kind !== 'terminal') continue;
    const state = hydrateTerminalState(tab.state);
    const pane = Object.values(state.panes).find(
      (item) => (item.terminalId || terminalPtyId(tab.id, item.id)) === terminalId,
    );
    if (!pane) continue;
    const next = removeTerminalPane(state, pane.id);
    if (next) await patchTabState(sessionId, tab.id, () => next);
    else await closeTab(sessionId, tab.id, { skipBeforeClose: true });
  }
  disposeXterm(terminalId);
}

/** Find an existing split before opening a view. Never start a new CLI here. */
export function openOrFocusTerminal(sessionId: string, terminalId: string): Promise<void> {
  const key = JSON.stringify([sessionId, terminalId]);
  const pending = opening.get(key);
  if (pending) return pending;
  const run = (async () => {
    await ensureHydrated(sessionId);
    const record = (await window.electronAPI.terminal.list(sessionId)).find(
      (runtime) => runtime.terminalId === terminalId,
    );
    for (const tab of getBucket(sessionId).tabs) {
      if (tab.kind !== 'terminal') continue;
      const state = hydrateTerminalState(tab.state);
      const pane = Object.values(state.panes).find(
        (candidate) => (candidate.terminalId || terminalPtyId(tab.id, candidate.id)) === terminalId,
      );
      if (!pane) continue;
      if (record)
        await window.electronAPI.terminal.create({
          id: terminalId,
          sessionId,
          cwd: record.cwd,
          profile: record.profile,
          attachOnly: true,
        });
      await patchTabState(sessionId, tab.id, (current) => {
        const saved = hydrateTerminalState(current);
        return {
          ...saved,
          viewHidden: false,
          activePaneId: pane.id,
          panes: Object.fromEntries(
            Object.entries(saved.panes).map(([id, value]) => [
              id,
              id === pane.id ? { ...value, viewHidden: false, runtimeStarted: true } : value,
            ]),
          ),
        };
      });
      await setActiveTab(sessionId, tab.id);
      return;
    }
    if (!record) throw new Error('TERMINAL_NOT_FOUND');
    const state = createInitialTerminalState(record.profile);
    state.cwd = record.cwd;
    Object.assign(state.panes[state.activePaneId], {
      terminalId,
      runtimeStarted: true,
      title: record.title,
    });
    await addTab(sessionId, 'terminal', state);
  })();
  opening.set(key, run);
  void run.finally(() => opening.delete(key)).catch(() => undefined);
  return run;
}
