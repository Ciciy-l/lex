import { describe, expect, it } from 'vitest';
import { resolveLexBrandLayout } from '@/auth/lexBrandLayout';
import { resolveLoginSurface } from '@/auth/loginSkinLayout';

const screens = [
  [320, 568], [360, 640], [390, 844], [412, 915],
  [568, 320], [844, 390], [744, 1133], [1180, 820],
] as const;

describe('Lex splash and login artwork', () => {
  it.each(screens)('%sx%s keeps the splash portrait, wordmark and spinner separate inside safe bounds', (width, height) => {
    const insets = { top: height > width ? 44 : 0, bottom: 24, left: width > height ? 32 : 0, right: 0 };
    const stage = resolveLoginSurface(width, height);
    const { splash, spinner } = resolveLexBrandLayout(stage, insets);
    const boxes = [splash.hero, splash.word, { x: spinner.x, y: spinner.y, w: spinner.size, h: spinner.size }];
    for (const box of boxes) {
      expect(box.w).toBeGreaterThan(0);
      expect(box.h).toBeGreaterThan(0);
      expect(box.x * stage.scale + stage.offsetX).toBeGreaterThanOrEqual(insets.left);
      expect(box.y * stage.scale + stage.offsetY).toBeGreaterThanOrEqual(insets.top);
      expect((box.x + box.w) * stage.scale + stage.offsetX).toBeLessThanOrEqual(width - insets.right);
      expect((box.y + box.h) * stage.scale + stage.offsetY).toBeLessThanOrEqual(height - insets.bottom);
    }
    expect(splash.hero.y + splash.hero.h).toBeLessThan(splash.word.y);
    expect(splash.word.y + splash.word.h).toBeLessThan(spinner.y);
    expect(splash.hero.w).toBe(splash.hero.h);
    expect(splash.word.w / splash.word.h).toBeCloseTo(423 / 145);
    const upperSpace = splash.hero.y * stage.scale + stage.offsetY - insets.top;
    const lowerSpace = height - insets.bottom - ((spinner.y + spinner.size) * stage.scale + stage.offsetY);
    expect(upperSpace).toBeCloseTo(lowerSpace);
    // Portrait phones devote most of their usable width to the character.
    if (height > width && width < 700) expect(splash.hero.w * stage.scale).toBeGreaterThan(width * 0.8);
  });

  it.each(screens.filter(([w, h]) => h > w))('%sx%s preserves form placement and keeps the login logo below the portrait', (width, height) => {
    const stage = resolveLoginSurface(width, height);
    const originalForm = { x: stage.loginX, y: stage.loginY, scale: stage.loginGroupScale };
    const { login } = resolveLexBrandLayout(stage, { top: 44, bottom: 24, left: 0, right: 0 });
    expect(login.hero.y + login.hero.h).toBeLessThan(login.word.y);
    expect(login.word.y + login.word.h).toBeLessThan(stage.loginY);
    expect({ x: stage.loginX, y: stage.loginY, scale: stage.loginGroupScale }).toEqual(originalForm);
    expect(login.hero.y * stage.scale + stage.offsetY).toBeGreaterThanOrEqual(44);
  });
});
