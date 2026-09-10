import { expect, it } from 'vitest';
import '../../../../../themes/colors';
import { builtinThemes } from '../../../../../themes/registry';
import { resolveThemeValue } from '../../../../../themes/theme-service';
import { colorRegistry } from '../../../../../themes/color-registry';
import type { Theme } from '../../../../../themes/types';

const tokens = Array.from({ length: 6 }, (_, index) => 'git-graph-lane-' + (index + 1));
function luminance(value: string): number {
  expect(value).toMatch(/^#[a-f0-9]{6}$/i);
  const channels = [1, 3, 5]
    .map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function resolve(theme: Theme, token: string): string {
  const value = resolveThemeValue(theme, token)!;
  const alias = /^var\(--([\w-]+)\)$/.exec(value);
  return alias ? resolve(theme, alias[1]) : value;
}
it('registers six distinct mode-adaptive data colors without reusing status or process tokens', () => {
  for (const mode of ['light', 'dark'] as const) {
    expect(new Set(tokens.map((token) => colorRegistry.resolveDefault(token, mode))).size).toBe(6);
  }
  for (const token of tokens)
    expect(colorRegistry.resolveDefault(token, 'light')).not.toBe(
      colorRegistry.resolveDefault(token, 'dark'),
    );
});
it('keeps graph lines above 3:1 against every builtin theme surface', () => {
  for (const theme of Object.values(builtinThemes))
    for (const token of tokens) {
      const foreground = luminance(resolve(theme, token));
      const background = luminance(resolve(theme, 'surface'));
      expect(
        (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
        theme.id + '/' + token,
      ).toBeGreaterThanOrEqual(3);
    }
});
