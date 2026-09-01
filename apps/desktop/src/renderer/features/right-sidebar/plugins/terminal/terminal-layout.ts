import type { TerminalExitInfo, TerminalProfile } from '../../../../../shared/terminal-bridge';

export type { TerminalProfile } from '../../../../../shared/terminal-bridge';

/** Persisted layout schema for the CLI workbench. */
export const TERMINAL_LAYOUT_VERSION = 1 as const;
export const MAX_TERMINAL_PANES = 8;
export const MIN_SPLIT_RATIO = 0.2;
export const MAX_SPLIT_RATIO = 0.8;

export type TerminalSplitDirection = 'horizontal' | 'vertical';

export interface TerminalPaneState {
  id: string;
  profile: TerminalProfile;
  /** Empty means use the profile's default display name. */
  title: string;
  /** Runtime lifecycle snapshot. The first create/attach reconciles it with Main. */
  created: boolean;
  exited: TerminalExitInfo | null;
  shellId: string;
  shellDisplayName: string;
}

export interface TerminalLayoutLeaf {
  type: 'leaf';
  paneId: string;
}

export interface TerminalLayoutSplit {
  type: 'split';
  direction: TerminalSplitDirection;
  /** Fraction assigned to the first child, clamped to [0.2, 0.8]. */
  ratio: number;
  first: TerminalLayoutNode;
  second: TerminalLayoutNode;
}

export type TerminalLayoutNode = TerminalLayoutLeaf | TerminalLayoutSplit;

export interface TerminalState {
  version: typeof TERMINAL_LAYOUT_VERSION;
  layout: TerminalLayoutNode;
  panes: Record<string, TerminalPaneState>;
  activePaneId: string;
}

const DEFAULT_PANE_ID = 'pane-1';

export function createPaneState(id: string, profile: TerminalProfile = 'shell'): TerminalPaneState {
  return {
    id,
    profile,
    title: '',
    created: false,
    exited: null,
    shellId: '',
    shellDisplayName: '',
  };
}

export function createInitialTerminalState(profile: TerminalProfile = 'shell'): TerminalState {
  const pane = createPaneState(DEFAULT_PANE_ID, profile);
  return {
    version: TERMINAL_LAYOUT_VERSION,
    layout: { type: 'leaf', paneId: pane.id },
    panes: { [pane.id]: pane },
    activePaneId: pane.id,
  };
}

/** Return all leaves in visual order. */
export function collectPaneIds(node: TerminalLayoutNode): string[] {
  if (node.type === 'leaf') return [node.paneId];
  return [...collectPaneIds(node.first), ...collectPaneIds(node.second)];
}

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, ratio));
}

/**
 * Split one leaf and add a pane next to it. The caller owns id generation so this
 * function remains deterministic and easy to test.
 */
export function splitTerminalPane(
  state: TerminalState,
  targetPaneId: string,
  direction: TerminalSplitDirection,
  newPane: TerminalPaneState,
): TerminalState | null {
  if (!state.panes[targetPaneId]) return null;
  if (state.panes[newPane.id] || collectPaneIds(state.layout).length >= MAX_TERMINAL_PANES) {
    return null;
  }
  const replaced = replaceLeaf(state.layout, targetPaneId, {
    type: 'split',
    direction,
    ratio: 0.5,
    first: { type: 'leaf', paneId: targetPaneId },
    second: { type: 'leaf', paneId: newPane.id },
  });
  if (!replaced) return null;
  return {
    ...state,
    layout: replaced,
    panes: { ...state.panes, [newPane.id]: newPane },
    activePaneId: newPane.id,
  };
}

/** Remove a pane and collapse its now-empty split ancestor. */
export function removeTerminalPane(state: TerminalState, paneId: string): TerminalState | null {
  if (!state.panes[paneId] || collectPaneIds(state.layout).length <= 1) return null;
  const nextLayout = removeLeaf(state.layout, paneId);
  if (!nextLayout) return null;
  const panes = { ...state.panes };
  delete panes[paneId];
  const nextActive =
    state.activePaneId === paneId ? (collectPaneIds(nextLayout)[0] ?? '') : state.activePaneId;
  return { ...state, layout: nextLayout, panes, activePaneId: nextActive };
}

export function setActiveTerminalPane(state: TerminalState, paneId: string): TerminalState {
  return state.panes[paneId] ? { ...state, activePaneId: paneId } : state;
}

export function updateTerminalPane(
  state: TerminalState,
  paneId: string,
  patch: Partial<Omit<TerminalPaneState, 'id'>>,
): TerminalState {
  const current = state.panes[paneId];
  if (!current) return state;
  return {
    ...state,
    panes: { ...state.panes, [paneId]: { ...current, ...patch, id: paneId } },
  };
}

/**
 * Normalize persisted state and old v0 terminal tabs. A persisted runtime flag
 * is only a hint; the pane always performs an idempotent create/attach against
 * the current main process and reconciles the returned lifecycle.
 */
