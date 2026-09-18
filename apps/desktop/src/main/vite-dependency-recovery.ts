/**
 * Narrow Main-process side of the dev-only Vite dependency recovery path.
 *
 * The renderer only gets this fixed, argument-free action. It cannot select a
 * cache scope, target WebContents, URL, or IPC channel. Main owns the sender
 * trust check and reloads only that sender without using Chromium's cache.
 */
export interface ViteDependencyRecoveryTarget {
  isDestroyed(): boolean;
  reloadIgnoringCache(): void;
}

export interface ViteDependencyRecoveryEvent {
  sender: ViteDependencyRecoveryTarget;
}

export interface ViteDependencyRecoveryOptions<Event extends ViteDependencyRecoveryEvent> {
  isDevelopment: boolean;
  assertTrustedAppRendererEvent: (event: Event) => void;
}

/**
 * Reload one trusted renderer after it raced Vite's optimize-deps handoff.
 * Production and destroyed renderers deliberately remain no-ops.
 */
export function recoverViteDependencyLoad<Event extends ViteDependencyRecoveryEvent>(
  event: Event,
  { isDevelopment, assertTrustedAppRendererEvent }: ViteDependencyRecoveryOptions<Event>,
): void {
  assertTrustedAppRendererEvent(event);
  if (!isDevelopment || event.sender.isDestroyed()) return;
  event.sender.reloadIgnoringCache();
}
