import { useSyncExternalStore } from 'react';

// Read-only retirement knowledge. Never delete the user's disk history or drafts.
const retainedByDevice = new Map<string, Set<string>>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
export function rememberRetiredSession(deviceId: string, sessionId: string): void {
  if (!deviceId || !sessionId) return;
  const ids = retainedByDevice.get(deviceId) ?? new Set<string>();
  if (ids.has(sessionId)) return;
  ids.add(sessionId);
  retainedByDevice.set(deviceId, ids);
  emit();
}
export function isRetiredSession(deviceId: string, sessionId: string): boolean {
  return retainedByDevice.get(deviceId)?.has(sessionId) === true;
}
export function resetRetiredSessionAccess(): void {
  retainedByDevice.clear();
  emit();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function useRetiredSession(deviceId: string, sessionId: string): boolean {
  return useSyncExternalStore(subscribe, () => isRetiredSession(deviceId, sessionId));
}
