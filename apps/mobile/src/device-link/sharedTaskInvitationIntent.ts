import { useSyncExternalStore } from 'react';
import { parseSharedTaskInvitationIntent, type SharedTaskInvitationIntent } from '@cindy/device-link';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent, subscribeMobileAuthOwner, type MobileAuthOwnerGeneration } from '@/auth/authOwnerGeneration';

let pending: (SharedTaskInvitationIntent & { id: number; source: 'link' | 'clipboard'; expiresAt: number }) | null = null;
let sequence = 0;
let stopWatching: (() => void) | undefined;
let expiry: ReturnType<typeof setTimeout> | undefined;
// The owner is deliberately kept beside the memory-only intent rather than
// inferred again at confirmation time.  A clipboard offer is an account-bound
// capability once it was read while logged in; a later account/logout event
// must not be able to promote that old offer.
let pendingOwner: MobileAuthOwnerGeneration | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

/** Memory-only intent: login can continue it, but account switching cannot inherit it. */
export function clearSharedTaskInvitationIntent(): void {
  pending = null;
  pendingOwner = null;
  stopWatching?.();
  stopWatching = undefined;
  clearTimeout(expiry);
  expiry = undefined;
  notify();
}

export function receiveSharedTaskInvitationIntent(url: string, source: 'link' | 'clipboard' = 'link'): boolean {
  const value = parseSharedTaskInvitationIntent(url);
  if (!value) return false;
  clearSharedTaskInvitationIntent();
  let owner = getMobileAuthOwner();
  pendingOwner = owner;
  pending = { ...value, id: ++sequence, source, expiresAt: Date.now() + 15 * 60_000 };
  stopWatching = subscribeMobileAuthOwner(() => {
    const next = getMobileAuthOwner();
    // An already-bound intent belongs to exactly one account generation.  This
    // includes logout (the next owner is empty), not only account-to-account
    // switches.  Only an intent captured while logged out may be handed to the
    // first account that logs in.
    if (owner.accountKey) {
      if (!isMobileAuthOwnerCurrent(owner)) clearSharedTaskInvitationIntent();
    } else if (next.accountKey) {
      owner = next;
      pendingOwner = next;
    }
  });
  expiry = setTimeout(clearSharedTaskInvitationIntent, 15 * 60_000);
  notify();
  return true;
}

export const getPendingSharedTaskInvitationIntent = () => pending;
/** Confirmation belongs to the visible invitation, never to a newer link/account. */
export function confirmClipboardSharedTaskInvitation(id: number): void {
  if (!pending || pending.id !== id || pending.source !== 'clipboard'
      || !pendingOwner?.accountKey || !isMobileAuthOwnerCurrent(pendingOwner)) return;
  pending = { ...pending, id: ++sequence, source: 'link' };
  notify();
}
export const getSharedTaskInvitationIntentSequence = () => sequence;
export const subscribeSharedTaskInvitationIntent = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const usePendingSharedTaskInvitationIntent = () => useSyncExternalStore(subscribeSharedTaskInvitationIntent, getPendingSharedTaskInvitationIntent, getPendingSharedTaskInvitationIntent);
