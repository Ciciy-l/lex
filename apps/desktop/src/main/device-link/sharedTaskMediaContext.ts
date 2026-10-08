import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage<{ id: string; assertCurrent?: () => void }>();
/** Scope uploads for one trusted outbound call; never a global mutable flag. */
export function withSharedTaskMedia<T>(sharedTaskId: string | undefined, work: () => T, assertCurrent?: () => void): T {
  assertCurrent?.();
  return sharedTaskId ? scope.run({ id: sharedTaskId, assertCurrent }, work) : work();
}
export function sharedTaskMediaId(): string | undefined { return scope.getStore()?.id; }
export function assertSharedTaskUploadCurrent(): void { scope.getStore()?.assertCurrent?.(); }
