import { describe, expect, it } from 'vitest';

import {
  agentKindDisplayLabel,
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

  it('uses one four-engine display mapping for DB and Maker spellings', () => {
    expect(agentKindDisplayLabel('cc')).toBe('Claude Code');
    expect(agentKindDisplayLabel('claude-code')).toBe('Claude Code');
    expect(agentKindDisplayLabel('codex')).toBe('Codex');
    expect(agentKindDisplayLabel('pi')).toBe('Pi');
    expect(agentKindDisplayLabel('omp')).toBe('OMP');
    expect(agentKindDisplayLabel('unknown')).toBe('Claude Code');
  });

  it('keeps the historical Claude Code fallback only for unknown values', () => {
    expect(dbToMakerAgentKind('unknown')).toBe('claude-code');
    expect(makerToDbAgentKind('unknown')).toBe('cc');
    expect(normalizeDbAgentKind('unknown')).toBe('cc');
  });
});
