import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import { moveTerminalPane, type TerminalDropZone, type TerminalState } from '../terminal-layout';

interface DropTarget {
  paneId: string;
  zone: TerminalDropZone;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface DragPreview {
  sourcePaneId: string;
  target: DropTarget | null;
}

export function useTerminalPaneDrag(
  rootRef: RefObject<HTMLDivElement | null>,
  state: TerminalState,
  active: boolean | undefined,
  onMove: (source: string, target: string, zone: TerminalDropZone) => void,
) {
  const [preview, setPreview] = useState<DragPreview | null>(null);
  const latestRef = useRef({ state, onMove });
  latestRef.current = { state, onMove };
  const cleanupRef = useRef<((commit: boolean) => void) | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => () => cleanupRef.current?.(false), [state.layout, active]);

  const beginDrag = useCallback(
    (paneId: string, event: ReactPointerEvent<HTMLButtonElement>) => {
      const root = rootRef.current;
      if (
        !root ||
        event.button !== 0 ||
        event.ctrlKey ||
        Object.keys(latestRef.current.state.panes).length < 2
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      cleanupRef.current?.(false);
      suppressClickRef.current = false;
      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      let dragging = false;
      let target: DropTarget | null = null;

      const updateTarget = (clientX: number, clientY: number) => {
        target = null;
        const rootBounds = root.getBoundingClientRect();
        for (const pane of root.querySelectorAll<HTMLElement>('[data-terminal-pane-id]')) {
          const targetId = pane.dataset.terminalPaneId;
          if (!targetId || targetId === paneId) continue;
          const bounds = pane.getBoundingClientRect();
          if (
            bounds.width <= 0 ||
            bounds.height <= 0 ||
            clientX < bounds.left ||
            clientX > bounds.right ||
            clientY < bounds.top ||
            clientY > bounds.bottom
          )
            continue;
          const relX = (clientX - bounds.left) / bounds.width;
          const relY = (clientY - bounds.top) / bounds.height;
          const distances: Array<[TerminalDropZone, number]> = [
            ['top', relY],
            ['bottom', 1 - relY],
            ['left', relX],
            ['right', 1 - relX],
          ];
          const zone = distances.reduce((nearest, candidate) =>
            candidate[1] < nearest[1] ? candidate : nearest,
          )[0];
          const current = latestRef.current.state;
          if (moveTerminalPane(current, paneId, targetId, zone) === current) break;
          target = {
            paneId: targetId,
            zone,
            left: bounds.left - rootBounds.left + (zone === 'right' ? bounds.width / 2 : 0),
            top: bounds.top - rootBounds.top + (zone === 'bottom' ? bounds.height / 2 : 0),
            width: zone === 'left' || zone === 'right' ? bounds.width / 2 : bounds.width,
            height: zone === 'top' || zone === 'bottom' ? bounds.height / 2 : bounds.height,
          };
          break;
        }
        setPreview({ sourcePaneId: paneId, target });
      };

      const finish = (commit: boolean) => {
        if (cleanupRef.current !== finish) return;
        cleanupRef.current = null;
        window.removeEventListener('pointermove', onMovePointer, true);
        window.removeEventListener('pointerup', onPointerUp, true);
        window.removeEventListener('pointercancel', onPointerCancel, true);
        window.removeEventListener('blur', onBlur, true);
        window.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        handle.removeEventListener('lostpointercapture', onPointerCancel);
        releasePointerCapture(handle, pointerId);
        setPreview(null);
        if (commit && dragging && target)
          latestRef.current.onMove(paneId, target.paneId, target.zone);
      };
      const onMovePointer = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId !== pointerId) return;
        if (
          !dragging &&
          Math.hypot(pointerEvent.clientX - startX, pointerEvent.clientY - startY) >= 5
        ) {
          dragging = true;
          suppressClickRef.current = true;
        }
        if (dragging) updateTarget(pointerEvent.clientX, pointerEvent.clientY);
      };
      const onPointerUp = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId !== pointerId) return;
        if (dragging) updateTarget(pointerEvent.clientX, pointerEvent.clientY);
        finish(true);
      };
      const onPointerCancel = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId === pointerId) finish(false);
      };
      const onBlur = () => finish(false);
      const onVisibilityChange = () => {
        if (document.visibilityState === 'hidden') finish(false);
      };
      const onKeyDown = (keyboardEvent: KeyboardEvent) => {
        if (keyboardEvent.key !== 'Escape') return;
        keyboardEvent.preventDefault();
        keyboardEvent.stopPropagation();
        finish(false);
      };
      cleanupRef.current = finish;
      window.addEventListener('pointermove', onMovePointer, true);
      window.addEventListener('pointerup', onPointerUp, true);
      window.addEventListener('pointercancel', onPointerCancel, true);
      window.addEventListener('blur', onBlur, true);
      window.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('visibilitychange', onVisibilityChange);
      handle.addEventListener('lostpointercapture', onPointerCancel);
      try {
        handle.setPointerCapture?.(pointerId);
      } catch {
        return;
      }
    },
    [rootRef],
  );

  const onPointerDownCapture = useCallback(() => {
    if (!cleanupRef.current) suppressClickRef.current = false;
  }, []);

  const onClickCapture = useCallback((event: ReactMouseEvent) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return { preview, beginDrag, onClickCapture, onPointerDownCapture };
}

function releasePointerCapture(handle: HTMLElement, pointerId: number): void {
  try {
    if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
  } catch {
    return;
  }
}
