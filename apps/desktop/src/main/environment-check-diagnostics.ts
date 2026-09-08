import type { Logger } from './logger.js';

export type RequiredRuntimeKind = 'claude-code' | 'codex' | 'ripgrep';
export type RequiredRuntimeFailureStage = 'exception' | 'not-ready';

interface RequiredRuntimeFailure {
  kind: RequiredRuntimeKind;
  platform: NodeJS.Platform;
  stage: RequiredRuntimeFailureStage;
  runtimeError?: string;
}

function safeRuntimeErrorCode(value: string | undefined): string | undefined {
  const token = value?.trim();
  return token && /^[a-z][a-z0-9_:-]{0,63}$/i.test(token) ? token : undefined;
}

/** Log a stable, path-free startup diagnostic at the final required-runtime boundary. */
export function logRequiredRuntimeFailure(
  logger: Pick<Logger, 'error'>,
  failure: RequiredRuntimeFailure,
): void {
  const runtimeErrorCode = safeRuntimeErrorCode(failure.runtimeError);
  logger.error('required startup runtime unavailable', {
    code: 'environment_required_runtime_unavailable',
    kind: failure.kind,
    platform: failure.platform,
    stage: failure.stage,
    ...(runtimeErrorCode ? { runtimeErrorCode } : {}),
  });
}
