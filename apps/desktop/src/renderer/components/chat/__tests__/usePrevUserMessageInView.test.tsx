// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePrevUserMessageInView } from '../usePrevUserMessageInView';

function fixture(count: number, mountedStart = 0, mountedEnd = count) {
  const root = document.createElement('div');
  const items = document.createElement('div');
  items.className = 'msg-stream-items';
  root.append(items);
  document.body.append(root);
  const reads = { outer: 0, inner: 0 };
  const rect = (top: number, height: number) => ({ top, bottom: top + height, height }) as DOMRect;
  root.getBoundingClientRect = () => rect(50, 500);
  const ids = Array.from({ length: count }, (_, i) => `question-${i}`);
  for (let i = mountedStart; i < mountedEnd; i++) {
    const wrapper = document.createElement('section');
    const message = document.createElement('div');
    message.dataset.userMsgId = ids[i];
    wrapper.getBoundingClientRect = () => {
      reads.outer++;
      return rect(50 + (i - mountedStart) * 110 - root.scrollTop, 100);
    };
    message.getBoundingClientRect = () => {
      reads.inner++;
      return rect(50 + (i - mountedStart) * 110 - root.scrollTop, 80);
    };
    wrapper.append(message);
    items.append(wrapper);
  }
  return { root, items, ids, reads };
}

function Harness({ root, ids }: { root: HTMLDivElement; ids: string[] }) {
  const scrollRef = useRef(root);
  const { displayId, suppressAfterClick } = usePrevUserMessageInView({
    scrollRef,
    userMessageIds: ids,
  });
  return <button onClick={suppressAfterClick}>{displayId ?? 'none'}</button>;
}

function scroll(root: HTMLDivElement, top: number) {
  act(() => {
    root.scrollTop = top;
    fireEvent.scroll(root);
    vi.advanceTimersByTime(20);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 16),
  );
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('previous question during long conversation scrolling', () => {
  it('keeps the previous question correct without measuring hundreds of offscreen message subtrees', () => {
    const { root, ids, reads } = fixture(1000);
    const query = vi.spyOn(root, 'querySelector');
    render(<Harness root={root} ids={ids} />);
    scroll(root, 60000);
    reads.outer = reads.inner = 0;
    query.mockClear();
    scroll(root, 50000);
    expect(screen.getByRole('button').textContent).toBe('question-453');
    expect(reads.inner).toBeLessThanOrEqual(2);
    expect(reads.outer).toBeLessThanOrEqual(12);
    expect(query).not.toHaveBeenCalled();
  });

  it('uses the actual message bottom when wrapper padding still crosses the viewport', () => {
    const { root, ids } = fixture(8);
    render(<Harness root={root} ids={ids} />);
    scroll(root, 200);
    scroll(root, 90);
    expect(screen.getByRole('button').textContent).toBe('question-0');
    scroll(root, 72);
    expect(screen.getByRole('button').textContent).toBe('none');
  });

  it('ignores IDs outside a bounded mounted history window and reacts to DOM removal', () => {
    const { root, items, ids } = fixture(100, 30, 40);
    render(<Harness root={root} ids={ids} />);
    scroll(root, 700);
    scroll(root, 600);
    expect(screen.getByRole('button').textContent).toBe('question-34');
    items.children[4].remove();
    scroll(root, 590);
    expect(screen.getByRole('button').textContent).toBe('question-33');
  });

  it('preserves downward/idle hiding and click suppression until explicit input', () => {
    const { root, ids } = fixture(10);
    render(<Harness root={root} ids={ids} />);
    scroll(root, 500);
    expect(screen.getByRole('button').textContent).toBe('none');
    scroll(root, 400);
    expect(screen.getByRole('button').textContent).toBe('question-2');
    fireEvent.click(screen.getByRole('button'));
    scroll(root, 390);
    expect(screen.getByRole('button').textContent).toBe('none');
    fireEvent.wheel(root, { deltaY: -10 });
    expect(screen.getByRole('button').textContent).toBe('question-2');
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByRole('button').textContent).toBe('none');
  });
});
