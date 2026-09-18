import { describe, expect, it } from 'vitest';

import {
  dbToMakerAgentKind,
  isMakerAgentKind,
  makerToDbAgentKind,
  normalizeDbAgentKind,
} from '../agentKindConversion';

describe('agent kind conversion', () => {
  it('preserves OMP across database and Maker wire boundaries', () => {
    expect(dbToMakerAgentKind('omp')).toBe('omp');
    expect(makerToDbAgentKind('omp')).toBe('omp');
    expect(normalizeDbAgentKind('omp')).toBe('omp');
  });

  it('accepts OMP in the Maker IPC runtime allow-list', () => {
    expect(isMakerAgentKind('claude-code')).toBe(true);
    expect(isMakerAgentKind('codex')).toBe(true);
    expect(isMakerAgentKind('pi')).toBe(true);
    expect(isMakerAgentKind('omp')).toBe(true);
    expect(isMakerAgentKind('unknown')).toBe(false);
  });

  it('keeps the historical Claude Code fallback only for unknown values', () => {
    expect(dbToMakerAgentKind('unknown')).toBe('claude-code');
    expect(makerToDbAgentKind('unknown')).toBe('cc');
    expect(normalizeDbAgentKind('unknown')).toBe('cc');
  });
});
