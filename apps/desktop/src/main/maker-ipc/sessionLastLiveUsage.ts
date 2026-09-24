import type { UsageSnapshot } from '@cindy/maker-core';

export interface SessionLastLiveUsage {
  contextTokens: number;
  contextWindow: number;
  capturedAtMs: number;
}

const lastLiveUsageBySession = new Map<string, SessionLastLiveUsage>();

function nonNegativeFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function rememberSessionLastLiveUsage(
  sessionId: string,
  usage: Pick<UsageSnapshot, 'contextTokens' | 'contextWindow'> | undefined | null,
): void {
  if (!sessionId || !usage) return;
  const contextTokens = nonNegativeFinite(usage.contextTokens);
  const contextWindow = nonNegativeFinite(usage.contextWindow);
  if (contextTokens === null || contextWindow === null) return;
  lastLiveUsageBySession.set(sessionId, { contextTokens, contextWindow, capturedAtMs: Date.now() });
}

export function getSessionLastLiveUsage(sessionId: string): SessionLastLiveUsage | undefined {
  return lastLiveUsageBySession.get(sessionId);
}

export function forgetSessionLastLiveUsage(sessionId: string): void {
  lastLiveUsageBySession.delete(sessionId);
}

export function _resetSessionLastLiveUsageForTests(): void {
  lastLiveUsageBySession.clear();
}
