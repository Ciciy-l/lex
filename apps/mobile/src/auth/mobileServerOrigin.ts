import { normalizeLexServerOrigin } from '@cindy/auth-client';
import { IS_MOBILE_DEVELOPMENT } from './mobileBuild';

/** Mobile release builds require HTTPS even for a previously saved loopback service. */
export function normalizeMobileLexServerOrigin(input: string): string {
  const origin = normalizeLexServerOrigin(input);
  if (!IS_MOBILE_DEVELOPMENT && new URL(origin).protocol !== 'https:') throw new Error('INVALID_SERVICE_ORIGIN');
  return origin;
}

/** Apply the same policy at the physical HTTP boundary, including saved sessions. */
export function assertMobileServiceRequestUrl(input: string): void {
  const url = new URL(input);
  if (url.username || url.password) throw new Error('INVALID_SERVICE_ORIGIN');
  normalizeMobileLexServerOrigin(url.origin);
}
