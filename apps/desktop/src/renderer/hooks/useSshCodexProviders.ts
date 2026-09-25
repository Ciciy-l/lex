import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderView } from '@cindy/model-providers';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';

export type SshCodexProviderStatus = 'loading' | 'error' | 'ready';

export interface SshCodexProvidersState {
  providers: ProviderView[];
  status: SshCodexProviderStatus;
  revision: number;
  refresh: () => void;
}

const EMPTY: ProviderView[] = [];

export function useSshCodexProviders(hostId?: string | null): SshCodexProvidersState {
  const owner = getDataOwnerGeneration();
  const key = JSON.stringify([hostId, owner.dataOwnerId, owner.generation]);
  const sequence = useRef(0);
  const [state, setState] = useState<{
    key: string;
    providers: ProviderView[];
    status: SshCodexProviderStatus;
    revision: number;
  }>({ key: '', providers: EMPTY, status: 'loading', revision: 0 });

  const refresh = useCallback(async (): Promise<boolean> => {
    if (!hostId) return false;
    const request = ++sequence.current;
    const requestOwner = getDataOwnerGeneration();
    setState((previous) => ({
      key,
      providers: EMPTY,
      status: 'loading',
      revision: previous.key === key ? previous.revision : 0,
    }));
    try {
      const providers = await window.electronAPI.remoteSsh.listCodexModels(hostId);
      if (sequence.current !== request || !isDataOwnerGenerationCurrent(requestOwner)) return false;
      setState((previous) => ({
        key,
        providers,
        status: 'ready',
        revision: (previous.key === key ? previous.revision : 0) + 1,
      }));
      return true;
    } catch {
      if (sequence.current !== request || !isDataOwnerGenerationCurrent(requestOwner)) return false;
      setState((previous) => ({
        key,
        providers: EMPTY,
        status: 'error',
        revision: previous.key === key ? previous.revision : 0,
      }));
      return false;
    }
  }, [hostId, key]);

  useEffect(() => {
    if (!hostId) return;
    const initialRefresh = refresh();
    const initialRequest = sequence.current;
    let disposed = false;
    let wasReady: boolean | null = null;
    const stop = window.electronAPI.remoteSsh.onStatusChanged((snapshot) => {
      if (snapshot.config.id !== hostId) return;
      if (snapshot.status === 'ready') {
        if (wasReady === null) {
          void initialRefresh.then((succeeded) => {
            if (!succeeded && !disposed && wasReady && sequence.current === initialRequest) {
              void refresh();
            }
          });
        } else if (!wasReady) {
          void refresh();
        }
        wasReady = true;
      } else {
        wasReady = false;
        ++sequence.current;
        setState((previous) => ({
          key,
          providers: EMPTY,
          status: 'error',
          revision: previous.key === key ? previous.revision : 0,
        }));
      }
    });
    return () => {
      disposed = true;
      ++sequence.current;
      stop();
    };
  }, [hostId, key, refresh]);

  return {
    providers: state.key === key ? state.providers : EMPTY,
    status: state.key === key ? state.status : 'loading',
    revision: state.key === key ? state.revision : 0,
    refresh: () => { void refresh(); },
  };
}
