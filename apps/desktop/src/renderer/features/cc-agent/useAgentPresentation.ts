import { useCallback, useEffect, useRef, useState } from 'react';
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

export function useAgentPresentation({ sessionId, deviceId, ownerId, enabled, runtimeKey, prepare, initialMode }: {
  sessionId?: string; deviceId?: string | null; ownerId?: string | null; enabled: boolean; runtimeKey: string;
  /** Explicit TUI selection uses the existing product creation funnel. */
  prepare?: () => Promise<void>;
  /** One explicit routed selection; never inherited by a different owner. */
  initialMode?: Mode;
}) {
  const scope = JSON.stringify([ownerId ?? '', deviceId ?? 'local', sessionId ?? '']);
  const [chosen, setChosen] = useState<{ scope: string; mode: Mode }>(() => ({ scope, mode: preference(scope) }));
  const [availability, setAvailability] = useState<{ scope: string; generation?: string;
    reason?: Extract<AgentPresentationStatus, { supported: false }>['reason'] }>({ scope });
  const invoke = useCallback((request: AgentPresentationRequest) => deviceId
    ? window.electronAPI.deviceLink.invoke(deviceId, AGENT_PRESENTATION_CHANNEL, [request])
    : window.electronAPI.maker.presentation(request), [deviceId]);
  useEffect(() => {
    let cancelled = false;
    if (!enabled || !sessionId) { setAvailability({ scope }); return; }
    void invoke({ action: 'status', sessionId }).then((result) => {
      const status = result as AgentPresentationStatus;
      if (!cancelled) setAvailability({ scope, generation: status?.supported === true && status.state.status !== 'closed'
        ? status.state.generation : undefined, reason: status?.supported === false ? status.reason : undefined });
    }, () => { if (!cancelled) setAvailability({ scope, reason: 'startup-failed' }); });
    return () => { cancelled = true; };
  }, [scope, sessionId, enabled, runtimeKey, invoke]);
  const generation = enabled && availability.scope === scope ? availability.generation : undefined;
  const supported = !!generation;
  const mode = supported ? (chosen.scope === scope ? chosen.mode : preference(scope)) : 'gui';
  const opening = useRef<Promise<void> | undefined>(undefined);
  const liveScope = useRef(scope); liveScope.current = scope;
  const change = useCallback((mode: Mode) => {
    if (mode === 'tui' && !supported && prepare && sessionId && enabled) {
      if (opening.current) return;
      opening.current = Promise.resolve().then(() => {
        if (liveScope.current !== scope) throw new Error('Native task view owner changed');
        return prepare();
      }).then(async () => {
        const status = await invoke({ action: 'status', sessionId }) as AgentPresentationStatus;
        if (liveScope.current !== scope) return;
        if (!status.supported || status.state.status === 'closed') {
          setAvailability({ scope, reason: status.supported ? 'startup-failed' : status.reason ?? 'startup-failed' });
          return;
        }
        setAvailability({ scope, generation: status.state.generation });
        setChosen({ scope, mode }); persist(scope, mode);
      }).catch(() => { if (liveScope.current === scope) setAvailability({ scope, reason: 'startup-failed' }); })
        .finally(() => { opening.current = undefined; });
      return;
    }
    setChosen({ scope, mode }); persist(scope, mode);
  }, [scope, supported, prepare, sessionId, enabled, invoke]);
  const routedSelection = useRef({ scope, mode: initialMode, applied: false });
  useEffect(() => {
    const selection = routedSelection.current;
    if (selection.applied || selection.scope !== scope || !selection.mode || !enabled || !sessionId || !prepare) return;
    selection.applied = true;
    change(selection.mode);
  }, [scope, enabled, sessionId, prepare, change]);
  const unavailableReason = enabled && availability.scope === scope ? availability.reason : undefined;
  return { supported, selectable: supported || (enabled && !!prepare), mode, change, invoke, generation, unavailableReason };
}
