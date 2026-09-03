/** Terminal workbench body: independent xterm/PTY panes with recursive splits. */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  ArrowLeftRight,
  ArrowUpDown,
  Bot,
  Circle,
  Plus,
  RotateCw,
  Terminal as TerminalIcon,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { extractIpcError } from '@/utils/ipcError';
import type { TabKindHostContext } from '../../types';
import { disposeXterm, getOrCreateXterm, type XtermEntry } from './lib/xtermPool';
import {
  MAX_TERMINAL_PANES,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  clampSplitRatio,
  collectPaneIds,
  createPaneState,
  removeTerminalPane,
  setActiveTerminalPane,
  splitTerminalPane,
  updateTerminalSplitRatio,
  updateTerminalPane,
  type TerminalLayoutNode,
  type TerminalPaneState,
  type TerminalProfile,
  type TerminalSplitPath,
  type TerminalState,
} from './terminal-layout';
import { terminalPtyId } from './index';
import type { TerminalDataEvent, TerminalExitEvent } from '../../../../../shared/terminal-bridge';

interface Props {
  state: TerminalState;
  ctx: TabKindHostContext;
  active?: boolean;
}

interface RuntimeError {
  key: string;
  detail: string;
}

const PROFILES: Array<{ id: TerminalProfile; labelKey: string }> = [
  { id: 'shell', labelKey: 'rightSidebar.terminal.profileShell' },
  { id: 'claude', labelKey: 'rightSidebar.terminal.profileClaude' },
  { id: 'codex', labelKey: 'rightSidebar.terminal.profileCodex' },
  { id: 'pi', labelKey: 'rightSidebar.terminal.profilePi' },
];

const ROOT_SPLIT_PATH: TerminalSplitPath = [];
const SPLIT_GUTTER_PX = 6;
const KEYBOARD_RESIZE_STEP = 0.05;

