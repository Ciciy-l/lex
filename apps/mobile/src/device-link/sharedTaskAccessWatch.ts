import { ApiError } from '@/api/client';

/** Only an authoritative missing membership ends access; network failures do not. */
export function isSharedTaskGone(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.code === 'NOT_FOUND';
}

/** Reconcile one foreground guest task without touching any other scoped peer. */
export function watchSharedTaskAccess(options: {
  sharedTaskId: string;
  sessionId: string;
  read(): Promise<{ sharedTaskId: string; sessionId: string; status: string; hostDeviceId?: string }>;
  isCurrent(): boolean;
  onRevoked(): void;
  onAuthorized?: (detail: { sharedTaskId: string; sessionId: string; status: string; hostDeviceId?: string }) => void;
  delayMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const delayMs = options.delayMs ?? 5_000;
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? ((value) => clearTimeout(value));
  const current = () => !stopped && options.isCurrent();
  const revoke = () => {
    if (!current()) return;
    stopped = true;
    options.onRevoked();
  };
  const check = async () => {
    if (!current()) return;
    try {
      const detail = await options.read();
      if (!current()) return;
      if (detail.sharedTaskId === options.sharedTaskId && detail.sessionId === options.sessionId
          && detail.status === 'active') options.onAuthorized?.(detail);
      else if (detail.sharedTaskId === options.sharedTaskId && detail.sessionId === options.sessionId
          && detail.status === 'closed') revoke();
    } catch (error) {
      // Timeout, offline, expired login and unsupported routes are not revocation.
      if (isSharedTaskGone(error)) revoke();
    } finally {
      // A slow read occupies the only request slot; no interval can pile up reads.
      if (current()) timer = setTimer(() => { void check(); }, delayMs);
    }
  };
  void check();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimer(timer);
  };
}
