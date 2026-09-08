// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabState } from '../../types';
import {
  createInitialTerminalState,
  createPaneState,
  hydrateTerminalState,
  hideTerminalPane,
  visibleTerminalPaneIds,
  splitTerminalPane,
} from '../../plugins/terminal/terminal-layout';

const mocks = vi.hoisted(() => ({
  tabs: [] as TabState[],
  active: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  dispose: vi.fn(),
  destroy: vi.fn(),
  close: vi.fn(),
  add: vi.fn(),
  patch: vi.fn(),
  disposeXterm: vi.fn(),
}));
vi.mock('../../store', () => ({
  ensureHydrated: vi.fn(async () => undefined),
  getBucket: () => ({ tabs: mocks.tabs }),
  setActiveTab: mocks.active,
  addTab: mocks.add,
  patchTabState: mocks.patch,
  closeTab: mocks.close,
}));
vi.mock('../../plugins/terminal/lib/xtermPool', () => ({ disposeXterm: mocks.disposeXterm }));
import { openFileContentTab, keepFileContentTab, protectFilePreview } from '../openFileContentTab';
import { openOrFocusTerminal, forgetTerminal, launchTerminal, destroyTerminal } from '../terminalNavigation';
import { cliSessionItems, cliSessionGroups } from '../cliSessionItems';
import { workspaceSurface } from '../../../../../shared/workspaceSurface';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tabs = [];
  mocks.list.mockResolvedValue([]);
  mocks.create.mockResolvedValue({});
  mocks.dispose.mockResolvedValue(undefined);
  mocks.destroy.mockResolvedValue(undefined);
  mocks.add.mockImplementation(async (_session, kind, state) => {
    const tab = { id: 'tab-' + mocks.tabs.length, kind, state };
    mocks.tabs.push(tab);
    return tab;
  });
  mocks.patch.mockImplementation(async (_session, id, patch) => {
    const tab = mocks.tabs.find((item) => item.id === id)!;
    tab.state = patch(tab.state);
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      terminal: {
        list: mocks.list,
        create: mocks.create,
        forget: mocks.dispose,
        destroy: mocks.destroy,
      },
    },
  });
});

