import {
  getCurrentDbClientSnapshot,
  type CurrentDbClientSnapshot,
} from '../localDb/client/current.js';
import { getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';

/**
 * Captured owner/DB/generation for one explicit context operation.
 *
 * The operation may await a capability probe, a native close or a DB
 * transaction. Audit writes must target the captured DB and must be skipped
 * once the account/generation moved; never use the current global DB for an
 * old owner's event.
 */
export interface OrcaContextOwnerScope {
  readonly client: CurrentDbClientSnapshot['client'];
  readonly generation: number;
  assertCurrent(): void;
}

export function captureOrcaContextOwner(): OrcaContextOwnerScope | null {
  const snapshot = getCurrentDbClientSnapshot();
  if (!snapshot) return null;
  const generation = getActiveAppSession().generation;
  return {
    client: snapshot.client,
    generation,
    assertCurrent() {
      const current = getCurrentDbClientSnapshot();
      if (!current || current.client !== snapshot.client
        || current.userId !== snapshot.userId
        || getActiveAppSession().generation !== generation
        || isAppSessionBoundaryPending()) {
        const error = new Error('Orca context owner changed');
        (error as { code?: string }).code = 'PRECONDITION_FAILED';
        throw error;
      }
    },
  };
}
