import { useSyncExternalStore } from 'react';

// Presentation only: the expanded layout fraction remains the user's preference.
let compact = false;
const listeners = new Set<() => void>();
export const getSidebarCompact = () => compact;
export function setSidebarCompact(value: boolean): void {
  if (compact === value) return;
  compact = value;
  listeners.forEach((listener) => listener());
}
export function useSidebarCompact(): boolean {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, getSidebarCompact);
}
