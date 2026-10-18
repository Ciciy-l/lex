import { useCallback, useEffect, useState } from 'react';
import { AGENT_PRESENTATION_CHANNEL, type AgentPresentationRequest, type AgentPresentationStatus } from '../../../shared/agentPresentation';

const PREF_KEY = 'lex.agentPresentation.v1';
type Mode = 'gui' | 'tui';
function preference(scope: string): Mode {
  try { return JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}')[scope] === 'tui' ? 'tui' : 'gui'; }
  catch { return 'gui'; }
}
function persist(scope: string, mode: Mode) {
  try {
    const parsed = JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}');
    const values: Record<string, string> = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    delete values[scope];
    if (mode === 'tui') values[scope] = mode;
    localStorage.setItem(PREF_KEY, JSON.stringify(Object.fromEntries(Object.entries(values).slice(-500))));
  } catch { /* View preference failure never changes the task. */ }
}

export function useAgentPresentation({ sessionId, deviceId, ownerId, enabled, runtimeKey }: {
  sessionId?: string; deviceId?: string | null; ownerId?: string | null; enabled: boolean; runtimeKey: string;
}) {
  const scope = JSON.stringify([ownerId ?? '', deviceId ?? 'local', sessionId ?? '']);
  const [chosen, setChosen] = useState<{ scope: string; mode: Mode }>(() => ({ scope, mode: preference(scope) }));
  const [availability, setAvailability] = useState<{ scope: string; generation?: string }>({ scope });
  const invoke = useCallback((request: AgentPresentationRequest) => deviceId
    ? window.electronAPI.deviceLink.invoke(deviceId, AGENT_PRESENTATION_CHANNEL, [request])
    : window.electronAPI.maker.presentation(request), [deviceId]);
  useEffect(() => {
    let cancelled = false;
    if (!enabled || !sessionId) { setAvailability({ scope }); return; }
    void invoke({ action: 'status', sessionId }).then((result) => {
      const status = result as AgentPresentationStatus;
      if (!cancelled) setAvailability({ scope, generation: status?.supported === true && status.state.status !== 'closed'
        ? status.state.generation : undefined });
    }, () => { if (!cancelled) setAvailability({ scope }); });
    return () => { cancelled = true; };
  }, [scope, sessionId, enabled, runtimeKey, invoke]);
  const generation = enabled && availability.scope === scope ? availability.generation : undefined;
  const supported = !!generation;
  const mode = supported ? (chosen.scope === scope ? chosen.mode : preference(scope)) : 'gui';
  const change = useCallback((mode: Mode) => { setChosen({ scope, mode }); persist(scope, mode); }, [scope]);
  return { supported, mode, change, invoke, generation };
}
