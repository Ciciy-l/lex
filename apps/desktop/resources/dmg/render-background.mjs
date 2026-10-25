// Sole source of background.pdf. Run from any directory:
//   node apps/desktop/resources/dmg/render-background.mjs [--check]
// Uses the existing Desktop canvas dependency; no AppKit, system fonts or downloads.
// Finder rasterizes PDF at the display scale; keep the full-resolution Lex images
// and vector arrow instead of exporting the whole page as a low-resolution bitmap.
import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument, createCanvas, loadImage } from '@napi-rs/canvas';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--check')) throw new Error('Usage: node render-background.mjs [--check]');
const target = new URL('./background.pdf', import.meta.url);
const [icon, wordmark] = await Promise.all([
  loadImage(await readFile(new URL('../icon.png', import.meta.url))),
  loadImage(await readFile(new URL('../../src/renderer/assets/login/lex-wordmark.svg', import.meta.url))),
]);
const pdf = new PDFDocument({
  title: 'Lex Installer', creator: 'Lex DMG background generator',
  producer: 'Lex', encodingQuality: 101, rasterDPI: 144, compressionLevel: 9,
});
// Keep the 900×610 page and top-left 660×460 design area in sync with
// createMacDMG in scripts/ci/lib.mjs. Its app/folder centers are (175/485,335).
const ctx = pdf.beginPage(900, 610);
// This static Finder asset retains the existing neutral background in both OS
// appearances. Brand colors come only from the approved assets, not recoloring.
// Rasterize only the neutral fades at 2×: canvas PDF does not preserve the
// transparent gradient's alpha. Keep the artwork and arrow outside this layer.
const background = createCanvas(1800, 1220);
const bg = background.getContext('2d');
bg.scale(2, 2);
const surface = 'rgb(237, 237, 237)';
bg.fillStyle = surface;
bg.fillRect(0, 0, 900, 460);
const bottom = bg.createLinearGradient(0, 460, 0, 610);
bottom.addColorStop(0, surface); bottom.addColorStop(1, 'white');
bg.fillStyle = bottom; bg.fillRect(0, 460, 900, 150);
const right = bg.createLinearGradient(680, 0, 900, 0);
right.addColorStop(0, 'rgba(255, 255, 255, 0)'); right.addColorStop(1, 'white');
bg.fillStyle = right; bg.fillRect(680, 0, 220, 610);
ctx.drawImage(background, 0, 0, 900, 610);

// Existing product mark and wordmark only; no legacy Cindy splash artwork.
ctx.drawImage(icon, 258, 36, 144, 144);
const logoWidth = 110, logoHeight = logoWidth * wordmark.height / wordmark.width;
ctx.drawImage(wordmark, (660 - logoWidth) / 2, 194, logoWidth, logoHeight);

ctx.strokeStyle = 'rgb(158, 158, 158)';
ctx.lineWidth = 5.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
ctx.beginPath();
ctx.moveTo(300, 335); ctx.lineTo(360, 335);
ctx.moveTo(342, 319); ctx.lineTo(360, 335); ctx.lineTo(342, 351);
ctx.stroke();
pdf.endPage();
const bytes = pdf.close();
if (args.includes('--check')) {
  if (!bytes.equals(await readFile(target))) throw new Error('background.pdf is stale; run node apps/desktop/resources/dmg/render-background.mjs');
  console.log('background.pdf matches its Lex sources');
} else {
  await writeFile(target, bytes);
  console.log(`Wrote background.pdf (${bytes.length} bytes)`);
}
