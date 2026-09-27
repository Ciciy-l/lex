// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettingsSectionTarget } from '../useSettingsSectionTarget';

let frameCallbacks: Map<number, FrameRequestCallback>;
let nextFrameId: number;

function rectangle(top: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    right: 100,
    bottom: top + 20,
    left: 0,
    width: 100,
    height: 20,
    toJSON: () => ({}),
  };
}

function SettingsTargetHarness({ fallbackOutside = false }: { fallbackOutside?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useSettingsSectionTarget('missing-direct-target', scrollRef, 'settings-search', 'fallback-target');

  return (
    <>
      <div ref={scrollRef} data-testid="scroll-container">
        {!fallbackOutside ? <div id="fallback-target" data-testid="fallback-target" /> : null}
      </div>
      {fallbackOutside ? <div id="fallback-target" data-testid="fallback-target" /> : null}
    </>
  );
}

beforeEach(() => {
  frameCallbacks = new Map();
  nextFrameId = 1;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const frameId = nextFrameId++;
    frameCallbacks.set(frameId, callback);
    return frameId;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useSettingsSectionTarget', () => {
  it('uses an in-container fallback anchor and removes its highlight on cleanup', () => {
    const { unmount } = render(<SettingsTargetHarness />);
    const container = screen.getByTestId('scroll-container');
    const fallback = screen.getByTestId('fallback-target');
    const scrollTo = vi.fn();
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    Object.defineProperty(container, 'scrollTop', { configurable: true, value: 20 });
    Object.defineProperty(container, 'scrollTo', { configurable: true, value: scrollTo });
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(rectangle(100));
    vi.spyOn(fallback, 'getBoundingClientRect').mockReturnValue(rectangle(250));

    const [[, callback]] = [...frameCallbacks.entries()];
    act(() => callback(0));

    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 162 }));
    expect(fallback.classList.contains('settings-search-target-highlight')).toBe(true);

    unmount();

    expect(window.cancelAnimationFrame).toHaveBeenCalled();
    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(fallback.classList.contains('settings-search-target-highlight')).toBe(false);
  });

  it('fails closed when neither the direct anchor nor an in-container fallback exists', () => {
    const { unmount } = render(<SettingsTargetHarness fallbackOutside />);
    const container = screen.getByTestId('scroll-container');
    const fallback = screen.getByTestId('fallback-target');
    const scrollTo = vi.fn();
    Object.defineProperty(container, 'scrollTo', { configurable: true, value: scrollTo });
    const [[, callback]] = [...frameCallbacks.entries()];

    act(() => callback(0));

    expect(scrollTo).not.toHaveBeenCalled();
    expect(fallback.classList.contains('settings-search-target-highlight')).toBe(false);

    unmount();
  });
});
