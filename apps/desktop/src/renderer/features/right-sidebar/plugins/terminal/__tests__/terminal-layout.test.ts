import { describe, expect, it } from 'vitest';

import {
  MAX_TERMINAL_PANES,
  clampSplitRatio,
  collectPaneIds,
  createInitialTerminalState,
  createPaneState,
  hydrateTerminalState,
  removeTerminalPane,
  setActiveTerminalPane,
  splitTerminalPane,
  updateTerminalPane,
} from '../terminal-layout';

describe('terminal layout model', () => {
  it('creates a single shell pane and splits/removes recursively', () => {
    const initial = createInitialTerminalState();
    const split = splitTerminalPane(
      initial,
      'pane-1',
      'vertical',
      createPaneState('pane-2', 'claude'),
    );

    expect(split).not.toBeNull();
    expect(collectPaneIds(split!.layout)).toEqual(['pane-1', 'pane-2']);
    expect(split!.activePaneId).toBe('pane-2');
    expect(split!.panes['pane-2'].profile).toBe('claude');

    const removed = removeTerminalPane(split!, 'pane-2');
    expect(removed).not.toBeNull();
    expect(collectPaneIds(removed!.layout)).toEqual(['pane-1']);
    expect(removed!.activePaneId).toBe('pane-1');
  });

  it('enforces pane count, duplicate ids, and unknown targets', () => {
    let state = createInitialTerminalState();
    for (let i = 2; i <= MAX_TERMINAL_PANES; i += 1) {
      const next = splitTerminalPane(
        state,
        state.activePaneId,
        'horizontal',
        createPaneState(`pane-${i}`),
      );
      expect(next).not.toBeNull();
      state = next!;
    }
    expect(collectPaneIds(state.layout)).toHaveLength(MAX_TERMINAL_PANES);
    expect(
      splitTerminalPane(state, state.activePaneId, 'horizontal', createPaneState('pane-overflow')),
    ).toBeNull();
    expect(
      splitTerminalPane(state, state.activePaneId, 'horizontal', createPaneState('pane-1')),
    ).toBeNull();
    expect(
      splitTerminalPane(state, 'missing', 'horizontal', createPaneState('another')),
    ).toBeNull();
    expect(removeTerminalPane(state, 'missing')).toBeNull();
    expect(removeTerminalPane(createInitialTerminalState(), 'pane-1')).toBeNull();
  });

  it('clamps invalid split ratios and ignores invalid active/update targets', () => {
    expect(clampSplitRatio(Number.NaN)).toBe(0.5);
    expect(clampSplitRatio(-1)).toBe(0.2);
    expect(clampSplitRatio(2)).toBe(0.8);

    const state = createInitialTerminalState();
    expect(setActiveTerminalPane(state, 'missing')).toBe(state);
    expect(updateTerminalPane(state, 'missing', { title: 'ignored' })).toBe(state);
    const updated = updateTerminalPane(state, 'pane-1', { title: 'Build', profile: 'codex' });
    expect(updated.panes['pane-1']).toMatchObject({ title: 'Build', profile: 'codex' });
  });

  it('hydrates valid layouts, resets process-local lifecycle, and migrates legacy tabs', () => {
    const raw = {
      version: 1,
      layout: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.95,
        first: { type: 'leaf', paneId: 'left' },
        second: { type: 'leaf', paneId: 'right' },
      },
      panes: {
        left: { profile: 'claude', title: 'Agent', created: true, exited: { code: 1 } },
        right: { profile: 'pi', shellId: 'bash', shellDisplayName: 'Bash' },
      },
      activePaneId: 'right',
    };
    const state = hydrateTerminalState(raw);
    expect(collectPaneIds(state.layout)).toEqual(['left', 'right']);
    expect(state.layout.type === 'split' ? state.layout.ratio : null).toBe(0.8);
    expect(state.activePaneId).toBe('right');
    expect(state.panes.left).toMatchObject({
      profile: 'claude',
      title: 'Agent',
      created: false,
      exited: null,
    });
    expect(state.panes.right.profile).toBe('pi');

    const legacy = hydrateTerminalState({
      title: 'Legacy',
      shellId: 'pwsh',
      shellDisplayName: 'PowerShell',
    });
    expect(legacy.panes[legacy.activePaneId]).toMatchObject({
      title: 'Legacy',
      shellId: 'pwsh',
      shellDisplayName: 'PowerShell',
      profile: 'shell',
    });
  });

  it('falls back safely for malformed or hostile persisted layouts', () => {
    expect(hydrateTerminalState(null)).toEqual(createInitialTerminalState());
    expect(
      hydrateTerminalState({ version: 1, layout: { type: 'leaf', paneId: '' }, panes: {} }),
    ).toEqual(createInitialTerminalState());
    expect(
      hydrateTerminalState({
        version: 1,
        layout: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', paneId: 'dup' },
          second: { type: 'leaf', paneId: 'dup' },
        },
        panes: { dup: { profile: 'shell' } },
      }),
    ).toEqual(createInitialTerminalState());
  });
});
