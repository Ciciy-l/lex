import type { DeviceView } from '@cindy/device-link';
import { getSecureItem, setSecureItem } from '@/auth/secureStorage';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { mobileStorageNamespace } from '@/auth/mobileStorageNamespace';

const DEVICE_IDENTITY_STORAGE_KEY = 'device-link.device-identity.v1';

export interface DeviceIdentityCache {
  names: Record<string, string>;
  nextOrder: number;
  order: Record<string, number>;
}

export interface DeviceIdentityReconcileResult {
  cache: DeviceIdentityCache;
  cacheChanged: boolean;
  devices: DeviceView[];
  viewsChanged: boolean;
}

export function createEmptyDeviceIdentityCache(): DeviceIdentityCache {
  return { names: {}, nextOrder: 0, order: {} };
}

export async function loadDeviceIdentityCache(): Promise<DeviceIdentityCache> {
  const owner = getMobileAuthOwner();
  if (!owner.accountKey) return createEmptyDeviceIdentityCache();
  const raw = await getSecureItem(`${DEVICE_IDENTITY_STORAGE_KEY}.scope.${mobileStorageNamespace(owner.accountKey)}`);
  if (!isMobileAuthOwnerCurrent(owner)) return createEmptyDeviceIdentityCache();
  if (!raw) return createEmptyDeviceIdentityCache();
  try {
    return hydrateDeviceIdentityCache(JSON.parse(raw));
  } catch {
    return createEmptyDeviceIdentityCache();
  }
}

export async function saveDeviceIdentityCache(cache: DeviceIdentityCache, owner = getMobileAuthOwner()): Promise<void> {
  if (!owner.accountKey || !isMobileAuthOwnerCurrent(owner)) return;
  await setSecureItem(`${DEVICE_IDENTITY_STORAGE_KEY}.scope.${mobileStorageNamespace(owner.accountKey)}`, JSON.stringify(cache));
}

export function hydrateDeviceIdentityCache(raw: unknown): DeviceIdentityCache {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return createEmptyDeviceIdentityCache();
  }
  const record = raw as Record<string, unknown>;
  const names = normalizeNameMap(record.names);
  const order = normalizeOrderMap(record.order);
  const maxOrder = Object.values(order).reduce((max, value) => Math.max(max, value), -1);
  const nextOrder = typeof record.nextOrder === 'number' && Number.isFinite(record.nextOrder)
    ? Math.max(Math.floor(record.nextOrder), maxOrder + 1, 0)
    : maxOrder + 1;
  return { names, nextOrder, order };
}

export function reconcileDeviceIdentities(
  devices: readonly DeviceView[],
  cache: DeviceIdentityCache,
): DeviceIdentityReconcileResult {
  let nextCache = cache;
  let cacheChanged = false;
  let viewsChanged = false;

  const mutableCache = () => {
    if (nextCache !== cache) return nextCache;
    nextCache = {
      names: { ...cache.names },
      nextOrder: cache.nextOrder,
      order: { ...cache.order },
    };
    return nextCache;
  };

  const patched = devices.map((device) => {
    const deviceId = device.deviceId.trim();
    if (!deviceId) return device;

    if (!Number.isFinite(nextCache.order[deviceId])) {
      const writable = mutableCache();
      writable.order[deviceId] = writable.nextOrder;
      writable.nextOrder += 1;
      cacheChanged = true;
    }

    const normalizedName = normalizeDeviceDisplayName(device.name);
    let nextName = device.name;
    if (normalizedName) {
      if (nextCache.names[deviceId] !== normalizedName) {
        mutableCache().names[deviceId] = normalizedName;
        cacheChanged = true;
      }
      nextName = normalizedName;
    } else if (nextCache.names[deviceId]) {
      nextName = nextCache.names[deviceId];
    }

    if (nextName === device.name) return device;
    viewsChanged = true;
    return { ...device, name: nextName };
  });

  const ordered = sortDevicesByIdentity(patched, nextCache);
  if (!sameDeviceOrder(patched, ordered)) viewsChanged = true;

  return {
    cache: nextCache,
    cacheChanged,
    devices: ordered,
    viewsChanged,
  };
}

export function normalizeDeviceDisplayName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || isPlaceholderDeviceName(trimmed)) return null;
  return trimmed;
}

function sortDevicesByIdentity(devices: readonly DeviceView[], cache: DeviceIdentityCache): DeviceView[] {
  return [...devices].sort((a, b) => {
    const onlineDiff = Number(b.online) - Number(a.online);
    if (onlineDiff !== 0) return onlineDiff;
    const orderDiff = deviceOrder(a.deviceId, cache) - deviceOrder(b.deviceId, cache);
    if (orderDiff !== 0) return orderDiff;
    const nameDiff = a.name.localeCompare(b.name);
    if (nameDiff !== 0) return nameDiff;
    return a.deviceId.localeCompare(b.deviceId);
  });
}

function deviceOrder(deviceId: string, cache: DeviceIdentityCache): number {
  const order = cache.order[deviceId];
  return Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER;
}

function sameDeviceOrder(a: readonly DeviceView[], b: readonly DeviceView[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((device, index) => device.deviceId === b[index]?.deviceId);
}

function normalizeNameMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [deviceId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    const name = normalizeDeviceDisplayName(value);
    if (!deviceId.trim() || !name) continue;
    out[deviceId] = name;
  }
  return out;
}

function normalizeOrderMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [deviceId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!deviceId.trim() || typeof value !== 'number' || !Number.isFinite(value)) continue;
    out[deviceId] = Math.max(0, Math.floor(value));
  }
  return out;
}

function isPlaceholderDeviceName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === 'unknown' || normalized === 'no';
}
