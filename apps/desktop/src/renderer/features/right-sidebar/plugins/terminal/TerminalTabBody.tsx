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
import { createPortal } from 'react-dom';
import {
  Columns2,
  Rows2,
  Circle,
  RotateCw,
  Terminal as TerminalIcon,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAppShortcut } from '@/hooks/useAppShortcut';
import { acquireFindInPage } from '@/components/find-in-page/findInPageOwnership';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { RenameDialog } from '../../RenameDialog';
import { openFileContentInSidebar } from '../../lib/openFileContentTab';
import { openDirInSidebarFileBrowser } from '../../lib/openInSidebarFileBrowser';
import { openUrlInSidebarBrowser } from '../../lib/openInSidebarBrowser';
import { toast } from '@/lib/toast';
import { registerTerminalFileLinks } from './lib/terminalFileLinks';
import { TerminalSearchBar } from './TerminalSearchBar';
import { Spinner } from '@/components/ui/spinner';
import { themeService } from '@/themes/theme-service';
import { Tip } from '@/components/ui/tooltip';
import { extractIpcError } from '@/utils/ipcError';
import type { TabKindHostContext } from '../../types';
import { getBucket } from '../../store';
import { getOrCreateXterm, updateXtermTheme, type XtermEntry } from './lib/xtermPool';
import {
  adjacentTerminalPane,
  MAX_TERMINAL_PANES,
  hydrateTerminalState,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  clampSplitRatio,
  collectPaneIds,
  createPaneState,
  hideTerminalPane,
  visibleTerminalPaneIds,
  moveTerminalPane,
  setActiveTerminalPane,
  splitTerminalPane,
  updateTerminalSplitRatio,
  updateTerminalPane,
  type TerminalLayoutNode,
  type TerminalDropZone,
  type TerminalPaneState,
  type TerminalProfile,
  type TerminalSplitPath,
  type TerminalState,
} from './terminal-layout';
import { terminalPtyId } from './index';
import { useTerminalPaneDrag } from './lib/useTerminalPaneDrag';
import type { TerminalExitEvent } from '../../../../../shared/terminal-bridge';

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
// The visible divider is intentionally narrow; its hit area remains large
// enough for pointer and keyboard resizing.
const SPLIT_GUTTER_PX = 4;
const KEYBOARD_RESIZE_STEP = 0.05;

