// @vitest-environment jsdom
import { useRef } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAgentPresentationFocus } from '../useAgentPresentationFocus';

function View({ mode, scope = 'owner/task', enabled = true }: {
  mode: 'gui' | 'tui'; scope?: string; enabled?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  useAgentPresentationFocus(container, mode, scope, enabled);
  return <div ref={container}>
    <div data-chat-composer-stack>
      <div contentEditable suppressContentEditableWarning data-testid="composer">unsent draft</div>
    </div>
    <button>Other control</button>
  </div>;
}

let frames: Map<number, FrameRequestCallback>;
let nextId = 0;
beforeEach(() => {
  frames = new Map();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    const id = ++nextId; frames.set(id, callback); return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function flushFrame() {
  act(() => {
    const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback(0);
  });
}

it('focuses the existing composer and keeps its draft when returning from TUI', () => {
  const ui = render(<View mode="tui" />);
  const editor = screen.getByTestId('composer');
  ui.rerender(<View mode="gui" />);
  flushFrame();
  expect(document.activeElement).toBe(editor);
  expect(screen.getByTestId('composer')).toBe(editor);
  expect(editor.textContent).toBe('unsent draft');
});

it('does not focus on initial GUI mount or a task/account change', () => {
  const ui = render(<View mode="gui" />);
  flushFrame();
  expect(document.activeElement).toBe(document.body);
  ui.rerender(<View mode="tui" />);
  ui.rerender(<View mode="gui" scope="other-owner/task" />);
  flushFrame();
  expect(document.activeElement).toBe(document.body);
});

it('cancels delayed GUI focus when switching back to TUI', () => {
  const ui = render(<View mode="tui" />);
  ui.rerender(<View mode="gui" />);
  ui.rerender(<View mode="tui" />);
  flushFrame();
  expect(document.activeElement).toBe(document.body);
});

it('does not steal focus after the user selects another control', () => {
  const ui = render(<View mode="tui" />);
  ui.rerender(<View mode="gui" />);
  const other = screen.getByRole('button'); other.focus();
  flushFrame();
  expect(document.activeElement).toBe(other);
});

it('does not focus a hidden, embedded or read-only view', () => {
  const ui = render(<View mode="tui" />);
  ui.rerender(<View mode="gui" enabled={false} />);
  flushFrame();
  expect(document.activeElement).toBe(document.body);
});
