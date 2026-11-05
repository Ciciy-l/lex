import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { computeOrcaWorkerContextSupport } from '../orcaContextCapability.js';

describe('Orca dispatch context capability', () => {
  it.each(['claude-code', 'codex', 'pi', 'omp'] as const)(
    'allows clear for local %s workers (shared host /clear, not a native command)',
    (agentKind) => {
      const support = computeOrcaWorkerContextSupport({
        agentKind,
        remoteHostId: null,
        nativePresentation: false,
        manualCompactSupported: agentKind === 'codex' || agentKind === 'pi',
      });
      expect(support.clear).toEqual({ supported: true });
    },
  );

  it.each(['claude-code', 'omp'] as const)(
    'refuses compact for %s without a proven host-awaitable completion',
    (agentKind) => {
      const support = computeOrcaWorkerContextSupport({
        agentKind,
        remoteHostId: null,
        nativePresentation: false,
        manualCompactSupported: true,
      });
      expect(support.compact.supported).toBe(false);
    },
  );

  it.each(['codex', 'pi'] as const)('allows compact for %s only when declared', (agentKind) => {
    expect(
      computeOrcaWorkerContextSupport({
        agentKind,
        remoteHostId: null,
        nativePresentation: false,
        manualCompactSupported: true,
      }).compact,
    ).toEqual({ supported: true });
    expect(
      computeOrcaWorkerContextSupport({
        agentKind,
        remoteHostId: null,
        nativePresentation: false,
        manualCompactSupported: false,
      }).compact,
    ).toMatchObject({ supported: false, reason: 'manual-compact-unavailable' });
  });

  it('refuses native presentation and remote sessions for compact', () => {
    expect(
      computeOrcaWorkerContextSupport({
        agentKind: 'pi',
        remoteHostId: null,
        nativePresentation: true,
        manualCompactSupported: true,
      }).compact,
    ).toMatchObject({ supported: false, reason: 'native-presentation' });
    expect(
      computeOrcaWorkerContextSupport({
        agentKind: 'codex',
        remoteHostId: 'ssh-host',
        nativePresentation: false,
        manualCompactSupported: true,
      }),
    ).toMatchObject({
      clear: { supported: false, reason: 'remote-session' },
      compact: { supported: false, reason: 'remote-session' },
    });
  });

  it('wires both the Desktop /clear handler and Orca prepare to the same host clear service', () => {
    const source = readFileSync(resolve(__dirname, '..', 'register.ts'), 'utf8');
    const handlerStart = source.indexOf('MAKER_INVOKE.INPUT_CLEAR_SESSION');
    const handlerEnd = source.indexOf('MAKER_INVOKE.ABORT_SESSION', handlerStart);
    expect(source.slice(handlerStart, handlerEnd)).toContain('clearService.clearSession(sid, {');
    const prepareStart = source.indexOf('async function prepareOrcaWorkerContext(');
    const prepareEnd = source.indexOf('const orcaTeamService = createOrcaTeamService', prepareStart);
    const prepare = source.slice(prepareStart, prepareEnd);
    expect(prepare).toContain('clearService.clearSession(sessionId, {');
    // Never send a literal /clear as an Orca task message; the host must own
    // the real transaction and completion boundary.
    expect(prepare).not.toContain("'/clear'");
    expect(prepare).toContain('withRehydrateCloseSuppressed(sessionId, () => maker.closeSession(sessionId))');
  });

  it('forwards the captured owner scope to the audit write', () => {
    const source = readFileSync(resolve(__dirname, '..', 'register.ts'), 'utf8');
    expect(source).toContain('recordContextAudit: async (event, owner) =>');
    expect(source).toContain('recordOrcaContextEvent(event, owner)');
  });
});