export function TerminalTabBody({ state, ctx, active }: Props) {
  const { tabId, patchState } = ctx;
  const workdir = state.cwd || ctx.workdir;
  const { t } = useTranslation();
  // A failed create/restart belongs to one pane.  Keeping this keyed by pane
  // id prevents an error from pane A being shown after the user focuses pane B.
  const [runtimeErrors, setRuntimeErrors] = useState<Record<string, RuntimeError>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const [zoomedPaneId, setZoomedPaneId] = useState<string | null>(null);
  const [searchPaneId, setSearchPaneId] = useState<string | null>(null);
  const terminalFocused = () => rootRef.current?.contains(document.activeElement) === true;
  useEffect(() => {
    if (!active) return;
    let release: (() => void) | undefined;
    const sync = () => {
      const focused = rootRef.current?.contains(document.activeElement);
      if (focused && !release) release = acquireFindInPage();
      if (!focused && release) { release(); release = undefined; }
    };
    sync();
    document.addEventListener('focusin', sync);
    return () => { document.removeEventListener('focusin', sync); release?.(); };
  }, [active]);
  useAppShortcut('find-in-page', () => {
    if (!terminalFocused()) return false;
    setSearchPaneId(stateRef.current.activePaneId); return true;
  }, { enabled: active, stopImmediate: true });
  const focusAdjacent = (direction: -1 | 1) => {
    if (!terminalFocused()) return false;
    setZoomedPaneId(null); setSearchPaneId(null);
    selectPane(adjacentTerminalPane(stateRef.current, direction)); return true;
  };
  useAppShortcut('terminal-focus-previous-pane', () => focusAdjacent(-1), { enabled: active });
  useAppShortcut('terminal-focus-next-pane', () => focusAdjacent(1), { enabled: active });
  useAppShortcut('terminal-toggle-pane-zoom', () => {
    if (!terminalFocused()) return false;
    setZoomedPaneId(id => id ? null : stateRef.current.activePaneId); return true;
  }, { enabled: active });
  const paneHostsRef = useRef(new Map<string, HTMLDivElement>());
  const getPaneHost = useCallback((paneId: string) => {
    let host = paneHostsRef.current.get(paneId);
    if (!host) {
      host = document.createElement('div');
      host.className = 'h-full min-h-0 w-full min-w-0';
      paneHostsRef.current.set(paneId, host);
    }
    return host;
  }, []);
  const nextIdRef = useRef(2);
  const stateRef = useRef(state);
  stateRef.current = state;

  const paneIds = useMemo(() => visibleTerminalPaneIds(state), [state.layout, state.panes]);
  useEffect(() => {
    if (zoomedPaneId && (state.activePaneId !== zoomedPaneId || !paneIds.includes(zoomedPaneId))) setZoomedPaneId(null);
  }, [state.activePaneId, paneIds, zoomedPaneId]);
  const canSplit = collectPaneIds(state.layout).length < MAX_TERMINAL_PANES;
  useEffect(() => {
    for (const paneId of paneHostsRef.current.keys()) {
      if (!paneIds.includes(paneId)) paneHostsRef.current.delete(paneId);
    }
  }, [paneIds]);

  // Keep ids unique even when restoring a layout created in another renderer.
  useEffect(() => {
    const max = Object.keys(state.panes).reduce((found, id) => {
      const n = Number(id.match(/pane-(\d+)/)?.[1] ?? 0);
      return Math.max(found, n);
    }, 0);
    nextIdRef.current = Math.max(nextIdRef.current, max + 1);
  }, [state.panes]);

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

  const createSplitForPane = useCallback(
    (paneId: string, direction: 'horizontal' | 'vertical', profile: TerminalProfile = 'shell') => {
      if (collectPaneIds(stateRef.current.layout).length >= MAX_TERMINAL_PANES) return;
      setZoomedPaneId(null);
      const id = `pane-${nextIdRef.current++}`;
      const next = splitTerminalPane(stateRef.current, paneId, direction, {
        ...createPaneState(id, profile),
        terminalId: crypto.randomUUID(),
      });
      if (next) persist(next);
    },
    [persist],
  );

  const closePane = useCallback(
    (paneId: string) => {
      setZoomedPaneId(null);
      const next = hideTerminalPane(stateRef.current, paneId);
      if (!next) return;
      const ptyId = stateRef.current.panes[paneId].terminalId || terminalPtyId(tabId, paneId);
      // Preserve its original split slot and PTY identity for background restore.
      void window.electronAPI.terminal.detach(ptyId).catch(() => undefined);
      setPaneRuntimeError(paneId, null);
      persist(next);
    },
    [persist, setPaneRuntimeError, tabId],
  );

  const selectPane = useCallback(
    (paneId: string) => {
      setSearchPaneId(null);
      persist(setActiveTerminalPane(stateRef.current, paneId));
    },
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

  const movePane = useCallback(
    (sourceId: string, targetId: string, zone: TerminalDropZone) => {
      const current = stateRef.current;
      setZoomedPaneId(null);
      const next = moveTerminalPane(current, sourceId, targetId, zone);
      if (next !== current) persist(next);
    },
    [persist],
  );
  const { preview, beginDrag, onClickCapture, onPointerDownCapture } = useTerminalPaneDrag(
    rootRef,
    state,
    active,
    movePane,
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

  if (paneIds.length === 0) return null;

  return (
    <div
      ref={rootRef}
      onClickCapture={onClickCapture}
      onPointerDownCapture={onPointerDownCapture}
      data-terminal-workbench=""
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--panel-bg)]"
    >
      {searchPaneId && active && state.panes[searchPaneId] && <TerminalSearchBar key={searchPaneId}
        terminalId={state.panes[searchPaneId].terminalId || terminalPtyId(tabId, searchPaneId)}
        onClose={() => { setSearchPaneId(null); getOrCreateXterm(state.panes[searchPaneId].terminalId || terminalPtyId(tabId, searchPaneId)).terminal.focus(); }} />}
      <div className="relative min-h-0 flex-1">
      <LayoutNodeView
        node={state.layout}
        zoomedPaneId={zoomedPaneId}
        visiblePaneIds={paneIds}
        splitPath={ROOT_SPLIT_PATH}
        getPaneHost={getPaneHost}
        onCommitSplitRatio={commitSplitRatio}
        t={t}
      />
      </div>
      {paneIds.map((paneId) => {
        const pane = state.panes[paneId];
        if (!pane) return null;
        return createPortal(
          <TerminalPaneView
            pane={pane}
            state={state}
            tabId={tabId}
            sessionId={ctx.sessionId}
            workdir={workdir}
            activePaneId={state.activePaneId}
            canSplit={canSplit}
            active={active === true}
            runtimeError={runtimeErrors[paneId] ?? null}
            onSelect={selectPane}
            onClose={closePane}
            onSplit={createSplitForPane}
            onPatchPane={patchPane}
            onRuntimeError={setPaneRuntimeError}
            onBeginDrag={(id, event) => { setZoomedPaneId(null); beginDrag(id, event); }}
            zoomed={zoomedPaneId === paneId}
            onZoom={() => setZoomedPaneId(id => id === paneId ? null : paneId)}
            onSearch={() => setSearchPaneId(paneId)}
            dragging={preview?.sourcePaneId === paneId}
            t={t}
          />,
          getPaneHost(paneId),
          paneId,
        );
      })}
      {preview && (
        <div
          className="absolute inset-0 z-20 cursor-grabbing select-none"
          data-terminal-drag-overlay=""
        >
          {preview.target && (
            <div
              data-terminal-drop-target={preview.target.paneId}
              data-terminal-drop-zone={preview.target.zone}
              aria-hidden="true"
              className="pointer-events-none absolute rounded-lg border border-[var(--focus-ring)] bg-[color-mix(in_srgb,var(--focus-ring)_18%,transparent)]"
              style={{
                left: preview.target.left,
                top: preview.target.top,
                width: preview.target.width,
                height: preview.target.height,
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

interface LayoutNodeViewProps {
  visiblePaneIds: string[];
  zoomedPaneId: string | null;
  node: TerminalLayoutNode;
  splitPath: TerminalSplitPath;
  getPaneHost: (id: string) => HTMLDivElement;
  onCommitSplitRatio: (path: TerminalSplitPath, ratio: number) => void;
  t: ReturnType<typeof useTranslation>['t'];
}

interface TerminalPaneViewProps {
  sessionId: string;
  pane: TerminalPaneState;
  state: TerminalState;
  tabId: string;
  workdir: string;
  activePaneId: string;
  canSplit: boolean;
  active: boolean;
  runtimeError: RuntimeError | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onSplit: (id: string, direction: 'horizontal' | 'vertical') => void;
  onPatchPane: (id: string, patch: Partial<Omit<TerminalPaneState, 'id'>>) => void;
  onRuntimeError: (paneId: string, error: RuntimeError | null) => void;
  onBeginDrag: (id: string, event: ReactPointerEvent<HTMLButtonElement>) => void;
  dragging: boolean;
  zoomed: boolean;
  onZoom: () => void;
  onSearch: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}

function LayoutNodeView(props: LayoutNodeViewProps) {
  if (props.node.type === 'leaf') {
    if (!props.visiblePaneIds.includes(props.node.paneId)) return null;
    return <TerminalPaneSlot paneId={props.node.paneId} getPaneHost={props.getPaneHost} />;
  }
  return <TerminalSplitNodeView {...props} node={props.node} />;
}

function TerminalPaneSlot({
  paneId,
  getPaneHost,
}: {
  paneId: string;
  getPaneHost: (id: string) => HTMLDivElement;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const host = getPaneHost(paneId);
    slot.appendChild(host);
    return () => {
      if (host.parentElement === slot) slot.removeChild(host);
    };
  }, [paneId, getPaneHost]);
  return <div ref={slotRef} className="h-full min-h-0 w-full min-w-0" />;
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

  const zoomFirst = !!props.zoomedPaneId && collectPaneIds(node.first).includes(props.zoomedPaneId);
  const zoomSecond = !!props.zoomedPaneId && collectPaneIds(node.second).includes(props.zoomedPaneId);
  const hideFirst = zoomSecond || !collectPaneIds(node.first).some(id => props.visiblePaneIds.includes(id));
  const hideSecond = zoomFirst || !collectPaneIds(node.second).some(id => props.visiblePaneIds.includes(id));
  const firstStyle = { flexBasis: 0, flexGrow: hideSecond ? 1 : node.ratio, display: hideFirst ? 'none' : undefined };
  const secondStyle = { flexBasis: 0, flexGrow: hideFirst ? 1 : 1 - node.ratio, display: hideSecond ? 'none' : undefined };
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
        style={hideFirst || hideSecond ? { display: 'none' } : undefined}
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
            ? 'group relative z-10 w-1 shrink-0 touch-none cursor-col-resize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]'
            : 'group relative z-10 h-1 shrink-0 touch-none cursor-row-resize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]'
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

function TerminalPaneView({ pane, runtimeError, ...props }: TerminalPaneViewProps) {
  const slotRef = useRef<HTMLDivElement>(null);
  const entryRef = useRef<XtermEntry | null>(null);
  const aliveRef = useRef(true);
  const onDataRef = useRef<{ dispose(): void } | null>(null);
  const ptyId = pane.terminalId || terminalPtyId(props.tabId, pane.id);
  const isActive = props.activePaneId === pane.id;
  const canClose = visibleTerminalPaneIds(props.state).length > 1;
  const [restarting, setRestarting] = useState(false);
  const [menu, setMenu] = useState<{x: number; y: number} | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [urlMenu, setUrlMenu] = useState<{ x: number; y: number; url: string } | null>(null);

  useLayoutEffect(() => {
    aliveRef.current = true;
    const slot = slotRef.current;
    if (!slot) return;
    const entry = getOrCreateXterm(ptyId);
    entryRef.current = entry;
    const root = entry.terminal.element as HTMLElement | undefined;
    if (root && root.parentElement !== slot) slot.appendChild(root);
    else if (!root) entry.terminal.open(slot);
    let linkRequest = 0;
    let linksActive = true;
    const fileLinks = registerTerminalFileLinks(entry.terminal, link => {
      const request = ++linkRequest;
      void window.electronAPI.terminal.resolveFile(ptyId, link.path).then(target => {
        if (!linksActive || request !== linkRequest) return;
        if (target.kind === 'directory') return openDirInSidebarFileBrowser(props.sessionId, target.path);
        return openFileContentInSidebar(props.sessionId, {
          workdir: target.workdir, path: target.path, external: false, remoteHostId: null, deviceId: null,
          ...(link.line ? { reveal: { line: link.line, column: link.column, requestId: crypto.randomUUID() } } : {}),
        });
      }).catch(() => {
        if (linksActive && request === linkRequest) toast.error(props.t('rightSidebar.workbench.fileLinkFailed'));
      });
    }, props.t('rightSidebar.workbench.startupDirectory', { path: props.workdir }));
    onDataRef.current = entry.terminal.onData(
      (data) => void window.electronAPI.terminal.write(ptyId, data).catch(() => undefined),
    );
    const offExit = window.electronAPI.terminal.onExit((event: unknown) => {
      const data = event as TerminalExitEvent;
      if (aliveRef.current && data.id === ptyId)
        props.onPatchPane(pane.id, { exited: data.exit, created: true });
    });
    fitAndPush(entry, ptyId);
    return () => {
      aliveRef.current = false;
      linksActive = false;
      fileLinks.dispose();
      onDataRef.current?.dispose();
      onDataRef.current = null;
      offExit();
    };
  }, [pane.id, ptyId, props.onPatchPane]);

  // xterm keeps its own canvas colors, so changing the host theme does not
  // repaint existing panes automatically. Re-apply semantic tokens in place
  // while preserving the PTY and scrollback.
  useEffect(() => {
    const entry = entryRef.current;
    if (!entry) return;
    updateXtermTheme(entry);
    return themeService.onDidChangeTheme(() => updateXtermTheme(entry));
  }, [ptyId]);

  useEffect(() => {
    const entry = entryRef.current;
    if (!entry) return;
    if (pane.created && entry.ptyAttached) return;
    if (props.state.viewHidden || (!props.active && !pane.runtimeStarted)) return;
    let cancelled = false;
    void window.electronAPI.terminal
      .create({
        id: ptyId,
        sessionId: props.sessionId,
        attachOnly: pane.runtimeStarted === true,
        cwd: props.workdir,
        cols: entry.lastSize.cols,
        rows: entry.lastSize.rows,
        profile: pane.profile,
        ...(pane.shellPref === undefined ? {} : { shellPref: pane.shellPref }),
      })
      .then((result) => {
        // Local bucket absence can mean navigation/cache handoff, not deletion.
        // A late response must never authorize process termination.
        if (cancelled || !aliveRef.current) {
          entry.ptyAttached = true;
          const retained = getBucket(props.sessionId).tabs.find((tab) => tab.id === props.tabId);
          const saved = retained ? hydrateTerminalState(retained.state) : null;
          if (!aliveRef.current || saved?.viewHidden || (saved && !saved.panes[pane.id])) {
            void window.electronAPI.terminal.detach(ptyId).catch(() => undefined);
          }
          return;
        }
        entry.ptyAttached = true;
        props.onPatchPane(pane.id, {
          terminalId: ptyId,
          runtimeStarted: true,
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
    pane.shellPref,
    props.onPatchPane,
    props.onRuntimeError,
    props.workdir,
    props.sessionId,
    props.tabId,
    props.active,
    props.state.viewHidden,
    pane.runtimeStarted,
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
  }, [isActive, props.active, props.state.layout, ptyId]);

  const restart = async () => {
    if (restarting) return;
    setRestarting(true);
    try {
      // Missing runtime after an app restart is not resumed automatically.
      // An explicit Restart is allowed to create a new process.
      const records = await window.electronAPI.terminal.list(props.sessionId);
      const result = records.some((record) => record.terminalId === ptyId)
        ? await window.electronAPI.terminal.restart(ptyId)
        : await window.electronAPI.terminal.create({
            id: ptyId,
            sessionId: props.sessionId,
            cwd: props.workdir,
            profile: pane.profile,
            ...(pane.shellPref === undefined ? {} : { shellPref: pane.shellPref }),
          });
      if (entryRef.current) entryRef.current.ptyAttached = true;
      props.onPatchPane(pane.id, {
        terminalId: ptyId,
        runtimeStarted: true,
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
      onContextMenu={event => {
        if ((event.target as Element).closest('[data-terminal-pane-header]')) return;
        const url = entryRef.current?.hoveredUrl?.();
        if (url && /^https?:\/\//i.test(url)) { event.preventDefault(); setUrlMenu({ x: event.clientX, y: event.clientY, url }); }
      }}
      data-terminal-pane-id={pane.id}
      className={`group relative h-full w-full ${isActive ? 'ring-1 ring-inset ring-[var(--focus-ring)]' : ''} ${props.dragging ? 'opacity-60' : ''}`}
      onMouseDown={(event) => {
        if (!(event.target as Element).closest('[data-terminal-pane-header]'))
          props.onSelect(pane.id);
      }}
    >
      <div ref={slotRef} className="absolute inset-0 bg-[var(--panel-bg)] p-1" />
      <div
        onContextMenu={event => { event.preventDefault(); props.onSelect(pane.id); setMenu({x: event.clientX, y: event.clientY}); }}
        data-terminal-pane-header=""
        className="group/terminal-header absolute inset-x-0 top-0 z-10 flex h-6 items-center gap-1 px-1"
      >
        <Tip
          text={props.t('rightSidebar.terminal.movePane', { name: label })}
          controlledOpen={props.dragging ? false : undefined}
        >
          <button
            type="button"
            className={`absolute inset-0 flex h-full min-w-0 touch-none items-center rounded-lg text-left text-10 text-[var(--text-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)] ${canClose ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'}`}
            aria-label={props.t('rightSidebar.terminal.movePane', { name: label })}
            onPointerDown={(event) => props.onBeginDrag(pane.id, event)}
            onClick={() => props.onSelect(pane.id)}
          />
        </Tip>
        <div className="relative z-10 ml-auto flex shrink-0 items-center gap-0.5 rounded-lg bg-[var(--surface-elevated)] opacity-0 transition-opacity group-hover/terminal-header:opacity-100 focus-within:opacity-100">
          {pane.exited && (
            <Tip text={props.t('rightSidebar.terminal.restart')}>
              <button
                type="button"
                className="rounded-full p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={restart}
                aria-label={props.t('rightSidebar.terminal.restart')}
              >
                <Spinner icon={RotateCw} size={12} spinning={restarting} />
              </button>
            </Tip>
          )}
          {props.canSplit && (
            <>
              <Tip text={props.t('rightSidebar.terminal.splitHorizontal')}>
                <button
                  type="button"
                  className="rounded-full p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => props.onSplit(pane.id, 'horizontal')}
                  aria-label={props.t('rightSidebar.terminal.splitHorizontal')}
                >
                  <Columns2 size={14} />
                </button>
              </Tip>
              <Tip text={props.t('rightSidebar.terminal.splitVertical')}>
                <button
                  type="button"
                  className="rounded-full p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => props.onSplit(pane.id, 'vertical')}
                  aria-label={props.t('rightSidebar.terminal.splitVertical')}
                >
                  <Rows2 size={14} />
                </button>
              </Tip>
            </>
          )}
          {canClose && (
            <Tip text={props.t('rightSidebar.terminal.closePane')}>
              <button
                type="button"
                className="rounded-full p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => props.onClose(pane.id)}
                aria-label={props.t('rightSidebar.terminal.closePane')}
              >
                <X size={12} />
              </button>
            </Tip>
          )}
        </div>
      </div>
      <DropdownMenu open={urlMenu !== null} onOpenChange={open => { if (!open) setUrlMenu(null); }}>
        <DropdownMenuTrigger asChild><span style={{ position: 'fixed', left: urlMenu?.x ?? 0, top: urlMenu?.y ?? 0, width: 1, height: 1 }} /></DropdownMenuTrigger>
        <DropdownMenuContent><DropdownMenuItem onSelect={() => { if (urlMenu) void openUrlInSidebarBrowser(props.sessionId, urlMenu.url).catch(() => toast.error(props.t('rightSidebar.terminal.actionFailed'))); }}>{props.t('rightSidebar.workbench.openInLex')}</DropdownMenuItem></DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu open={menu !== null} onOpenChange={open => { if (!open) setMenu(null); }}>
        <DropdownMenuTrigger asChild><span style={{ position: 'fixed', left: menu?.x ?? 0, top: menu?.y ?? 0, width: 1, height: 1 }} /></DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={props.onSearch}>{props.t('rightSidebar.workbench.searchOutput')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setRenaming(true)}>{props.t('rightSidebar.workbench.rename')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={props.onZoom}>{props.t(props.zoomed ? 'rightSidebar.workbench.restorePane' : 'rightSidebar.workbench.zoomPane')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {renaming && <RenameDialog initialValue={pane.title} onClose={() => setRenaming(false)} onSave={async title => {
        await window.electronAPI.terminal.rename(ptyId, title);
        props.onPatchPane(pane.id, { title });
      }} />}
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
          <button
            type="button"
            className="ml-2 rounded-full px-2 py-1 hover:bg-[var(--surface-hover)]"
            disabled={restarting}
            onClick={() => void restart()}
          >
            {props.t('rightSidebar.terminal.restart')}
          </button>
        </div>
      )}
    </div>
  );
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
