import type { HarnessFailureStage } from '../../../shared/harnessSettings';

/** Only known, non-sensitive error categories reach UI copy. */
export function harnessErrorKey(
  code: string | null | undefined,
  stage?: HarnessFailureStage | null,
): string {
  if (code === 'RELEASE_HAS_NO_VERIFIED_ASSET' || code === 'UNSUPPORTED_PLATFORM')
    return 'settings.harness.errors.asset';
  if (code === 'INVALID_RELEASE' || code === 'INVALID_RELEASE_VERSION')
    return 'settings.harness.errors.release';
  if (code === 'REFRESH_RELEASE_LIST') return 'settings.harness.errors.refresh';
  if (code === 'RUNTIME_BUSY') return 'settings.harness.errors.busy';
  if (code === 'RELEASE_LOOKUP_HTTP_403' || code === 'RELEASE_LOOKUP_HTTP_429')
    return 'settings.harness.errors.rateLimit';
  if (code === 'NETWORK' || code === 'TIMEOUT' || code?.startsWith('RELEASE_LOOKUP_HTTP_'))
    return stage === 'check'
      ? 'settings.harness.errors.checkNetwork'
      : 'settings.harness.errors.downloadNetwork';
  if (code === 'ENOSPC' || code === 'DISK') return 'settings.harness.errors.disk';
  if (code === 'EACCES' || code === 'EPERM') return 'settings.harness.errors.permission';
  if (
    ['CHECKSUM', 'SIZE', 'RUNTIME_VERSION_MISMATCH', 'INVALID_RUNTIME_LAYOUT'].includes(code ?? '')
  )
    return 'settings.harness.errors.verify';
  return stage ? `settings.harness.errors.${stage}` : 'settings.harness.runtimeFailed';
}