describe('workspace content navigation', () => {
  it('keeps views until destruction succeeds, then removes only the selected split', async () => {
    hiddenSplit();
    const saved = mocks.tabs[0].state;
    mocks.destroy.mockRejectedValueOnce(new Error('kill failed'));
    await expect(destroyTerminal('lead', 'pty-a')).rejects.toThrow('kill failed');
    expect(mocks.tabs[0].state).toBe(saved);
    expect(mocks.disposeXterm).not.toHaveBeenCalled();
    await destroyTerminal('lead', 'pty-a');
    expect(mocks.tabs[0].state).toMatchObject({ layout: { type: 'leaf', paneId: 'pane-2' } });
    expect(mocks.close).not.toHaveBeenCalled();
    await destroyTerminal('lead', 'pty-b');
    expect(mocks.close).toHaveBeenCalledWith('lead', 'original', { skipBeforeClose: true });
    expect(mocks.dispose).not.toHaveBeenCalled();
  });

  it('hides the last visible pane and restores the same tab and original layout', async () => {
    const original = hiddenSplit();
    let next = hideTerminalPane(original, 'pane-1')!;
    next = hideTerminalPane(next, 'pane-2')!;
    expect(next.viewHidden).toBe(true);
    expect(visibleTerminalPaneIds(next)).toEqual([]);
    mocks.tabs[0].state = next;
    await openOrFocusTerminal('lead', 'pty-a');
    expect(mocks.tabs[0].state).toMatchObject({ viewHidden: false, layout: original.layout });
    expect(visibleTerminalPaneIds(hydrateTerminalState(mocks.tabs[0].state))).toEqual(['pane-1']);
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.destroy).not.toHaveBeenCalled();
  });
  it('replaces one clean preview in place, serializes rapid opens and keeps explicit opens permanent', async () => {
    const file = { path: 'a.ts', workdir: '/project', external: false, preview: true };
    const ids = await Promise.all(['a.ts', 'b.ts', 'c.ts'].map(path => openFileContentTab('preview-lead', { ...file, path })));
    expect(new Set(ids).size).toBe(1);
    expect(mocks.tabs).toHaveLength(1);
    expect(mocks.tabs[0].state).toMatchObject({ path: 'c.ts', preview: true });
    await keepFileContentTab('preview-lead', ids[0]);
    await openFileContentTab('preview-lead', { ...file, path: 'c.ts' });
    expect(mocks.tabs[0].state).toMatchObject({ preview: false });
    await openFileContentTab('preview-lead', file);
    expect(mocks.tabs).toHaveLength(2);
  });

  it('protects a draft synchronously before its permanent state is persisted', async () => {
    const file = { path: 'a.ts', workdir: '/project', external: false, preview: true };
    const id = await openFileContentTab('draft-lead', file);
    const release = protectFilePreview('draft-lead', id);
    try {
      await openFileContentTab('draft-lead', { ...file, path: 'b.ts' });
      expect(mocks.tabs).toHaveLength(2);
      expect(mocks.tabs[0].state).toMatchObject({ path: 'a.ts' });
    } finally { release(); }
  });

  it('groups panes by original tab and keeps custom names above runtime defaults', () => {
    const state = hiddenSplit();
    state.customTitle = 'Build'; state.panes['pane-1'].title = 'Tests';
    const runtime = { terminalId: 'pty-a', sessionId: 'lead', title: 'Shell', profile: 'shell' as const, cwd: '/project', status: 'running' as const, detached: true, pid: 1, exit: null };
    const groups = cliSessionGroups('lead', mocks.tabs, [runtime, { ...runtime, terminalId: 'unplaced' }]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ id: 'original', title: 'Build', items: [{ terminalId: 'pty-a', title: 'Tests' }, { terminalId: 'pty-b' }] });
    expect(groups[1]).toMatchObject({ unplaced: true, items: [{ terminalId: 'unplaced' }] });
  });
  it('opens a new content tab per CLI and preserves the selected shell through hydration', async () => {
    const shellTab = await launchTerminal('lead', '/project', 'shell', 'gitbash');
    const shellState = hydrateTerminalState(shellTab.state);
    expect(shellTab.kind).toBe('terminal');
    expect(shellState.cwd).toBe('/project');
    expect(shellState.panes[shellState.activePaneId]).toMatchObject({
      profile: 'shell',
      shellPref: 'gitbash',
    });
    const agentTab = await launchTerminal('lead', '/project', 'codex');
    const agentState = hydrateTerminalState(agentTab.state);
    expect(agentState.panes[agentState.activePaneId]).toMatchObject({ profile: 'codex' });
    expect(agentState.panes[agentState.activePaneId].shellPref).toBeUndefined();
    expect(agentTab.id).not.toBe(shellTab.id);
    expect(agentState.panes[agentState.activePaneId].terminalId).not.toBe(
      shellState.panes[shellState.activePaneId].terminalId,
    );
    expect(mocks.create).not.toHaveBeenCalled(); // The existing terminal body owns the PTY launch.
  });

  it('keeps only tree and background lists in tools, and all actual views in existing content tabs', () => {
    expect(['file-browser', 'background-tasks'].map(workspaceSurface)).toEqual(['tool', 'tool']);
    expect(
      ['terminal', 'file-content', 'orca-workers', 'review', 'web-browser'].map(workspaceSurface),
    ).toEqual(Array(5).fill('content'));
  });

  it('deduplicates concurrent file opens but keeps distinct files and source endpoints separate', async () => {
    const file = {
      path: 'src/index.ts',
      workdir: '/project',
      external: false,
      remoteHostId: null,
      deviceId: null,
    };
    const [first, second] = await Promise.all([
      openFileContentTab('lead', file),
      openFileContentTab('lead', file),
    ]);
    expect(first).toBe(second);
    expect(mocks.add).toHaveBeenCalledOnce();
    expect(await openFileContentTab('lead', file)).toBe(first);
    expect(mocks.active).toHaveBeenLastCalledWith('lead', first);
    await openFileContentTab('lead', { ...file, path: 'README.md' });
    await openFileContentTab('lead', { ...file, remoteHostId: 'host-b' });
    await openFileContentTab('lead', { ...file, deviceId: 'device-b' });
    expect(mocks.tabs).toHaveLength(4);
    expect(mocks.tabs.every((tab) => tab.kind === 'file-content')).toBe(true);
  });
});

function hiddenSplit() {
  const state = splitTerminalPane(
    createInitialTerminalState(),
    'pane-1',
    'horizontal',
    createPaneState('pane-2'),
  )!;
  state.viewHidden = true;
  state.panes['pane-1'].terminalId = 'pty-a';
  state.panes['pane-2'].terminalId = 'pty-b';
  mocks.tabs = [{ id: 'original', kind: 'terminal', state }];
  return state;
}