export function TerminalTabBody({ state, ctx, active }: Props) {
  const { tabId, workdir, patchState } = ctx;
  const { t } = useTranslation();
  // A failed create/restart belongs to one pane.  Keeping this keyed by pane
  // id prevents an error from pane A being shown after the user focuses pane B.
  const [runtimeErrors, setRuntimeErrors] = useState<Record<string, RuntimeError>>({});
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const nextIdRef = useRef(2);
  const stateRef = useRef(state);
  stateRef.current = state;

  const paneIds = useMemo(() => collectPaneIds(state.layout), [state.layout]);
  const canSplit = paneIds.length < MAX_TERMINAL_PANES;
  const activePane = state.panes[state.activePaneId] ?? state.panes[paneIds[0]];

  // Keep ids unique even when restoring a layout created in another renderer.
  useEffect(() => {
    const max = paneIds.reduce((found, id) => {
      const n = Number(id.match(/pane-(\d+)/)?.[1] ?? 0);
      return Math.max(found, n);
    }, 0);
    nextIdRef.current = Math.max(nextIdRef.current, max + 1);
  }, [paneIds]);

  const persist = useCallback(
    (next: TerminalState) => {
      stateRef.current = next;
      patchState(next);
    },
    [patchState],
  );

  const patchPane = useCallback(
    (paneId: string, patch: Partial<Omit<TerminalPaneState, 'id'>>) => {
      persist(updateTerminalPane(stateRef.current, paneId, patch));
    },
    [persist],
  );

  const setPaneRuntimeError = useCallback((paneId: string, error: RuntimeError | null) => {
    setRuntimeErrors((current) => {
      if (error == null) {
        if (!(paneId in current)) return current;
        const next = { ...current };
        delete next[paneId];
        return next;
      }
      if (current[paneId]?.key === error.key && current[paneId]?.detail === error.detail) {
        return current;
      }
      return { ...current, [paneId]: error };
    });
  }, []);

  const closeAgentMenu = useCallback((restoreFocus = true) => {
    setMenuOpen(false);
    if (restoreFocus) menuButtonRef.current?.focus();
  }, []);

  // The agent menu is an interactive popover rather than a passive div:
  // clicking elsewhere or pressing Escape closes it, and focus returns to the
  // trigger when it was closed from inside the menu.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || menuButtonRef.current?.contains(target)) return;
      closeAgentMenu(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeAgentMenu();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [closeAgentMenu, menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const frame = requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')
        ?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [menuOpen]);

  useEffect(() => {
    if (menuOpen) return;
    // If a menu item had focus, put keyboard users back on the trigger after
    // React removes the menu from the tree.  Do not steal focus from a click
    // elsewhere in the workbench.
    const active = document.activeElement;
    if (menuRef.current?.contains(active)) menuButtonRef.current?.focus();
  }, [menuOpen]);

  const createSplit = useCallback(
    (direction: 'horizontal' | 'vertical', profile: TerminalProfile = 'shell') => {
      if (collectPaneIds(stateRef.current.layout).length >= MAX_TERMINAL_PANES) return;
      const id = `pane-${nextIdRef.current++}`;
      const current = stateRef.current;
      const next = splitTerminalPane(
        current,
        current.activePaneId,
        direction,
        createPaneState(id, profile),
      );
      if (next) persist(next);
      closeAgentMenu();
    },
    [closeAgentMenu, persist],
  );

  const createProfilePane = useCallback(
    (profile: TerminalProfile) => {
      if (collectPaneIds(stateRef.current.layout).length >= MAX_TERMINAL_PANES) return;
      const id = `pane-${nextIdRef.current++}`;
      const current = stateRef.current;
      const next = splitTerminalPane(
        current,
        current.activePaneId,
        'horizontal',
        createPaneState(id, profile),
      );
      if (next) persist(next);
      closeAgentMenu();
    },
    [closeAgentMenu, persist],
  );

  const closePane = useCallback(
    (paneId: string) => {
      const next = removeTerminalPane(stateRef.current, paneId);
      if (!next) return;
      const ptyId = terminalPtyId(tabId, paneId);
      void disposePty(ptyId);
      disposeXterm(ptyId);
      setPaneRuntimeError(paneId, null);
      persist(next);
    },
    [persist, setPaneRuntimeError, tabId],
  );

  const selectPane = useCallback(
    (paneId: string) => persist(setActiveTerminalPane(stateRef.current, paneId)),
    [persist],
  );

  const commitSplitRatio = useCallback(
    (path: TerminalSplitPath, ratio: number) => {
      const current = stateRef.current;
      const next = updateTerminalSplitRatio(current, path, ratio);
      if (next !== current) persist(next);
    },
    [persist],
  );

  const localUnavailable = ctx.remoteHostId !== null || ctx.deviceLinkDeviceId !== null || !workdir;

  if (localUnavailable) {
    const pending = ctx.deviceLinkDeviceId === undefined;
    return (
      <div className="flex h-full items-center justify-center bg-[var(--panel-bg)] px-6 text-center">
        <div className="max-w-80 text-12 text-[var(--text-secondary)]">
          <TerminalIcon className="mx-auto mb-3 text-[var(--text-tertiary)]" size={22} />
          {t(pending ? 'rightSidebar.terminal.targetResolving' : 'rightSidebar.terminal.localOnly')}
        </div>
      </div>
    );
  }

  if (!activePane) return null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--panel-bg)]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--border-default)] px-2">
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {paneIds.map((paneId, index) => {
            const pane = state.panes[paneId];
            if (!pane) return null;
            const label = pane.title || profileLabel(pane.profile, t);
            return (
              <button
                key={paneId}
                type="button"
                onClick={() => selectPane(paneId)}
                className={`inline-flex h-7 max-w-36 items-center gap-1 rounded-lg px-2 text-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] ${
                  paneId === activePane.id
                    ? 'bg-[var(--surface-chip)] text-[var(--text-primary)]'
                    : 'text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)]'
                }`}
                aria-label={t('rightSidebar.terminal.focusPane', { name: label })}
              >
                <PaneIcon profile={pane.profile} />
                <span className="truncate">{label}</span>
                <span className="text-[var(--text-tertiary)]">{index + 1}</span>
              </button>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Tip text={t('rightSidebar.terminal.splitHorizontal')}>
            <button
              type="button"
              disabled={!canSplit}
              className="rounded-full p-1.5 hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => createSplit('horizontal')}
              aria-label={t('rightSidebar.terminal.splitHorizontal')}
            >
              <ArrowLeftRight size={14} />
            </button>
          </Tip>
          <Tip text={t('rightSidebar.terminal.splitVertical')}>
            <button
              type="button"
              disabled={!canSplit}
              className="rounded-full p-1.5 hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => createSplit('vertical')}
              aria-label={t('rightSidebar.terminal.splitVertical')}
            >
              <ArrowUpDown size={14} />
            </button>
          </Tip>
          <div className="relative">
            <Tip text={t('rightSidebar.terminal.launchAgent')}>
              <button
                ref={menuButtonRef}
                type="button"
                className="rounded-full p-1.5 hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                onClick={() => setMenuOpen((open) => !open)}
                aria-label={t('rightSidebar.terminal.launchAgent')}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <Plus size={14} />
              </button>
            </Tip>
            {menuOpen && (
              <div
                ref={menuRef}
                role="menu"
                tabIndex={-1}
                onBlur={(event) => {
                  const next = event.relatedTarget as Node | null;
                  if (!next || !menuRef.current?.contains(next)) closeAgentMenu(false);
                }}
                className="absolute right-0 top-8 z-20 min-w-40 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-1 shadow-[var(--shadow-menu)]"
              >
                {PROFILES.map(({ id, labelKey }) => (
                  <button
                    key={id}
                    type="button"
                    role="menuitem"
                    disabled={!canSplit}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-12 hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={() => createProfilePane(id)}
                  >
                    <PaneIcon profile={id} />
                    <span>{t(labelKey)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <LayoutNodeView
          node={state.layout}
          splitPath={ROOT_SPLIT_PATH}
          state={state}
          tabId={tabId}
          workdir={workdir}
          activePaneId={state.activePaneId}
          active={active === true}
          runtimeErrors={runtimeErrors}
          onSelect={selectPane}
          onClose={closePane}
          onPatchPane={patchPane}
          onCommitSplitRatio={commitSplitRatio}
          onRuntimeError={setPaneRuntimeError}
          t={t}
        />
      </div>
    </div>
  );
}

interface LayoutNodeViewProps {
  node: TerminalLayoutNode;
  splitPath: TerminalSplitPath;
  state: TerminalState;
  tabId: string;
  workdir: string;
  activePaneId: string;
  active: boolean;
  runtimeErrors: Readonly<Record<string, RuntimeError>>;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onPatchPane: (id: string, patch: Partial<Omit<TerminalPaneState, 'id'>>) => void;
  onCommitSplitRatio: (path: TerminalSplitPath, ratio: number) => void;
  onRuntimeError: (paneId: string, error: RuntimeError | null) => void;
  t: ReturnType<typeof useTranslation>['t'];
}

function LayoutNodeView(props: LayoutNodeViewProps) {
  const { node } = props;
  if (node.type === 'leaf') {
    const pane = props.state.panes[node.paneId];
    if (!pane) return null;
    return (
      <TerminalPaneView
        key={`${pane.id}:${pane.profile}`}
        {...props}
        pane={pane}
        runtimeError={props.runtimeErrors[pane.id] ?? null}
      />
    );
  }
  return <TerminalSplitNodeView {...props} node={node} />;
}

function TerminalSplitNodeView(
  props: LayoutNodeViewProps & { node: Extract<TerminalLayoutNode, { type: 'split' }> },
) {
  const { node, splitPath } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLDivElement>(null);
  const secondRef = useRef<HTMLDivElement>(null);
  const separatorRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<((commit: boolean) => void) | null>(null);
  const displayedRatioRef = useRef(node.ratio);
  const isHorizontal = node.direction === 'horizontal';

  const displayRatio = useCallback((ratio: number) => {
    const clamped = clampSplitRatio(ratio);
    displayedRatioRef.current = clamped;
    if (firstRef.current) firstRef.current.style.flexGrow = String(clamped);
    if (secondRef.current) secondRef.current.style.flexGrow = String(1 - clamped);
    separatorRef.current?.setAttribute('aria-valuenow', String(Math.round(clamped * 100)));
  }, []);

  useLayoutEffect(() => {
    if (!resizeCleanupRef.current) displayRatio(node.ratio);
  }, [displayRatio, node.ratio]);

  useEffect(
    () => () => {
      resizeCleanupRef.current?.(false);
    },
    [],
  );

  const commitRatio = useCallback(
    (ratio: number) => {
      const clamped = clampSplitRatio(ratio);
      displayRatio(clamped);
      props.onCommitSplitRatio(splitPath, clamped);
    },
    [displayRatio, props.onCommitSplitRatio, splitPath],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const container = containerRef.current;
      const separator = separatorRef.current;
      if (!container || !separator) return;
      const bounds = container.getBoundingClientRect();
      const axisSize = (isHorizontal ? bounds.width : bounds.height) - SPLIT_GUTTER_PX;
      if (axisSize <= 0) return;

      resizeCleanupRef.current?.(true);
      const pointerId = event.pointerId;
      const startPosition = isHorizontal ? event.clientX : event.clientY;
      const startRatio = displayedRatioRef.current;
      let moved = false;
      document.body.classList.add('resizing-pane');
      try {
        separator.setPointerCapture?.(pointerId);
      } catch {
        // Pointer capture may be unavailable in older embedded Chromium builds.
      }

      const handlePointerMove = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId !== pointerId) return;
        const position = isHorizontal ? pointerEvent.clientX : pointerEvent.clientY;
        moved = true;
        displayRatio(startRatio + (position - startPosition) / axisSize);
      };

      const finishResize = (commit: boolean) => {
        if (resizeCleanupRef.current !== finishResize) return;
        resizeCleanupRef.current = null;
        document.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('pointerup', handlePointerUp);
        document.removeEventListener('pointercancel', handlePointerCancel);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        window.removeEventListener('blur', handleWindowBlur);
        document.body.classList.remove('resizing-pane');
        try {
          if (separator.hasPointerCapture?.(pointerId)) separator.releasePointerCapture(pointerId);
        } catch {
          // Losing capture already completed the browser-side cleanup.
        }
        if (commit && moved) props.onCommitSplitRatio(splitPath, displayedRatioRef.current);
        else if (!commit) displayRatio(node.ratio);
      };

      const handlePointerUp = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId === pointerId) finishResize(true);
      };
      const handlePointerCancel = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId === pointerId) finishResize(true);
      };
      const handleVisibilityChange = () => {
        if (document.visibilityState === 'hidden') finishResize(true);
      };
      const handleWindowBlur = () => finishResize(true);

      resizeCleanupRef.current = finishResize;
      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', handlePointerUp);
      document.addEventListener('pointercancel', handlePointerCancel);
      document.addEventListener('visibilitychange', handleVisibilityChange);
      window.addEventListener('blur', handleWindowBlur);
    },
    [displayRatio, isHorizontal, node.ratio, props.onCommitSplitRatio, splitPath],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const decreaseKey = isHorizontal ? 'ArrowLeft' : 'ArrowUp';
      const increaseKey = isHorizontal ? 'ArrowRight' : 'ArrowDown';
      let nextRatio: number | null = null;
      if (event.key === decreaseKey) nextRatio = displayedRatioRef.current - KEYBOARD_RESIZE_STEP;
      else if (event.key === increaseKey)
        nextRatio = displayedRatioRef.current + KEYBOARD_RESIZE_STEP;
      else if (event.key === 'Home') nextRatio = MIN_SPLIT_RATIO;
      else if (event.key === 'End') nextRatio = MAX_SPLIT_RATIO;
      if (nextRatio === null) return;
      event.preventDefault();
      commitRatio(nextRatio);
    },
    [commitRatio, isHorizontal],
  );

  const firstStyle = { flexBasis: 0, flexGrow: node.ratio };
  const secondStyle = { flexBasis: 0, flexGrow: 1 - node.ratio };
  return (
    <div
      ref={containerRef}
      data-terminal-split-path={splitPath.join('.') || 'root'}
      className={`flex h-full w-full ${node.direction === 'horizontal' ? 'flex-row' : 'flex-col'}`}
    >
      <div ref={firstRef} className="min-h-0 min-w-0" style={firstStyle}>
        <LayoutNodeView {...props} node={node.first} splitPath={[...splitPath, 'first']} />
      </div>
      <div
        ref={separatorRef}
        role="separator"
        tabIndex={0}
        aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
        aria-label={props.t('rightSidebar.terminal.resizePanes')}
        aria-valuemin={Math.round(MIN_SPLIT_RATIO * 100)}
        aria-valuemax={Math.round(MAX_SPLIT_RATIO * 100)}
        aria-valuenow={Math.round(node.ratio * 100)}
        onPointerDown={handlePointerDown}
        onKeyDown={handleKeyDown}
        className={
          isHorizontal
            ? 'group relative z-10 w-1.5 shrink-0 touch-none cursor-col-resize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]'
            : 'group relative z-10 h-1.5 shrink-0 touch-none cursor-row-resize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]'
        }
      >
        <span
          aria-hidden="true"
          className={
            isHorizontal
              ? 'pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--border-default)] group-hover:bg-[var(--text-tertiary)] group-focus-visible:bg-[var(--text-tertiary)]'
              : 'pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[var(--border-default)] group-hover:bg-[var(--text-tertiary)] group-focus-visible:bg-[var(--text-tertiary)]'
          }
        />
      </div>
      <div ref={secondRef} className="min-h-0 min-w-0" style={secondStyle}>
        <LayoutNodeView {...props} node={node.second} splitPath={[...splitPath, 'second']} />
      </div>
    </div>
  );
}

