import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSynchronizedOutputWriter } from '../lib/synchronizedOutput';

const ESC = String.fromCharCode(27);
const START = ESC + '[?2026h';
const END = ESC + '[?2026l';
const HIDE = ESC + '[?25l';
const SHOW = ESC + '[?25h';
const UPDATE = START + HIDE + ESC + '[34;1H' + SHOW + ESC + '[0 q';
const RESTORE = HIDE + ESC + '[39;1H' + ESC + '[34;1Hreply' + ESC + '[37;3H' + SHOW;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Windows synchronized output coalescing', () => {
  it('leaves ordinary output and cursor blinking commands immediate', () => {
    const write = vi.fn();
    const output = createSynchronizedOutputWriter(write);
    output.push('shell output');
    output.push(ESC + '[0 q');
    expect(write.mock.calls).toEqual([['shell output'], [ESC + '[0 q']]);
    expect(vi.getTimerCount()).toBe(0);
    output.dispose();
  });

  it('coalesces the observed frame ending and its 18ms-later input cursor restore without altering bytes', () => {
    const write = vi.fn();
    const output = createSynchronizedOutputWriter(write);
    output.push(UPDATE);
    output.push(END);
    vi.advanceTimersByTime(18);
    expect(write).not.toHaveBeenCalled();
    output.push(RESTORE);
    // A complete restoration is safe to deliver without waiting out the timer.
    expect(write).toHaveBeenCalledExactlyOnceWith(UPDATE + END + RESTORE);
    expect(vi.getTimerCount()).toBe(0);
    output.dispose();
  });

  it('recognizes start and end markers split at every boundary', () => {
    for (let startSplit = 1; startSplit < START.length; startSplit++) {
      for (let endSplit = 1; endSplit < END.length; endSplit++) {
        const write = vi.fn();
        const output = createSynchronizedOutputWriter(write);
        output.push(START.slice(0, startSplit));
        output.push(START.slice(startSplit) + HIDE + 'reply');
        output.push(END.slice(0, endSplit));
        output.push(END.slice(endSplit));
        vi.advanceTimersByTime(18);
        output.push(RESTORE);
        expect(write).toHaveBeenCalledTimes(2);
        expect(write.mock.calls.flat().join('')).toBe(START + HIDE + 'reply' + END + RESTORE);
        output.dispose();
      }
    }
  });

  it('does not hold terminal query replies behind a frame timer', () => {
    for (const query of [ESC + '[6n', ESC + '[?2026$p', ESC + ']11;?' + String.fromCharCode(7)]) {
      const write = vi.fn();
      const output = createSynchronizedOutputWriter(write);
      output.push(START);
      output.push(query);
      expect(write).toHaveBeenCalledExactlyOnceWith(START + query);
      output.dispose();
    }
  });

  it('gives a late frame end its own restore window', () => {
    const write = vi.fn();
    const output = createSynchronizedOutputWriter(write);
    output.push(UPDATE);
    vi.advanceTimersByTime(90);
    output.push(END);
    vi.advanceTimersByTime(18);
    expect(write).not.toHaveBeenCalled();
    output.push(RESTORE);
    expect(write).toHaveBeenCalledExactlyOnceWith(UPDATE + END + RESTORE);
    output.dispose();
  });

  it('waits for a delayed and fragmented restoration when output pauses', () => {
    for (let split = 1; split < RESTORE.length; split++) {
      const write = vi.fn();
      const output = createSynchronizedOutputWriter(write);
      output.push(UPDATE + END);
      vi.advanceTimersByTime(48);
      output.push(RESTORE.slice(0, split));
      vi.advanceTimersByTime(16);
      expect(write).not.toHaveBeenCalled();
      output.push(RESTORE.slice(split));
      expect(write).toHaveBeenCalledExactlyOnceWith(UPDATE + END + RESTORE);
      expect(vi.getTimerCount()).toBe(0);
      output.dispose();
    }
  });

  it('does not let a previous frame release a newly opened frame', () => {
    const write = vi.fn();
    const output = createSynchronizedOutputWriter(write);
    const first = START + HIDE + 'first' + END;
    output.push(first);
    vi.advanceTimersByTime(25);
    output.push(UPDATE);
    vi.advanceTimersByTime(18);
    expect(write).not.toHaveBeenCalled();
    output.push(END + RESTORE);
    expect(write).toHaveBeenCalledExactlyOnceWith(first + UPDATE + END + RESTORE);
    output.dispose();
  });

  it('restarts the restore window from the latest frame end', () => {
    const write = vi.fn();
    const output = createSynchronizedOutputWriter(write);
    output.push(UPDATE + END);
    vi.advanceTimersByTime(90);
    output.push(UPDATE + END);
    vi.advanceTimersByTime(18);
    expect(write).not.toHaveBeenCalled();
    output.push(RESTORE);
    expect(write).toHaveBeenCalledExactlyOnceWith(UPDATE + END + UPDATE + END + RESTORE);
    output.dispose();
  });

  it('still releases a shown cursor if no restoration ever arrives', () => {
    const write = vi.fn();
    const output = createSynchronizedOutputWriter(write);
    output.push(UPDATE + END);
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledExactlyOnceWith(UPDATE + END);
    expect(vi.getTimerCount()).toBe(0);
    output.dispose();
  });

  it('does not reuse a restoration from before the latest frame in the same chunk', () => {
    for (const next of [START + HIDE + 'next' + END, UPDATE + END]) {
      const write = vi.fn();
      const output = createSynchronizedOutputWriter(write);
      output.push(UPDATE + END);
      vi.advanceTimersByTime(18);
      output.push(RESTORE + next);
      expect(write).not.toHaveBeenCalled();
      vi.advanceTimersByTime(next === UPDATE + END ? 100 : 32);
      expect(write).toHaveBeenCalledExactlyOnceWith(UPDATE + END + RESTORE + next);
      output.dispose();
    }
  });

  it('does not treat an OSC payload as a real synchronized redraw', () => {
    const write = vi.fn();
    const output = createSynchronizedOutputWriter(write);
    const payload = ESC + ']0;' + START + HIDE + END + String.fromCharCode(7);
    output.push(payload);
    expect(write).toHaveBeenCalledExactlyOnceWith(payload);
    expect(vi.getTimerCount()).toBe(0);
    output.dispose();
  });

  it('caps the entire batch even if consecutive frame ends keep extending the grace', () => {
    const write = vi.fn();
    const output = createSynchronizedOutputWriter(write);
    output.push(UPDATE + END);
    for (let step = 0; step < 9; step++) {
      vi.advanceTimersByTime(25);
      output.push(UPDATE + END);
    }
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(25);
    expect(write).toHaveBeenCalledExactlyOnceWith((UPDATE + END).repeat(10));
    expect(vi.getTimerCount()).toBe(0);
    output.dispose();
  });

  it('recognizes queries split at every byte including OSC terminators', () => {
    for (const query of [ESC + '[6n', ESC + '[?2026$p', ESC + ']11;?' + ESC + String.fromCharCode(92)]) {
      for (let split = 1; split < query.length; split++) {
        const write = vi.fn();
        const output = createSynchronizedOutputWriter(write);
        output.push(START);
        output.push(query.slice(0, split));
        output.push(query.slice(split));
        expect(write.mock.calls.flat().join('')).toBe(START + query);
        output.dispose();
      }
    }
  });

  it('flushes incomplete frames at a fixed deadline even while output continues', () => {
    const write = vi.fn();
    const output = createSynchronizedOutputWriter(write);
    output.push(START);
    for (let step = 0; step < 9; step++) {
      vi.advanceTimersByTime(10);
      output.push('x');
    }
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10);
    expect(write).toHaveBeenCalledExactlyOnceWith(START + 'x'.repeat(9));
    output.dispose();
  });

  it('preserves a legitimate final hidden cursor and releases frames without a restore', () => {
    const write = vi.fn();
    const output = createSynchronizedOutputWriter(write);
    output.push(START + HIDE + 'reply' + END);
    vi.advanceTimersByTime(32);
    expect(write).toHaveBeenCalledExactlyOnceWith(START + HIDE + 'reply' + END);
    output.dispose();
  });

  it('bounds held data without dropping or reordering output', () => {
    const write = vi.fn();
    const output = createSynchronizedOutputWriter(write);
    const content = 'x'.repeat(256 * 1024);
    output.push(START);
    output.push(content);
    expect(write).toHaveBeenCalledExactlyOnceWith(START + content);
    output.dispose();
  });

  it('cancels pending delivery on disposal and ignores subsequent output', () => {
    const write = vi.fn();
    const output = createSynchronizedOutputWriter(write);
    output.push(UPDATE + END);
    output.dispose();
    output.push(RESTORE);
    vi.runAllTimers();
    expect(write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
