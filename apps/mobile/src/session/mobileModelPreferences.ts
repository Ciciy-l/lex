import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef, useState } from 'react';
import type { MobileModelPreferences, MobileModelFavorite } from './unifiedMobileModels';
import type { AgentKind } from '@cindy/model-providers/types';
const agents = new Set(['claude-code', 'codex', 'pi', 'omp']);
import { useRemoteMobileFavorites } from './useRemoteMobileFavorites';
export function sanitizeModelPreferences(value: unknown): MobileModelPreferences {
  const result: MobileModelPreferences = { favorites: [], engines: {} };
  if (!value || typeof value !== 'object') return result;
  const raw = value as Partial<MobileModelPreferences>;
  if (Array.isArray(raw.favorites)) result.favorites = raw.favorites.filter((item): item is MobileModelFavorite =>
    !!item && typeof item.uid === 'string' && !!item.uid && typeof item.providerId === 'string' && !!item.providerId
    && typeof item.modelId === 'string' && !!item.modelId && agents.has(item.agent)
    && typeof item.effort === 'string' && typeof item.fast === 'boolean');
  if (raw.engines && typeof raw.engines === 'object') for (const [key, agent] of Object.entries(raw.engines)) {
    if (agents.has(agent)) result.engines[key] = agent as AgentKind;
  }
  return result;
}
/** Favorites and engine choices belong to the controlling account AND remote device.
 * Effort/Fast memories continue through the existing draft/mirror accessors. */
export function useMobileModelPreferences(scope: string, visible = true) {
  const remote = useRemoteMobileFavorites(scope, visible);
  const currentScope = useRef(scope); currentScope.current = scope;
  const [state, setState] = useState<{ scope: string; value: MobileModelPreferences } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const key = `cindy:mobileModelPicker:v1:${scope}`;
  useEffect(() => {
    let disposed = false;
    setError(null);
    void AsyncStorage.getItem(key).then(raw => {
      const value = sanitizeModelPreferences(raw ? JSON.parse(raw) : null);
      if (!disposed) setState({ scope, value });
    }).catch(err => { if (!disposed) setError(err); });
    return () => { disposed = true; };
  }, [scope, key]);
  const ready = state?.scope === scope;
  return { ready, favoritesReady: remote.ready, error: error ?? remote.error, value: {favorites:remote.items, engines:ready ? state.value.engines : {} } as MobileModelPreferences,
    save: async (value: MobileModelPreferences) => {
      if (!ready || currentScope.current !== scope) throw new Error('Model preference owner changed');
      await remote.save(value.favorites);
      if (currentScope.current !== scope) throw new Error('Model preference owner changed');
      if (state?.scope === scope && JSON.stringify(state.value.engines) === JSON.stringify(value.engines)) return;
      // Preserve the previous local snapshot for recovery; it is no longer the remote truth.
      const stored = {...value, favorites: state?.scope === scope ? state.value.favorites : []};
      await AsyncStorage.setItem(key, JSON.stringify(stored));
      if (currentScope.current === scope) setState({ scope, value:stored });
    },
  };
}
