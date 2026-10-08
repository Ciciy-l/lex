import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { parseSharedTaskInvitation, sharedTaskInvitationServer } from '@cindy/device-link';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent, subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { DEVICE_LINK_API_BASE_URL } from '@/config/env';
import { getPendingSharedTaskInvitationIntent, getSharedTaskInvitationIntentSequence, receiveSharedTaskInvitationIntent, subscribeSharedTaskInvitationIntent } from './sharedTaskInvitationIntent';
import { hasSeenClipboardInvitation, invitationDigest, rememberClipboardInvitation } from './clipboardInvitationHistory';

/** Read only after login/foreground; clipboard text never leaves memory. */
export function useClipboardSharedTaskInvitation(enabled: boolean, joining: boolean): void {
  const joiningRef = useRef(joining);
  joiningRef.current = joining;
  useEffect(() => {
    let disposed = false;
    const rememberExplicitInvitation = () => {
      if (disposed) return;
      const intent = getPendingSharedTaskInvitationIntent();
      const owner = getMobileAuthOwner();
      if (owner.accountKey && intent?.source === 'link' && intent.server === sharedTaskInvitationServer(DEVICE_LINK_API_BASE_URL)) {
        void rememberClipboardInvitation(owner.accountKey, invitationDigest(intent.invitation));
      }
    };
    const stopWatching = subscribeSharedTaskInvitationIntent(rememberExplicitInvitation);
    const stopWatchingOwner = subscribeMobileAuthOwner(() => queueMicrotask(rememberExplicitInvitation));
    rememberExplicitInvitation();
    return () => { disposed = true; stopWatching(); stopWatchingOwner(); };
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let reading = false;
    let started = false;
    let background = false;
    let activation = 0;
    let deferredOffer: (() => void) | null = null;
    const check = async () => {
      if (reading || joiningRef.current || getPendingSharedTaskInvitationIntent()) return;
      const owner = getMobileAuthOwner();
      if (!owner.accountKey) return;
      reading = true;
      const captured = activation;
      const sequence = getSharedTaskInvitationIntentSequence();
      try {
        const text = await Clipboard.getStringAsync();
        if (disposed) return;
        if (!/https?:\/\//.test(text)) return;
        const parsed = parseSharedTaskInvitation(text, DEVICE_LINK_API_BASE_URL);
        if (!parsed.ok) return;
        const digest = invitationDigest(parsed.invitation);
        if (await hasSeenClipboardInvitation(owner.accountKey, digest)) return;
        const offer = () => {
          if (disposed || captured !== activation || joiningRef.current || !isMobileAuthOwnerCurrent(owner)
              || sequence !== getSharedTaskInvitationIntentSequence() || getPendingSharedTaskInvitationIntent()) return;
          if (AppState.currentState !== 'active') { deferredOffer = offer; return; }
          const url = 'cindy://shared-session?invitation=' + encodeURIComponent(parsed.invitation)
            + '&server=' + encodeURIComponent(DEVICE_LINK_API_BASE_URL);
          receiveSharedTaskInvitationIntent(url, 'clipboard');
        };
        offer();
      } catch {
        // Permission/availability failures leave the current page usable.
      } finally {
        reading = false;
        if (!disposed && captured !== activation && AppState.currentState === 'active') void check();
      }
    };
    const activate = (state: AppStateStatus) => {
      if (state === 'background') { background = true; activation++; deferredOffer = null; }
      if (state !== 'active') return;
      const offer = deferredOffer;
      deferredOffer = null;
      offer?.();
      if (started && !background) return;
      started = true;
      background = false;
      void check();
    };
    const subscription = AppState.addEventListener('change', activate);
    const stopWatchingOwner = subscribeMobileAuthOwner(() => {
      activation++;
      deferredOffer = null;
      if (AppState.currentState !== 'active') started = false;
      queueMicrotask(() => { if (!disposed && AppState.currentState === 'active') void check(); });
    });
    activate(AppState.currentState);
    return () => { disposed = true; deferredOffer = null; subscription.remove(); stopWatchingOwner(); };
  }, [enabled]);
}
