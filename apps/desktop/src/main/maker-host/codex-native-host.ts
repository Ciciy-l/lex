import { createCodexNativeService, type CodexLocalServiceLaunch, type CodexNativeService } from '@cindy/maker-core';
import { createCodexLoopbackTransport } from './codex-loopback-transport.js';

/** Main owns the native socket; Core retains existing host/thread/auth policy. */
export function createCodexNativeHostService(options: CodexLocalServiceLaunch): CodexNativeService {
  return createCodexNativeService({ ...options, connect: createCodexLoopbackTransport });
}
