import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BOT_GROUP_REMOTE_COLLECTION_ID, BOT_GROUP_REMOTE_RESOURCE_KIND } from '@cindy/maker-shared/botGroupChat';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useRevokedDevices } from '@/device-link/revokedDevicesStore';
import { readRemoteCollectionCache, writeRemoteCollectionCache } from '@/device-link/remoteResourceAvailability';
import { cacheRemoteResourceItems, readRemoteResourceSnapshot } from '@/device-link/remoteResourceCache';
import {
  listRemoteCollection,
  normalizeRemoteCollectionItems,
  type HostedRemoteCollectionItem,
  type RemoteResourceHostTarget,
} from '@/device-link/remoteResources';
import { startFocusedTopicSubscription } from '@/device-link/focusedTopicSubscription';

const NO_TARGETS: RemoteResourceHostTarget[] = [];

/**
 * Group chats of the computers whose manifest advertises them (`useTeammateRoster().groupTargets`).
 * The list re-reads on the host's `maker:remote-resources:changed` push like every resource list.
 */
export function useBotGroupRoster(targets: readonly RemoteResourceHostTarget[], enabled: boolean) {
  const { user, accountGeneration } = useAuth();
  const { invoke, openLink, status, connectionEpoch, getPresenceAvailability, onRemoteResourceChanged, subscribe, unsubscribe } = useDeviceLink();
  const { i18n } = useTranslation();
  const revoked = useRevokedDevices();
  const hosts = useMemo(() => (targets.length ? [...targets] : NO_TARGETS), [targets]);
  const hostIds = useMemo(() => new Set(hosts.map((host) => host.deviceId)), [hosts]);
  const owner = `${user?.id ?? ''}:${accountGeneration}`;
  // A reply is only valid for the link epoch that requested it. Include the epoch in the
  // local scope so reconnects cannot repopulate a roster after the account/host changed.
  const scope = JSON.stringify([owner, hosts.map((host) => host.deviceId), i18n.language, connectionEpoch]);
  const refreshGeneration = useRef(0);
  const [state, setState] = useState<{ scope: string; items: HostedRemoteCollectionItem[]; loading: boolean; online: ReadonlySet<string> }>({
    scope, items: [], loading: false, online: new Set(),
  });
  const refresh = useCallback(async () => {
    const requestGeneration = ++refreshGeneration.current;
    if (!enabled || hosts.length === 0 || !user?.id) {
      if (requestGeneration !== refreshGeneration.current) return;
      setState({ scope, items: [], loading: false, online: new Set() });
      return;
    }
    const currentScope = scope;
    setState((previous) => ({ scope: currentScope, items: previous.scope === currentScope ? previous.items : [], loading: true, online: previous.scope === currentScope ? previous.online : new Set() }));
    const settled = await Promise.allSettled(hosts.map(async (host) => {
      await openLink(host.deviceId);
      const response = await listRemoteCollection(invoke, host, BOT_GROUP_REMOTE_COLLECTION_ID, i18n.language);
      const items = normalizeRemoteCollectionItems(response, BOT_GROUP_REMOTE_COLLECTION_ID)
        .filter((item) => item.ref.kind === BOT_GROUP_REMOTE_RESOURCE_KIND)
        .map((item) => ({ host, item, key: JSON.stringify([host.deviceId, item.ref.kind, item.ref.id]) }));
      return { host, items };
    }));
    if (requestGeneration !== refreshGeneration.current || scope !== currentScope) return;
    const online = new Set<string>();
    const rows = settled.flatMap((result) => {
      if (result.status !== 'fulfilled') return [];
      online.add(result.value.host.deviceId);
      return result.value.items;
    });
    // Persist an empty successful snapshot too; otherwise a deleted/empty group list can
    // resurrect stale rows on the next cold start.
    writeRemoteCollectionCache(owner, BOT_GROUP_REMOTE_COLLECTION_ID, rows);
    void cacheRemoteResourceItems(user.id, BOT_GROUP_REMOTE_COLLECTION_ID, rows);
    setState({ scope: currentScope, items: rows, loading: false, online });
  }, [connectionEpoch, enabled, hosts, invoke, i18n.language, openLink, owner, scope, user?.id]);
  useEffect(() => {
    if (!enabled || !user?.id || hosts.length === 0) {
      refreshGeneration.current += 1;
      setState({ scope, items: [], loading: false, online: new Set() });
      return;
    }
    let cancelled = false;
    const scopedRows = (rows: readonly HostedRemoteCollectionItem[]) => rows.filter((row) =>
      hostIds.has(row.host.deviceId) && row.item.ref.kind === BOT_GROUP_REMOTE_RESOURCE_KIND);
    const cached = scopedRows(readRemoteCollectionCache(owner, BOT_GROUP_REMOTE_COLLECTION_ID));
    setState({ scope, items: cached, loading: true, online: new Set() });
    void readRemoteResourceSnapshot(user.id).then((snapshot) => {
      const snapshotItems = snapshot.items[BOT_GROUP_REMOTE_COLLECTION_ID]
        ? scopedRows(snapshot.items[BOT_GROUP_REMOTE_COLLECTION_ID]!)
        : undefined;
      if (!cancelled && snapshotItems !== undefined && scope === JSON.stringify([owner, hosts.map((host) => host.deviceId), i18n.language, connectionEpoch])) {
        setState((previous) => previous.items.length ? previous : { ...previous, items: snapshotItems });
      }
    });
    void refresh();
    const offs = hosts.map((host) => {
      const offPush = onRemoteResourceChanged((source, payload) => {
        if (source !== host.deviceId || payload.collectionId !== BOT_GROUP_REMOTE_COLLECTION_ID) return;
        void refresh();
      });
      const stopTopic = startFocusedTopicSubscription({ deviceId: host.deviceId, owner: `bot-groups:${host.deviceId}`, topic: 'sessions', subscribe, unsubscribe });
      return () => { offPush(); stopTopic(); };
    });
    return () => {
      cancelled = true;
      refreshGeneration.current += 1;
      offs.forEach((off) => off());
    };
  }, [connectionEpoch, enabled, hostIds, hosts, i18n.language, onRemoteResourceChanged, owner, refresh, scope, subscribe, unsubscribe, user?.id]);
  const items = state.scope === scope ? state.items.filter((row) => hostIds.has(row.host.deviceId) && !revoked.has(row.host.deviceId)) : [];
  return {
    items,
    /** The section shows only when some computer supports group chats. */
    supported: hosts.length > 0,
    isOnline: (host: RemoteResourceHostTarget) => !revoked.has(host.deviceId)
      && (state.scope === scope ? state.online.has(host.deviceId) : status === 'online' && getPresenceAvailability(host.deviceId) !== false),
    refresh,
  };
}
