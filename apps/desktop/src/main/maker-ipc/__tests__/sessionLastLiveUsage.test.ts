import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetSessionLastLiveUsageForTests,
  forgetSessionLastLiveUsage,
  getSessionLastLiveUsage,
  rememberSessionLastLiveUsage,
} from '../sessionLastLiveUsage';

afterEach(() => {
  _resetSessionLastLiveUsageForTests();
});

describe('sessionLastLiveUsage', () => {
  it('remembers only valid runtime usage captured at close', () => {
    rememberSessionLastLiveUsage('session-1', { contextTokens: 26_921, contextWindow: 1_000_000 });
    expect(getSessionLastLiveUsage('session-1')).toMatchObject({ contextTokens: 26_921, contextWindow: 1_000_000 });
    expect(getSessionLastLiveUsage('session-1')?.capturedAtMs).toBeGreaterThan(0);
  });

  it('keeps the last trusted snapshot when a later close snapshot is missing or invalid', () => {
    rememberSessionLastLiveUsage('session-1', { contextTokens: 26_921, contextWindow: 1_000_000 });
    rememberSessionLastLiveUsage('session-1', undefined);
    rememberSessionLastLiveUsage('session-1', { contextTokens: Number.NaN, contextWindow: 1 });
    rememberSessionLastLiveUsage('session-1', { contextTokens: -1, contextWindow: 1 });
    expect(getSessionLastLiveUsage('session-1')?.contextTokens).toBe(26_921);
  });

  it('forgets a session and leaves unknown sessions unset', () => {
    expect(getSessionLastLiveUsage('unknown')).toBeUndefined();
    rememberSessionLastLiveUsage('session-1', { contextTokens: 1, contextWindow: 2 });
    forgetSessionLastLiveUsage('session-1');
    expect(getSessionLastLiveUsage('session-1')).toBeUndefined();
  });
});