function TerminalPaneView({
  pane,
  runtimeError,
  ...props
}: LayoutNodeViewProps & { pane: TerminalPaneState; runtimeError: RuntimeError | null }) {
  const slotRef = useRef<HTMLDivElement>(null);
  const entryRef = useRef<XtermEntry | null>(null);
  const aliveRef = useRef(true);
  const onDataRef = useRef<{ dispose(): void } | null>(null);
  const ptyId = terminalPtyId(props.tabId, pane.id);
  const isActive = props.activePaneId === pane.id;
  const canClose = collectPaneIds(props.state.layout).length > 1;
  const [restarting, setRestarting] = useState(false);

  useLayoutEffect(() => {
    aliveRef.current = true;
    const slot = slotRef.current;
    if (!slot) return;
    const entry = getOrCreateXterm(ptyId);
    entryRef.current = entry;
    const root = entry.terminal.element as HTMLElement | undefined;
    if (root && root.parentElement !== slot) slot.appendChild(root);
    else if (!root) entry.terminal.open(slot);
    onDataRef.current = entry.terminal.onData(
      (data) => void window.electronAPI.terminal.write(ptyId, data).catch(() => undefined),
    );
    const offData = window.electronAPI.terminal.onData((event: unknown) => {
      const data = event as TerminalDataEvent;
      if (aliveRef.current && data.id === ptyId) entry.terminal.write(data.chunk);
    });
    const offExit = window.electronAPI.terminal.onExit((event: unknown) => {
      const data = event as TerminalExitEvent;
      if (aliveRef.current && data.id === ptyId)
        props.onPatchPane(pane.id, { exited: data.exit, created: true });
    });
    fitAndPush(entry, ptyId);
    return () => {
      aliveRef.current = false;
      onDataRef.current?.dispose();
      onDataRef.current = null;
      offData();
      offExit();
    };
  }, [pane.id, ptyId, props.onPatchPane]);

  useEffect(() => {
    const entry = entryRef.current;
    if (!entry) return;
    if (pane.created && entry.ptyAttached) return;
    let cancelled = false;
    void window.electronAPI.terminal
      .create({
        id: ptyId,
        cwd: props.workdir,
        cols: entry.lastSize.cols,
        rows: entry.lastSize.rows,
        profile: pane.profile,
      })
      .then((result) => {
        // A pane can be removed while the invoke is in flight.  The Main
        // handler may have spawned successfully even though React has already
        // unmounted this view; release that late-created PTY instead of leaving
        // an orphan process behind.  `aliveRef` only flips on real unmount, so a
        // dependency refresh does not accidentally dispose a live session.
        if (cancelled || !aliveRef.current) {
          if (!aliveRef.current) void disposePty(ptyId);
          return;
        }
        entry.ptyAttached = true;
        props.onPatchPane(pane.id, {
          created: true,
          exited: result.exit,
          shellId: result.shellId,
          shellDisplayName: result.profileDisplayName || result.shellDisplayName,
        });
        props.onRuntimeError(pane.id, null);
      })
      .catch((error: unknown) => {
        if (cancelled || !aliveRef.current) return;
        props.onRuntimeError(pane.id, parseRuntimeError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [
    pane.created,
    pane.id,
    pane.profile,
    props.onPatchPane,
    props.onRuntimeError,
    props.workdir,
    ptyId,
  ]);

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const observer = new ResizeObserver(() => {
      if (entryRef.current) fitAndPush(entryRef.current, ptyId);
    });
    observer.observe(slot);
    return () => observer.disconnect();
  }, [ptyId]);

  useEffect(() => {
    if (!props.active || !isActive) return;
    const frame = requestAnimationFrame(() => {
      const entry = entryRef.current;
      if (!entry) return;
      fitAndPush(entry, ptyId);
      entry.terminal.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [isActive, props.active, ptyId]);

  const restart = async () => {
    if (restarting) return;
    setRestarting(true);
    try {
      const result = await window.electronAPI.terminal.restart(ptyId);
      if (entryRef.current) entryRef.current.ptyAttached = true;
      props.onPatchPane(pane.id, {
        created: true,
        exited: null,
        shellId: result.shellId,
        shellDisplayName: result.profileDisplayName || result.shellDisplayName,
      });
      props.onRuntimeError(pane.id, null);
    } catch (error: unknown) {
      props.onRuntimeError(pane.id, parseRuntimeError(error));
    } finally {
      setRestarting(false);
    }
  };

  const label = pane.title || profileLabel(pane.profile, props.t);
  return (
    <div
      className={`group relative h-full w-full ${isActive ? 'ring-1 ring-inset ring-[var(--focus-ring)]' : ''}`}
      onMouseDown={() => props.onSelect(pane.id)}
    >
      <div ref={slotRef} className="absolute inset-0 bg-[var(--panel-bg)] p-1" />
      <div className="pointer-events-none absolute left-2 top-1 z-10 flex items-center gap-1 rounded-lg bg-[var(--surface-elevated)] px-1.5 py-0.5 text-10 text-[var(--text-tertiary)] opacity-0 transition-opacity group-hover:opacity-100">
        <PaneIcon profile={pane.profile} />
        {label}
      </div>
      <div className="pointer-events-none absolute right-1 top-1 z-10 flex items-center gap-0.5 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
        {pane.exited && (
          <Tip text={props.t('rightSidebar.terminal.restart')}>
            <button
              type="button"
              className="rounded-full p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              onClick={restart}
              aria-label={props.t('rightSidebar.terminal.restart')}
            >
              <Spinner icon={RotateCw} size={12} spinning={restarting} />
            </button>
          </Tip>
        )}
        {canClose && (
          <Tip text={props.t('rightSidebar.terminal.closePane')}>
            <button
              type="button"
              className="rounded-full p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              onClick={() => props.onClose(pane.id)}
              aria-label={props.t('rightSidebar.terminal.closePane')}
            >
              <X size={12} />
            </button>
          </Tip>
        )}
      </div>
      {pane.exited && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2 py-1 text-11">
            <Circle size={8} className="text-[var(--text-tertiary)]" />
            {props.t('rightSidebar.terminal.processExited', { code: pane.exited.code ?? 0 })}
            <button
              type="button"
              className="rounded-lg px-1.5 py-0.5 text-10 hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              onClick={restart}
            >
              {props.t('rightSidebar.terminal.restart')}
            </button>
          </div>
        </div>
      )}
      {runtimeError && isActive && (
        <div className="absolute inset-x-2 bottom-3 z-10 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2 py-1 text-11 text-[var(--text-secondary)]">
          {props.t(runtimeError.key, { detail: runtimeError.detail })}
        </div>
      )}
    </div>
  );
}

function PaneIcon({ profile }: { profile: TerminalProfile }) {
  return profile === 'shell' ? <TerminalIcon size={12} /> : <Bot size={12} />;
}

function profileLabel(profile: TerminalProfile, t: ReturnType<typeof useTranslation>['t']): string {
  const item = PROFILES.find((candidate) => candidate.id === profile);
  return item ? t(item.labelKey) : t('rightSidebar.terminal.profileShell');
}

function parseRuntimeError(error: unknown): RuntimeError {
  const ipc = extractIpcError(error);
  const detail = ipc?.message ?? (error instanceof Error ? error.message : String(error));
  return {
    key:
      ipc?.code === 'TERMINAL_AGENT_NOT_READY'
        ? 'rightSidebar.terminal.agentNotReady'
        : 'rightSidebar.terminal.spawnFailed',
    detail,
  };
}

function fitAndPush(entry: XtermEntry, id: string): void {
  try {
    entry.fitAddon.fit();
    const cols = entry.terminal.cols;
    const rows = entry.terminal.rows;
    if (cols < 1 || rows < 1 || (cols === entry.lastSize.cols && rows === entry.lastSize.rows))
      return;
    entry.lastSize = { cols, rows };
    void window.electronAPI.terminal.resize(id, cols, rows).catch(() => undefined);
  } catch {
    /* the pane may not have a measurable size during its first frame */
  }
}

async function disposePty(id: string): Promise<void> {
  try {
    await window.electronAPI.terminal.dispose(id);
  } catch {
    /* no existing PTY */
  }
}
