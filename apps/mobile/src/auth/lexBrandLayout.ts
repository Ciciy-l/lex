import type { LoginStageBox, LoginSurfaceLayout } from './loginSkinLayout';

const WORDMARK_RATIO = 423 / 145;
type Insets = { top: number; right: number; bottom: number; left: number };

/** Lex uses square portrait art. The old tall Cindy composition placed its wordmark
 * inside the portrait; keep separate image, wordmark and loading regions instead.
 * All returned boxes use the existing stage coordinates, including safe-area offsets. */
export function resolveLexBrandLayout(stage: LoginSurfaceLayout, insets: Insets) {
  const { scale, offsetX, offsetY, viewportWidth: width, viewportHeight: height } = stage;
  const toStage = (x: number, y: number, w: number, h: number): LoginStageBox => ({
    x: (x - offsetX) / scale, y: (y - offsetY) / scale, w: w / scale, h: h / scale,
  });
  const usableWidth = Math.max(1, width - insets.left - insets.right - 32);
  const usableHeight = Math.max(1, height - insets.top - insets.bottom - 32);
  const centerX = insets.left + 16 + usableWidth / 2;
  const centerY = insets.top + 16 + usableHeight / 2;
  const gap = Math.min(20, usableHeight * 0.035);
  const spinnerSize = Math.min(28, usableHeight * 0.07);
  const heroSize = Math.min(560, usableWidth * 0.96, usableHeight * 0.66);
  const wordWidth = Math.min(252, heroSize * 0.5);
  const wordHeight = wordWidth / WORDMARK_RATIO;
  const blockHeight = heroSize + wordHeight + spinnerSize + gap * 2;
  const top = centerY - blockHeight / 2;
  const splash = {
    hero: toStage(centerX - heroSize / 2, top, heroSize, heroSize),
    word: toStage(centerX - wordWidth / 2, top + heroSize + gap, wordWidth, wordHeight),
  };
  const spinnerBox = toStage(centerX - spinnerSize / 2, top + blockHeight - spinnerSize, spinnerSize, spinnerSize);

  let hero: LoginStageBox;
  let word: LoginStageBox;
  if (stage.mode === 'pad-landscape' || stage.mode === 'compact-wide') {
    // These modes already reserve separate form and artwork columns. Fit a square
    // inside the original portrait box; the wordmark remains above the form.
    const size = Math.min(stage.cindy.w, stage.cindy.h);
    hero = { x: stage.cindy.x, y: stage.cindy.y, w: size, h: size };
    word = { ...stage.word, h: stage.word.w / WORDMARK_RATIO };
  } else {
    const topY = Math.max(stage.cindy.y, (insets.top + 12 - offsetY) / scale);
    const bottom = stage.loginY - 12 / scale;
    const available = Math.max(1, bottom - topY);
    const wordW = Math.min(stage.word.w, available * 0.24 * WORDMARK_RATIO);
    const wordH = wordW / WORDMARK_RATIO;
    const separation = Math.min(12 / scale, available * 0.06);
    const size = Math.max(1, Math.min(stage.cindy.w, available - wordH - separation));
    const x = stage.stageWidth / 2;
    word = { x: x - wordW / 2, y: bottom - wordH, w: wordW, h: wordH };
    hero = { x: x - size / 2, y: word.y - separation - size, w: size, h: size };
  }
  return { login: { hero, word }, splash, spinner: { x: spinnerBox.x, y: spinnerBox.y, size: spinnerBox.w } };
}
