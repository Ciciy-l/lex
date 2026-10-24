import { useCallback, useEffect, useRef, useState } from 'react';
import { AGENT_PRESENTATION_CHANNEL, type AgentPresentationRequest, type AgentPresentationStatus, type AgentRuntimeSnapshot } from '../../../shared/agentPresentation';
import { extractIpcError } from '../../utils/ipcError';

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
  const [availability, setAvailability] = useState<{ scope: string; generation?: string; runtime?: AgentRuntimeSnapshot;
    reason?: Extract<AgentPresentationStatus, { supported: false }>['reason'] }>({ scope });
  const invoke = useCallback((request: AgentPresentationRequest) => deviceId
    ? window.electronAPI.deviceLink.invoke(deviceId, AGENT_PRESENTATION_CHANNEL, [request])
    : window.electronAPI.maker.presentation(request), [deviceId]);
  const liveView = useRef({ scope, enabled });
  if (liveView.current.scope !== scope || liveView.current.enabled !== enabled) liveView.current = { scope, enabled };
  const view = liveView.current;
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const statusRevision = useRef(0);
  useEffect(() => {
    let cancelled = false;
    const revision = ++statusRevision.current;
    if (!enabled || !sessionId) { setAvailability({ scope }); return; }
    void invoke({ action: 'status', sessionId }).then((result) => {
      const status = result as AgentPresentationStatus;
      if (!cancelled && revision === statusRevision.current) setAvailability({ scope, generation: status?.supported === true && status.state.status !== 'closed'
        ? status.state.generation : undefined, reason: status?.supported === false ? status.reason : undefined, runtime: status?.runtime });
    }, () => { if (!cancelled && revision === statusRevision.current) setAvailability({ scope, reason: 'startup-failed' }); });
    return () => { cancelled = true; };
  }, [scope, sessionId, enabled, runtimeKey, invoke]);
  const generation = enabled && availability.scope === scope ? availability.generation : undefined;
  const supported = !!generation;
  const mode = supported ? (chosen.scope === scope ? chosen.mode : preference(scope)) : 'gui';
  const opening = useRef<{ view: typeof view; promise: Promise<void> } | undefined>(undefined);
  const [preparingView, setPreparingView] = useState<typeof view>();
  const intent = useRef<{ view: typeof view; mode: Mode } | undefined>(undefined);
  const reconnect = useCallback((): Promise<void> => {
    const current = () => mounted.current && liveView.current === view && enabled && !!sessionId;
    if (!sessionId || !current()) return Promise.reject(new Error('Native task view owner changed'));
    if (opening.current?.view === view) return opening.current.promise;
    ++statusRevision.current;
    setPreparingView(view);
    const attempt = Promise.resolve().then(async () => {
      if (!current()) throw new Error('Native task view owner changed');
      let revision = ++statusRevision.current;
      let status = await invoke({ action: 'status', sessionId }) as AgentPresentationStatus;
      if (!current()) throw new Error('Native task view owner changed');
      if (!status.supported || status.state.status !== 'running') {
        if (!prepare) throw new Error('Native task recovery is unavailable');
        // Reuse the existing owner-checked creation/resume funnel. It rejects
        // busy or uncertain work; this view never submits or replays a message.
        await prepare();
        if (!current()) throw new Error('Native task view owner changed');
        revision = ++statusRevision.current;
        status = await invoke({ action: 'status', sessionId }) as AgentPresentationStatus;
      }
      if (!current()) throw new Error('Native task view owner changed');
      if (!status.supported || status.state.status !== 'running') throw new Error('Native task recovery is unavailable');
      if (revision === statusRevision.current) setAvailability({ scope, generation: status.state.generation, runtime: status.runtime });
    }).catch(error => {
      if (current()) setAvailability({ scope,
        reason: extractIpcError(error)?.code === 'SESSION_RUNNING' ? 'task-busy' : 'startup-failed' });
      throw error;
    }).finally(() => {
      if (opening.current?.promise === attempt) {
        opening.current = undefined;
        if (current()) setPreparingView(undefined);
      }
    });
    opening.current = { view, promise: attempt };
    return attempt;
  }, [view, scope, sessionId, enabled, prepare, invoke]);
  const change = useCallback((mode: Mode) => {
    const current = () => mounted.current && liveView.current === view && enabled && !!sessionId;
    if (!current()) return;
    intent.current = { view, mode };
    if (mode === 'tui' && !supported && prepare && sessionId && enabled) {
      if (opening.current?.view === view) return;
      ++statusRevision.current;
      setPreparingView(view);
      const attempt = Promise.resolve().then(() => {
        if (!current()) throw new Error('Native task view owner changed');
        return prepare();
      }).then(async () => {
        if (!current()) return;
        const revision = ++statusRevision.current;
        const status = await invoke({ action: 'status', sessionId }) as AgentPresentationStatus;
        if (!current() || revision !== statusRevision.current) return;
        if (!status.supported || status.state.status === 'closed') {
          setAvailability({ scope, reason: status.supported ? 'startup-failed' : status.reason ?? 'startup-failed', runtime: status.runtime });
          return;
        }
        setAvailability({ scope, generation: status.state.generation, runtime: status.runtime });
        // Preparation creates/resumes the task, but cannot overrule a later view choice.
        if (intent.current?.view === view && intent.current.mode === 'tui') {
          setChosen({ scope, mode }); persist(scope, mode);
        }
      }).catch(error => { if (current()) setAvailability({ scope,
        reason: extractIpcError(error)?.code === 'SESSION_RUNNING' ? 'task-busy' : 'startup-failed' }); })
        .finally(() => {
          if (opening.current?.promise === attempt) {
            opening.current = undefined;
            if (current()) setPreparingView(undefined);
          }
        });
      opening.current = { view, promise: attempt };
      return;
    }
    setChosen({ scope, mode }); persist(scope, mode);
  }, [view, scope, supported, prepare, sessionId, enabled, invoke]);
  const routedSelection = useRef({ scope, mode: initialMode, applied: false });
  useEffect(() => {
    const selection = routedSelection.current;
    if (selection.applied || selection.scope !== scope || !selection.mode || !enabled || !sessionId || !prepare) return;
    selection.applied = true;
    change(selection.mode);
  }, [scope, enabled, sessionId, prepare, change]);
  const unavailableReason = enabled && availability.scope === scope ? availability.reason : undefined;
  return { supported, selectable: supported || (enabled && !!prepare), mode, change, reconnect, invoke, generation, unavailableReason,
    runtime: enabled && availability.scope === scope ? availability.runtime : undefined,
    preparing: enabled && preparingView === view };
}
