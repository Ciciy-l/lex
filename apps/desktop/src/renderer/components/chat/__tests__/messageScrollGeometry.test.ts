import { describe, expect, it, vi } from 'vitest';
import { findViewportItem } from '../messageScrollGeometry';

const item = (top: number, bottom: number) =>
  ({
    getBoundingClientRect: vi.fn(() => ({ top, bottom }) as DOMRect),
  }) as unknown as HTMLElement;

describe('viewport anchor geometry', () => {
  it('finds the exact viewport item in a long expanded history with logarithmic box reads', () => {
    const items = Array.from({ length: 4096 }, (_, index) => item(index * 114, index * 114 + 100));
    const result = findViewportItem(items, 3000 * 114 + 20);
    expect(result?.index).toBe(3000);
    expect(result?.element).toBe(items[3000]);
    expect(result?.rect.top).toBe(3000 * 114);
    expect(
      items.reduce(
        (sum, element) => sum + vi.mocked(element.getBoundingClientRect).mock.calls.length,
        0,
      ),
    ).toBeLessThanOrEqual(13);
  });

  it('keeps strict bottom-edge and gap semantics, including empty and zero-height items', () => {
    const items = [item(0, 80), item(94, 94), item(108, 240)];
    expect(findViewportItem([], 0)).toBeNull();
    expect(findViewportItem(items, -10)?.index).toBe(0);
    expect(findViewportItem(items, 79)?.index).toBe(0);
    expect(findViewportItem(items, 80)?.index).toBe(1);
    expect(findViewportItem(items, 94)?.index).toBe(2);
    expect(findViewportItem(items, 240)).toBeNull();
  });

  it('reads fresh geometry after content height changes rather than retaining stale offsets', () => {
    const items = [item(0, 100), item(114, 200)];
    expect(findViewportItem(items, 150)?.index).toBe(1);
    vi.mocked(items[0].getBoundingClientRect).mockReturnValue({ top: 0, bottom: 180 } as DOMRect);
    vi.mocked(items[1].getBoundingClientRect).mockReturnValue({ top: 194, bottom: 280 } as DOMRect);
    expect(findViewportItem(items, 150)?.index).toBe(0);
  });
});
