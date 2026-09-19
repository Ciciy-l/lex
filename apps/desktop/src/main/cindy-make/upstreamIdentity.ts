import type { CindyBuildIdentity } from './sourcePreparation.js';

/**
 * The Cindy revision whose source a packaged Lex build can prepare for Cindy
 * Make. Lex has its own release identity, so its app version must never be
 * treated as a Cindy Git tag. Bump this deliberately with each Cindy sync.
 */
export const CINDY_MAKE_UPSTREAM_VERSION = '0.1.86';

export interface CindyMakeHostBuildIdentity {
  isPackaged: boolean;
  appVersion: string;
}

/**
 * Development follows Cindy main. Packaged builds use the fixed Cindy baseline;
 * the Lex prerelease suffix only selects the preferred Cindy release channel.
 */
export function cindyMakeUpstreamIdentity(
  host: CindyMakeHostBuildIdentity,
): CindyBuildIdentity {
  return {
    channel: !host.isPackaged
      ? 'dev'
      : /-beta(?:\.|$)/i.test(host.appVersion)
        ? 'beta'
        : 'release',
    version: CINDY_MAKE_UPSTREAM_VERSION,
  };
}
