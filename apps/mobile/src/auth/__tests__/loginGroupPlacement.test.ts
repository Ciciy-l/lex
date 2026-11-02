import { describe, expect, it } from 'vitest';
import type { WindowGeometry } from '../../platform/windowGeometry';
import { resolveLoginGroupPlacement, resolveLoginWindowSurface } from '../loginGroupPlacement';
import { resolveLoginSurface } from '../loginSkinLayout';

const closed: WindowGeometry = {
  width: 466, height: 678, insets: { top: 0, right: 0, bottom: 20, left: 0 },
  regularWidth: false, regularHeight: true, barEdge: 'none', reservedRegionsSupported: true,
  regions: [{ kind: 'occlusion', x: 382, y: 0, width: 84, height: 170 }],
};
const place = (g: WindowGeometry, keyboard = 0) =>
  resolveLoginGroupPlacement(g, resolveLoginSurface(g.width, g.height), 622, keyboard);

describe('login group placement', () => {
  it.each([[320, 568], [390, 844], [844, 390], [768, 1024]])(
    'keeps a physical-height realm header and the form inside %i×%i', (width, height) => {
      const g = { ...closed, width, height, regions: [],
        insets: { top: 44, bottom: 34, left: 0, right: 0 } };
      const stage = resolveLoginWindowSurface(g);
      const header = 60;
      const frame = resolveLoginGroupPlacement(g, stage, 622, 0, header);
      const original = resolveLoginGroupPlacement(g, stage, 622, 0);
      expect(frame.scale).toBe(original.scale);
      expect(frame.y).toBeGreaterThanOrEqual(g.insets.top);
      expect(frame.y + frame.height).toBeLessThanOrEqual(height - g.insets.bottom);
      expect(frame.height).toBeCloseTo(Math.min(header + 622 * frame.scale, height - 78));
      // In a keyboard-constrained viewport the entire header + form is scrollable.
      const raised = resolveLoginGroupPlacement(g, stage, 622, height / 2, header);
      expect(raised.y + raised.height).toBeLessThanOrEqual(height / 2);
      expect(raised.height).toBeLessThan(header + 622 * raised.scale);
    },
  );
  it.each(['left', 'right'] as const)('fits the outer landscape form with the %s safe edge', (edge) => {
    const g = { ...closed, width: 678, height: 466, regions: [],
      insets: { top: 0, bottom: 34, left: 0, right: 0, [edge]: 84 } };
    const stage = resolveLoginWindowSurface(g);
    const frame = resolveLoginGroupPlacement(g, stage, 622, 0);
    expect(stage.mode).toBe('compact-wide');
    expect(frame.scale * 80).toBeGreaterThanOrEqual(44);
    expect(frame.x).toBeGreaterThan(stage.offsetX + (stage.cindy.x + stage.cindy.w) * stage.scale);
    expect(frame.x + frame.width).toBeLessThanOrEqual(g.width - g.insets.right);
    expect(frame.height).toBeCloseTo(622 * frame.scale);
    expect(frame.y + frame.height).toBeLessThanOrEqual(g.height - g.insets.bottom);
    const keyboard = resolveLoginGroupPlacement(g, stage, 622, 230);
    expect(keyboard.scale).toBe(frame.scale);
    expect(keyboard.y + keyboard.height).toBeLessThanOrEqual(236);
    expect(keyboard.height).toBeLessThan(622 * keyboard.scale);
  });
  it.each(['left', 'right'] as const)('aligns brand and form beside the %s system bar', (barEdge) => {
    const g = { ...closed, barEdge, insets: { ...closed.insets, [barEdge]: 84 } };
    const stage = resolveLoginWindowSurface(g);
    const content = g;
    const frame = resolveLoginGroupPlacement(content, stage, 622, 0);
    const centre = content.insets.left + (g.width - content.insets.left - content.insets.right) / 2;
    expect(frame.x + frame.width / 2).toBeCloseTo(centre);
    expect(stage.offsetX + 375 * stage.scale).toBeCloseTo(centre);
    expect(stage.viewportWidth).toBe(g.width);
  });
  it('keeps the closed outer-screen form centred below the camera', () => {
    const frame = place(closed);
    expect(frame.x + frame.width / 2).toBeCloseTo(closed.width / 2);
    expect(frame.y).toBeGreaterThanOrEqual(170);
    expect(frame).toEqual(place({ ...closed, regions: [] }));
  });
  it('still avoids a camera that actually overlaps the form', () => {
    const frame = place({ ...closed, regions: [{ ...closed.regions[0]!, height: 400 }] });
    expect(frame.x + frame.width).toBeLessThanOrEqual(382);
  });
  it('respects asymmetric safe edges without a camera', () => {
    const frame = place({ ...closed, insets: { top: 40, right: 60, bottom: 20, left: 0 }, regions: [] });
    expect(frame.x + frame.width).toBeLessThanOrEqual(406);
    expect(frame.y).toBeGreaterThanOrEqual(40);
    expect(frame.y + frame.height).toBeLessThanOrEqual(658);
  });
  it('keeps the form below a fold, then above it when the keyboard covers the lower pane', () => {
    const folded = { ...closed, width: 900, height: 700,
      regions: [{ kind: 'division' as const, x: 0, y: 300, width: 900, height: 30 }] };
    expect(place(folded).y).toBeGreaterThanOrEqual(330);
    const raised = place(folded, 350);
    expect(raised.y + raised.height).toBeLessThanOrEqual(300);
  });
});
