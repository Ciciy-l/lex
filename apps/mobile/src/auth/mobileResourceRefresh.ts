import { accountVaultKey, storedAuthServiceScope, type AuthServiceScope, type AuthTokenPair, type CindyAuthClient } from '@cindy/auth-client';
import { markMobileRotationStarted, readMobileAccountVault, replaceMobileResourceSessionIfCurrent } from './mobileAccountVault';

const flights = new Map<string, Promise<AuthTokenPair>>();

/** The rotating request and its durable replacement are one service/family flight. */
export function refreshMobileResourceSingleFlight(
  client: Pick<CindyAuthClient, 'refresh'>, scope: AuthServiceScope, refreshToken: string, accountKey: string | null,
): Promise<AuthTokenPair> {
  const key = JSON.stringify([scope, 'resource', accountKey ?? 'legacy']);
  const existing = flights.get(key);
  if (existing) return existing;
  const run = (async () => {
    const vault = await readMobileAccountVault();
    const current = accountKey ? vault.resources[accountKey] : undefined;
    if (current && storedAuthServiceScope(current) !== scope) throw new Error('AUTH_FLOW_SUPERSEDED');
    // No Lex compatibility-only credential may bypass the persistent rotation marker.
    if (scope !== 'cn' && scope !== 'global' && !current) throw new Error('SAVED_ACCOUNT_REAUTH_REQUIRED');
    const consumed = current?.refreshToken ?? refreshToken;
    if (current && accountKey) await markMobileRotationStarted({ family: 'resource', key: accountKey, token: consumed });
    const pair = await client.refresh(consumed);
    if (current && accountKey) {
      if (accountVaultKey(scope, pair.membership.id) !== accountKey) throw new Error('SAVED_ACCOUNT_MISMATCH');
      const result = await replaceMobileResourceSessionIfCurrent({
        accountKey, realm: scope, expectedRefreshToken: consumed, pair, passportId: current.metadata.passportId,
      });
      if (result !== 'stored') throw new Error('AUTH_FLOW_SUPERSEDED');
    }
    return pair;
  })();
  flights.set(key, run);
  const finish = () => { if (flights.get(key) === run) flights.delete(key); };
  void run.then(finish, finish);
  return run;
}
