/** Derive small, transparent startup assets without changing the Lex character.
 * Run from any directory: node scripts/generate-lex-startup-art.mjs
 * Desktop uses WebP; Mobile retains PNG for the existing native Image decoder. */
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const require = createRequire(new URL('apps/desktop/package.json', root));
const sharp = require('sharp');
const file = (name) => fileURLToPath(new URL(name, root));
const mask = (await readFile(file('apps/desktop/src/renderer/assets/login/hero-mask.svg'), 'utf8'))
  .replace('width="100%" height="100%"', 'width="934" height="934"');
const portrait = await sharp(file('apps/desktop/src/renderer/assets/branding/lex-assistant-hero.png'))
  .composite([{ input: Buffer.from(mask), blend: 'dest-in' }])
  .webp({ quality: 90, alphaQuality: 100, effort: 6 })
  .toBuffer();
await writeFile(file('apps/desktop/src/renderer/assets/branding/lex-assistant-startup.webp'), portrait);
await sharp(portrait).png({ palette: true, colours: 256, quality: 100, effort: 10 })
  .toFile(file('apps/mobile/assets/lex/assistant-startup.png'));