describe('CLI view restoration', () => {
  it('restores an individually hidden pane into its original tab and exact split slot', async () => {
    const original = hiddenSplit();
    original.viewHidden = false;
    if (original.layout.type === 'split') original.layout.ratio = 0.68;
    mocks.tabs[0].state = hideTerminalPane(original, 'pane-2');
    const persisted = hydrateTerminalState(mocks.tabs[0].state);
    expect(visibleTerminalPaneIds(persisted)).toEqual(['pane-1']);
    expect(cliSessionGroups('lead', mocks.tabs, [])[0].items).toMatchObject([
      { terminalId: 'pty-a', detached: false }, { terminalId: 'pty-b', detached: true },
    ]);
    const sibling = persisted.panes['pane-1'];
    mocks.list.mockResolvedValue([{ terminalId: 'pty-b', sessionId: 'lead', cwd: '/project', profile: 'shell', status: 'running' }]);
    await openOrFocusTerminal('lead', 'pty-b');
    const restored = hydrateTerminalState(mocks.tabs[0].state);
    expect(restored.layout).toEqual(original.layout);
    expect(visibleTerminalPaneIds(restored)).toEqual(['pane-1', 'pane-2']);
    expect(restored.activePaneId).toBe('pane-2');
    expect(restored.panes['pane-1']).toEqual(sibling);
    expect(mocks.active).toHaveBeenCalledWith('lead', 'original');
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'pty-b', attachOnly: true }));
    expect(mocks.dispose).not.toHaveBeenCalled();
  });
  it('focuses the original split pane without creating a tab or a replacement process', async () => {
    const original = hiddenSplit();
    mocks.list.mockResolvedValue([
      {
        terminalId: 'pty-b',
        sessionId: 'lead',
        profile: 'shell',
        cwd: '/project',
        status: 'running',
      },
    ]);
    await Promise.all([openOrFocusTerminal('lead', 'pty-b'), openOrFocusTerminal('lead', 'pty-b')]);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pty-b', attachOnly: true, sessionId: 'lead' }),
    );
    expect(mocks.tabs[0].state).toMatchObject({
      viewHidden: false,
      activePaneId: 'pane-2',
      layout: original.layout,
    });
    expect(mocks.active).toHaveBeenCalledWith('lead', 'original');
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.dispose).not.toHaveBeenCalled();
  });

  it('restores a saved view without rewriting sibling pane runtime state', async () => {
    hiddenSplit();
    const first = mocks.tabs[0].state as ReturnType<typeof hiddenSplit>;
    first.panes['pane-1'].runtimeStarted = true;
    await openOrFocusTerminal('lead', 'pty-b');
    expect(mocks.tabs[0].state).toMatchObject({
      viewHidden: false,
      panes: { 'pane-1': { runtimeStarted: true }, 'pane-2': { runtimeStarted: true } },
    });
    expect(mocks.create).not.toHaveBeenCalled();
    await expect(openOrFocusTerminal('lead', 'unknown')).rejects.toThrow('TERMINAL_NOT_FOUND');
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it('lists hidden views even without running processes and never treats another Lead as its runtime', () => {
    hiddenSplit();
    const rows = cliSessionItems('lead', mocks.tabs, []);
    expect(rows.map((row) => [row.terminalId, row.status, row.detached])).toEqual([
      ['pty-a', 'missing', true],
      ['pty-b', 'missing', true],
    ]);
  });

  it('refuses to forget a running pane and removes only the ended pane from a split', async () => {
    hiddenSplit();
    mocks.list.mockResolvedValueOnce([{ terminalId: 'pty-a', status: 'running' }]);
    await expect(forgetTerminal('lead', 'pty-a')).rejects.toThrow('TERMINAL_STILL_RUNNING');
    expect(mocks.dispose).not.toHaveBeenCalled();
    mocks.list.mockResolvedValueOnce([{ terminalId: 'pty-a', status: 'exited' }]);
    await forgetTerminal('lead', 'pty-a');
    expect(mocks.tabs[0].state).toMatchObject({ layout: { type: 'leaf', paneId: 'pane-2' } });
    expect(mocks.dispose).toHaveBeenCalledExactlyOnceWith('pty-a');
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it('keeps saved split views when Main rejects forgetting a concurrently restarted runtime', async () => {
    hiddenSplit();
    const saved = mocks.tabs[0].state;
    mocks.list.mockResolvedValueOnce([{ terminalId: 'pty-a', status: 'exited' }]);
    mocks.dispose.mockRejectedValueOnce(new Error('PRECONDITION_FAILED'));
    await expect(forgetTerminal('lead', 'pty-a')).rejects.toThrow('PRECONDITION_FAILED');
    expect(mocks.tabs[0].state).toBe(saved);
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.disposeXterm).not.toHaveBeenCalled();
  });
});
