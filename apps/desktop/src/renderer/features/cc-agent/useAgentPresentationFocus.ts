import { useEffect, useRef, type RefObject } from 'react';
import {
  hasFocusMovedToInteractiveElement,
  hasNonCollapsedSelectionOutsideComposer,
} from '@/components/new-chat/useComposerSendFocusRestore';

/** Restore the mounted GUI composer after leaving TUI, without changing its draft. */
export function useAgentPresentationFocus(
  container: RefObject<HTMLElement | null>,
  mode: 'gui' | 'tui',
  scope: string,
  enabled: boolean,
) {
  const previous = useRef({ mode, scope });
  useEffect(() => {
    const before = previous.current;
    previous.current = { mode, scope };
    if (!enabled || before.scope !== scope || before.mode !== 'tui' || mode !== 'gui') return;
    const focusAnchor = document.activeElement;
    const frame = window.requestAnimationFrame(() => {
      const editor = container.current?.querySelector<HTMLElement>(
        '[data-chat-composer-stack] [contenteditable="true"]',
      );
      if (!editor?.isConnected || editor.closest('[inert]')) return;
      if (hasFocusMovedToInteractiveElement(focusAnchor, editor) ||
          hasNonCollapsedSelectionOutsideComposer(editor)) return;
      editor.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [container, mode, scope, enabled]);
}
