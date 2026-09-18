import type { RemoteSession } from './types';

export * from '@cindy/maker-shared/composer-palette';

export function agentKindForSession(session: Pick<RemoteSession, 'agentKind'>): 'claude-code' | 'codex' | 'pi' | 'omp' {
  return session.agentKind === 'codex' || session.agentKind === 'pi' || session.agentKind === 'omp'
    ? session.agentKind
    : 'claude-code';
}
