import { describe, expect, it } from 'vitest';
import { BRAND_NAME } from '@cindy/maker-shared/branding';

import { buildManagedConfig } from '../browser-managed-config.js';

describe('managed browser runtime config', () => {
  it.each([false, true])('allows private-network browsing with useRealProfile=%s', (useRealProfile) => {
    expect(buildManagedConfig({ useRealProfile }).browser?.ssrfPolicy).toEqual({
      dangerouslyAllowPrivateNetwork: true,
    });
  });

  it('labels both isolated and snapshot profiles Cindy on the Chrome chip', () => {
    const isolated = buildManagedConfig().browser;
    expect(isolated?.defaultProfile).toBe('Cindy');
    expect(isolated?.profiles?.Cindy?.displayName).toBe(BRAND_NAME);

    const snapshot = buildManagedConfig({ useRealProfile: true }).browser;
    expect(snapshot?.defaultProfile).toBe('Cindy-real');
    expect(snapshot?.profiles?.['Cindy-real']?.displayName).toBe(BRAND_NAME);
    expect(Object.keys(snapshot?.profiles ?? {})).toEqual(['Cindy-real']);
  });
});
