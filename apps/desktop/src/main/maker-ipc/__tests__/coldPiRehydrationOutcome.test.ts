import { expect, it } from 'vitest';
import { classifyColdPiRehydrationOutcome } from '../coldPiRehydrationOutcome.js';

it.each([
  [false, true, 'verified'],
  [true, true, 'verified'],
  [true, false, 'degraded'],
  [false, false, 'fail-closed'],
] as const)('classifies failed=%s live=%s as %s', (rehydrationFailed, liveAfterBootstrap, expected) => {
  expect(classifyColdPiRehydrationOutcome({ rehydrationFailed, liveAfterBootstrap })).toBe(expected);
});
