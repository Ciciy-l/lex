import { describe, expect, it } from 'vitest';
import { isOfficialXaiApiHost } from '../xai-endpoints.js';

describe('isOfficialXaiApiHost', () => {
  it.each(['https://api.x.ai/v1', 'https://us.api.x.ai/v1'])('accepts documented public host %s', (url) => {
    expect(isOfficialXaiApiHost(url)).toBe(true);
  });

  it.each([
    'https://api.x.aievil.com/v1',
    'https://evilapi.x.ai/v1',
    'https://us.api.x.ai.evil/v1',
    'http://us.api.x.ai/v1',
    'https://user@us.api.x.ai/v1',
    'https://us.api.x.ai:9443/v1',
  ])('rejects non-official or unsafe host %s', (url) => {
    expect(isOfficialXaiApiHost(url)).toBe(false);
  });
});