export function hydrateTerminalState(raw: unknown): TerminalState {
  if (!raw || typeof raw !== 'object') return createInitialTerminalState();
  const obj = raw as Record<string, unknown>;
  const parsed = isStateShape(obj) ? parsePersistedLayout(obj.layout) : null;
  if (parsed) {
    const ids = parsed.ids;
    const panes: Record<string, TerminalPaneState> = {};
    for (const id of ids) {
      const source = (obj.panes as Record<string, unknown>)[id];
      panes[id] = normalizePane(source, id);
    }
    if (Object.keys(panes).length > 0) {
      const layout = pruneUnknownLeaves(parsed.layout, new Set(Object.keys(panes)));
      const finalLayout = layout ?? { type: 'leaf', paneId: Object.keys(panes)[0] };
      const finalIds = collectPaneIds(finalLayout);
      const finalPanes: Record<string, TerminalPaneState> = {};
      for (const id of finalIds) finalPanes[id] = panes[id];
      const requestedActive = typeof obj.activePaneId === 'string' ? obj.activePaneId : '';
      return {
        version: TERMINAL_LAYOUT_VERSION,
        layout: finalLayout,
        panes: finalPanes,
        activePaneId: finalPanes[requestedActive] ? requestedActive : finalIds[0],
      };
    }
  }

  // Tabs created by the original single-PTY terminal plugin become one shell pane.
  const legacy = createInitialTerminalState();
  const legacyPane = legacy.panes[legacy.activePaneId];
  legacyPane.title = typeof obj.title === 'string' ? obj.title : '';
  legacyPane.shellId = typeof obj.shellId === 'string' ? obj.shellId : '';
  legacyPane.shellDisplayName =
    typeof obj.shellDisplayName === 'string' ? obj.shellDisplayName : '';
  return legacy;
}

function isStateShape(obj: Record<string, unknown>): boolean {
  return (
    obj.version === TERMINAL_LAYOUT_VERSION &&
    obj.layout !== null &&
    typeof obj.layout === 'object' &&
    obj.panes !== null &&
    typeof obj.panes === 'object' &&
    !Array.isArray(obj.panes)
  );
}

/**
 * Parse the recursive layout defensively. Terminal state is persisted in the
 * local database and may outlive a schema change or be edited by an older
 * build; never let malformed data throw during renderer hydration. Besides
 * validating the shape, this enforces a bounded, duplicate-free leaf set so a
 * corrupted tree cannot create unbounded React/xterm instances.
 */
function parsePersistedLayout(raw: unknown): { layout: TerminalLayoutNode; ids: string[] } | null {
  const ids: string[] = [];
  const seen = new Set<string>();

  const visit = (value: unknown, depth: number): TerminalLayoutNode | null => {
    if (depth > MAX_TERMINAL_PANES * 2) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const obj = value as Record<string, unknown>;
    if (obj.type === 'leaf') {
      if (typeof obj.paneId !== 'string' || !isSafePaneId(obj.paneId)) return null;
      if (seen.has(obj.paneId) || ids.length >= MAX_TERMINAL_PANES) return null;
      seen.add(obj.paneId);
      ids.push(obj.paneId);
      return { type: 'leaf', paneId: obj.paneId };
    }
    if (obj.type !== 'split') return null;
    const direction = obj.direction;
    if (direction !== 'horizontal' && direction !== 'vertical') return null;
    const first = visit(obj.first, depth + 1);
    if (!first) return null;
    const second = visit(obj.second, depth + 1);
    if (!second) return null;
    const ratio = typeof obj.ratio === 'number' ? clampSplitRatio(obj.ratio) : 0.5;
    return { type: 'split', direction, ratio, first, second };
  };

  const layout = visit(raw, 0);
  return layout && ids.length > 0 ? { layout, ids } : null;
}

function isSafePaneId(value: string): boolean {
  // IDs are generated in the renderer, but persisted values still need a
  // modest bound to avoid giant keys or control characters in DOM attributes.
  if (value === '__proto__' || value === 'constructor' || value === 'prototype') return false;
  if (value.length === 0 || value.length > 128) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function normalizePane(raw: unknown, id: string): TerminalPaneState {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const profile = isProfile(obj.profile) ? obj.profile : 'shell';
  return {
    ...createPaneState(id, profile),
    title: typeof obj.title === 'string' ? obj.title.slice(0, 120) : '',
    shellId: typeof obj.shellId === 'string' ? obj.shellId : '',
    shellDisplayName: typeof obj.shellDisplayName === 'string' ? obj.shellDisplayName : '',
    // PTYs are process-local. Persisted lifecycle flags may describe a
    // previous app process, so hydration must always perform an idempotent
    // create/attach against Main before presenting a pane as live.
    created: false,
    exited: null,
  };
}

function isProfile(value: unknown): value is TerminalProfile {
  return value === 'shell' || value === 'claude' || value === 'codex' || value === 'pi';
}

function replaceLeaf(
  node: TerminalLayoutNode,
  paneId: string,
  replacement: TerminalLayoutNode,
): TerminalLayoutNode | null {
  if (node.type === 'leaf') return node.paneId === paneId ? replacement : node;
  const first = replaceLeaf(node.first, paneId, replacement);
  const second = replaceLeaf(node.second, paneId, replacement);
  if (!first || !second) return null;
  return { ...node, first, second };
}

function removeLeaf(node: TerminalLayoutNode, paneId: string): TerminalLayoutNode | null {
  if (node.type === 'leaf') return node.paneId === paneId ? null : node;
  if (node.first.type === 'leaf' && node.first.paneId === paneId) return node.second;
  if (node.second.type === 'leaf' && node.second.paneId === paneId) return node.first;
  const first = removeLeaf(node.first, paneId);
  const second = removeLeaf(node.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function pruneUnknownLeaves(
  node: TerminalLayoutNode,
  known: Set<string>,
): TerminalLayoutNode | null {
  if (node.type === 'leaf') return known.has(node.paneId) ? node : null;
  const first = pruneUnknownLeaves(node.first, known);
  const second = pruneUnknownLeaves(node.second, known);
  if (!first) return second;
  if (!second) return first;
  return { ...node, ratio: clampSplitRatio(node.ratio), first, second };
}
