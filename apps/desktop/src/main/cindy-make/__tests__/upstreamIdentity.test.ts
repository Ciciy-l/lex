import { describe, expect, it } from 'vitest';
import { sourceTarget } from '../sourcePreparation.js';
import { CINDY_MAKE_UPSTREAM_VERSION, cindyMakeUpstreamIdentity } from '../upstreamIdentity.js';

describe('Cindy Make upstream identity in Lex', () => {
  it('follows Cindy main from any Lex development build', () => {
    const identity = cindyMakeUpstreamIdentity({ isPackaged: false, appVersion: '9.42.7-beta.3' });

    expect(identity).toEqual({ channel: 'dev', version: CINDY_MAKE_UPSTREAM_VERSION });
    expect(sourceTarget(identity)).toMatchObject({ ref: 'main', candidates: ['main'] });
  });

  it('uses the fixed Cindy release baseline instead of the Lex app version', () => {
    const identity = cindyMakeUpstreamIdentity({ isPackaged: true, appVersion: '9.42.7' });

    expect(identity).toEqual({ channel: 'release', version: '0.1.86' });
    expect(sourceTarget(identity).candidates).toEqual(['v0.1.86', 'v0.1.86-beta']);
  });

  it('uses the same fixed baseline for Lex beta builds while preferring Cindy beta', () => {
    const identity = cindyMakeUpstreamIdentity({ isPackaged: true, appVersion: '9.42.7-beta.3' });

    expect(identity).toEqual({ channel: 'beta', version: '0.1.86' });
    expect(sourceTarget(identity).candidates).toEqual(['v0.1.86-beta', 'v0.1.86']);
  });
});
