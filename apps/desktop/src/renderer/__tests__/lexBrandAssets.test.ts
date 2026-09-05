import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const rendererRoot = resolve(__dirname, '..');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const ASSISTANT_ASSETS = [
  ['lex-assistant-master.png', 1868, 1868],
  ['lex-assistant-hero.png', 934, 934],
  ['lex-assistant-avatar.png', 200, 200],
  ['lex-assistant-share.png', 1024, 1024],
] as const;

function readPngHeader(fileName: string) {
  const bytes = readFileSync(resolve(rendererRoot, 'assets', 'branding', fileName));
  return {
    signature: bytes.subarray(0, PNG_SIGNATURE.length),
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colorType: bytes[25],
  };
}

describe('Lex brand asset contract', () => {
  it.each(ASSISTANT_ASSETS)('%s is the expected transparent RGBA PNG', (file, width, height) => {
    const png = readPngHeader(file);

    expect(png.signature.equals(PNG_SIGNATURE)).toBe(true);
    expect([png.width, png.height]).toEqual([width, height]);
    // PNG color type 6 is truecolor with an alpha channel. Keeping that channel is important:
    // every sanctioned surface composites the same character onto both light and dark themes.
    expect(png.colorType).toBe(6);
  });

  it('uses Lex as the renderer document title', () => {
    const html = readFileSync(resolve(rendererRoot, 'index.html'), 'utf8');
    expect(html).toContain('<title>Lex</title>');
    expect(html).not.toContain('<title>Cindy</title>');
  });

  it('wires the Lex wordmark and assistant into every default brand surface', () => {
    const lockup = readFileSync(
      resolve(rendererRoot, 'components', 'branding', 'ThemeBrandLockup.tsx'),
      'utf8',
    );
    const login = readFileSync(
      resolve(rendererRoot, 'components', 'login', 'LoginBrandStage.tsx'),
      'utf8',
    );
    const share = readFileSync(
      resolve(rendererRoot, 'components', 'chat', 'ShareSelectionBar.tsx'),
      'utf8',
    );
    const brandLogo = readFileSync(resolve(rendererRoot, 'hooks', 'useBrandLogo.ts'), 'utf8');
    const sources = [lockup, login, share, brandLogo].join('\n');

    expect(lockup).toContain('lex-assistant-avatar.png');
    expect(login).toContain('lex-assistant-hero.png');
    expect(login).toContain('lex-assistant-master.png');
    expect(login).not.toContain('assets/login/slogan');
    expect(login).not.toContain('login-slogan');
    expect(share).toContain('lex-assistant-share.png');
    expect(sources).toContain('lex-wordmark.svg');
    expect(sources).toContain('lex-wordmark-dark.svg');

    for (const legacyAsset of [
      'head-image-light.png',
      'head-image-dark.png',
      'cindy-avatar-account.png',
    ]) {
      expect(sources).not.toContain(legacyAsset);
    }
  });

});
