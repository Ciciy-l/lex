import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { Search, X, ChevronUp, ChevronDown, Minus, Plus, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tip } from '@/components/ui/tooltip';
import { themeService } from '@/themes/theme-service';
import { getTerminalTheme, openTerminalExternalLink } from '../right-sidebar/plugins/terminal/lib/xtermPool';
import type { AgentPresentationAttached, AgentPresentationRequest, AgentTerminalControl, AgentTerminalReplay, AgentRuntimeCapabilities } from '../../../shared/agentPresentation';

export type PresentationInvoke = (request: AgentPresentationRequest) => Promise<unknown>;
interface Controls { acquire(takeOver?: boolean): Promise<void>; suspend(): void; resize(): void; wake(): void;
  search(text: string, previous?: boolean): void; font(delta: number): void }
type Operation = AgentPresentationRequest extends infer R ? R extends { sessionId: string } ? Omit<R, 'sessionId'> : never : never;

/** A task's original native display. This component never creates a process. */
export function AgentNativeTerminal({ sessionId, active, invoke, onReconnect, runtimeCapabilities }: {
  sessionId: string; active: boolean; invoke: PresentationInvoke;
  /** Explicit retry may resume this exact task through its existing owner. */
  onReconnect?: () => Promise<void>;
  runtimeCapabilities?: AgentRuntimeCapabilities;
}) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active); activeRef.current = active;
  const controls = useRef<Controls | null>(null);
  const [connection, setConnection] = useState(0);
  const connectionEpoch = useRef(0);
  const retrying = useRef(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const runtimeNotes = [
    runtimeCapabilities?.sameTurnSteer?.supported === false && t(runtimeCapabilities.sameTurnSteer.recovery === 'native-ui'
      ? 'ccAgent.presentation.guiSteerInTui' : 'ccAgent.presentation.guiSteerQueued'),
    (runtimeCapabilities?.switchModel?.supported === false || runtimeCapabilities?.setPermissionModeMidSession?.supported === false)
      && t('ccAgent.presentation.settingsNeedReopen'),
    runtimeCapabilities?.sessionTree?.supported === false && t('ccAgent.presentation.guiTreeUnavailable'),
  ].filter(Boolean).join(String.fromCharCode(10));
  const [status, setStatus] = useState<'connecting' | 'viewing' | 'controlling' | 'exited' | 'unavailable' | 'gap'>('connecting');
  const statusText = {
    connecting: t('ccAgent.presentation.connecting'), viewing: t('ccAgent.presentation.viewing'),
    controlling: t('ccAgent.presentation.controlling'), exited: t('ccAgent.presentation.exited'),
    unavailable: t('ccAgent.presentation.unavailable'), gap: t('ccAgent.presentation.gap'),
  };
  const retry = async () => {
    if (retrying.current || !activeRef.current) return;
    retrying.current = true;
    const epoch = connectionEpoch.current;
    setStatus('connecting');
    try {
      await onReconnect?.();
      if (epoch === connectionEpoch.current) setConnection(value => value + 1);
    } catch {
      if (epoch === connectionEpoch.current) setStatus('unavailable');
    } finally { retrying.current = false; }
  };

  useEffect(() => {
    if (!host.current) return;
    connectionEpoch.current++;
    let disposed = false, attachmentId: string | undefined, control: AgentTerminalControl | null = null;
    let sequence = 0, inputSequence = 0, writeChain = Promise.resolve();
    let controlRevision = 0, pendingInputBytes = 0;
    const renderWaiters = new Set<() => void>();
    let acquireInFlight: Promise<void> | undefined;
    const terminal = new Terminal({ theme: getTerminalTheme(), fontFamily: '"SF Mono", Menlo, "Cascadia Code", monospace',
      fontSize: Math.min(24, Math.max(10, parseFloat(getComputedStyle(host.current).getPropertyValue('--app-code-font-size')) || 13)),
      lineHeight: 1.2, scrollback: 5000, cursorBlink: true, disableStdin: true });
    const fit = new FitAddon(); terminal.loadAddon(fit);
    const search = new SearchAddon(); terminal.loadAddon(search);
    terminal.loadAddon(new WebLinksAddon(openTerminalExternalLink));
    terminal.open(host.current);
    const offTheme = themeService.onDidChangeTheme(() => { terminal.options.theme = getTerminalTheme(); });
    // The task-owned terminal driver answers device queries even with no GUI.
    // Observers must not submit additional protocol answers as user input.
    const queryHandlers = [terminal.parser.registerCsiHandler({ final: 'n' }, () => true),
      terminal.parser.registerCsiHandler({ prefix: '?', final: 'n' }, () => true),
      terminal.parser.registerCsiHandler({ final: 'c' }, () => true),
      terminal.parser.registerCsiHandler({ prefix: '>', final: 'c' }, () => true),
      terminal.parser.registerCsiHandler({ intermediates: '$', final: 'p' }, () => true),
      terminal.parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, () => true),
      terminal.parser.registerCsiHandler({ final: 't' }, (params) => [14, 16, 18].includes(params[0] as number)),
      terminal.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, () => true),
      ...[4, 10, 11, 12].map((id) => terminal.parser.registerOscHandler(id, (data) => data.split(';').includes('?')))];
    const fail = () => { release(); if (!disposed) setStatus('unavailable'); };
    const send = (request: Operation) => invoke({ ...request, sessionId });
    const resize = () => {
      if (!control || !activeRef.current || !host.current?.clientWidth || !host.current.clientHeight) return;
      fit.fit();
      if (attachmentId && control) void send({ action: 'resize', attachmentId, control, cols: terminal.cols, rows: terminal.rows }).catch(fail);
    };
    const release = () => {
      controlRevision++;
      const old = control; control = null; terminal.options.disableStdin = true;
      if (attachmentId && old) void send({ action: 'release', attachmentId, control: old }).catch(() => {});
      if (!disposed) setStatus((s) => s === 'controlling' ? 'viewing' : s);
    };
    const suspend = () => {
      terminal.options.disableStdin = true;
      const lease = control, revision = ++controlRevision;
      if (!pendingInputBytes) { release(); return; }
      // A presentation switch stops new input, but an already accepted Enter
      // must follow its text before this valid lease is released. Errors,
      // disposal and a revoked lease still stop the queue without replay.
      void writeChain.then(() => {
        if (!disposed && !activeRef.current && control === lease && revision === controlRevision) release();
      });
    };
    const acquire = (takeOver = false): Promise<void> => {
      if (acquireInFlight) return acquireInFlight;
      if (!attachmentId || disposed || !activeRef.current) return Promise.resolve();
      if (control && !takeOver) {
        controlRevision++; terminal.options.disableStdin = false; setStatus('controlling');
        resize(); terminal.focus(); return Promise.resolve();
      }
      const id = attachmentId;
      const revision = ++controlRevision;
      acquireInFlight = send({ action: 'control', attachmentId: id, takeOver }).then((result) => {
        const lease = result as AgentTerminalControl | null;
        if (disposed || !activeRef.current || revision !== controlRevision) {
          if (lease) void send({ action: 'release', attachmentId: id, control: lease }).catch(() => {});
          return;
        }
        if (lease?.lease !== control?.lease) inputSequence = 0;
        control = lease; terminal.options.disableStdin = !lease; setStatus(lease ? 'controlling' : 'viewing');
        resize(); if (lease) terminal.focus();
      }).catch(fail).finally(() => { acquireInFlight = undefined; });
      return acquireInFlight;
    };
    let wakeHidden: (() => void) | undefined;
    controls.current = { acquire, suspend, resize, wake: () => wakeHidden?.(),
      search: (text, previous) => {
        if (text) (previous ? search.findPrevious(text) : search.findNext(text));
        else search.clearDecorations();
      },
      font: delta => { terminal.options.fontSize = Math.min(24, Math.max(10, (terminal.options.fontSize ?? 13) + delta)); resize(); },
    };
    const input = terminal.onData((data) => {
      const lease = control, id = attachmentId;
      if (!activeRef.current || !lease || !id || disposed) return;
      const bytes = new TextEncoder().encode(data).byteLength;
      if (bytes > 65_536 || pendingInputBytes + bytes > 65_536) { fail(); return; }
      pendingInputBytes += bytes;
      const nextSequence = ++inputSequence;
      writeChain = writeChain.then(async () => {
        if (disposed || control !== lease) return;
        await send({ action: 'write', attachmentId: id, control: lease, sequence: nextSequence, data });
      }).catch(() => { if (control === lease) fail(); }).finally(() => { pendingInputBytes -= bytes; }); // Never replay an uncertain input.
    });
    terminal.attachCustomKeyEventHandler((event) => {
      // Let xterm own the native IME sequence, including composition Enter.
      if (event.isComposing || event.keyCode === 229) return true;
      if (event.type === 'keydown' && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault(); setSearching(true); return false;
      }
      if (event.type === 'keydown' && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'c' && terminal.hasSelection()) {
        event.preventDefault(); void navigator.clipboard.writeText(terminal.getSelection()).catch(() => {}); return false;
      }
      return true;
    });
    const observer = new ResizeObserver(resize); observer.observe(host.current);
    const writeOutput = (data: string) => new Promise<void>((resolve) => {
      const done = () => { renderWaiters.delete(done); resolve(); };
      renderWaiters.add(done); terminal.write(data, done);
    });
    const render = async (replay: AgentTerminalReplay, revision: number) => {
      if (replay.gap) { release(); setStatus('gap'); return false; }
      if (revision === controlRevision && control && !replay.controlling) {
        release(); setStatus('viewing');
      }
      if (replay.snapshot) {
        terminal.reset(); terminal.resize(replay.snapshot.cols, replay.snapshot.rows);
        await writeOutput(replay.snapshot.data);
        sequence = replay.snapshot.sequence;
      }
      let batch = '';
      const flush = async () => { if (batch) { const text = batch; batch = ''; await writeOutput(text); } };
      for (const frame of replay.frames) {
        if (disposed) return false;
        if (frame.sequence !== sequence + 1) { release(); setStatus('gap'); return false; }
        if (frame.size || batch.length + frame.data.length > 32_768) await flush();
        if (disposed) return false;
        if (frame.size) terminal.resize(frame.size.cols, frame.size.rows);
        batch += frame.data;
        sequence = frame.sequence;
      }
      await flush();
      if (disposed) return false;
      if (replay.state.status !== 'running' && sequence >= replay.state.sequence) { release(); setStatus('exited'); return false; }
      return true;
    };
    setStatus('connecting');
    void (async () => {
      const attached = await send({ action: 'attach' }) as AgentPresentationAttached;
      attachmentId = attached.attachmentId;
      if (disposed) { await send({ action: 'detach', attachmentId }); return; }
      if (!await render(attached.replay, controlRevision)) return;
      setStatus('viewing'); await acquire();
      while (!disposed) {
        if (!activeRef.current) {
          // Only presentation reads are throttled. Host events, admissions and
          // approvals continue; its bounded replay/snapshot is the recovery source.
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); wakeHidden = undefined; resolve(); };
            const timer = setTimeout(done, 250); wakeHidden = done;
          });
          if (disposed) break;
        }
        const revision = controlRevision;
        const replay = await send({ action: 'read', attachmentId, afterSequence: sequence, wait: true }) as AgentTerminalReplay;
        if (disposed || !await render(replay, revision)) break;
      }
    })().catch(fail);
    return () => {
      connectionEpoch.current++;
      disposed = true; wakeHidden?.(); controls.current = null; release();
      for (const resolve of renderWaiters) resolve();
      if (attachmentId) void send({ action: 'detach', attachmentId }).catch(() => {});
      observer.disconnect(); input.dispose(); offTheme(); queryHandlers.forEach((handler) => handler.dispose()); terminal.dispose();
    };
  }, [sessionId, invoke, connection]);

  useEffect(() => {
    if (active) { controls.current?.wake(); controls.current?.resize(); void controls.current?.acquire(); }
    else controls.current?.suspend();
  }, [active]);
  useEffect(() => { if (searching && active) searchInput.current?.focus(); }, [searching, active]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--panel-bg)]" aria-label={t('ccAgent.presentation.tuiDescription')}>
        <div role="status" className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-3 py-1 text-11 text-[var(--text-secondary)]">
          <span className="min-w-0 flex-1">{statusText[status]}</span>
          <div className="flex shrink-0 items-center">
            {runtimeNotes && <Tip text={runtimeNotes} contentClassName="whitespace-pre-line"><span tabIndex={0} aria-label={runtimeNotes} className="flex h-7 w-7 items-center justify-center"><Info size={14} /></span></Tip>}
            <Tip text={t('ccAgent.presentation.search')}><button type="button" aria-label={t('ccAgent.presentation.search')} onClick={() => { setSearching(true); searchInput.current?.focus(); }}
              className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-ring"><Search size={14} /></button></Tip>
            <Tip text={t('ccAgent.presentation.smallerFont')}><button type="button" aria-label={t('ccAgent.presentation.smallerFont')} onClick={() => controls.current?.font(-1)}
              className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-ring"><Minus size={14} /></button></Tip>
            <Tip text={t('ccAgent.presentation.largerFont')}><button type="button" aria-label={t('ccAgent.presentation.largerFont')} onClick={() => controls.current?.font(1)}
              className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-ring"><Plus size={14} /></button></Tip>
          </div>
          {status === 'viewing' && <button type="button" onClick={() => void controls.current?.acquire(true)}
            className="min-h-7 rounded-full bg-[var(--surface-chip)] px-3 focus-visible:ring-2 focus-visible:ring-ring">
            {t('ccAgent.presentation.takeControl')}
          </button>}
          {(status === 'unavailable' || status === 'gap' || status === 'exited') && <button type="button" onClick={() => void retry()}
            className="min-h-7 rounded-full bg-[var(--surface-chip)] px-3 focus-visible:ring-2 focus-visible:ring-ring">
            {t('ccAgent.presentation.retry')}
          </button>}
        </div>
      {searching && <div className="flex shrink-0 items-center gap-1 px-3 pb-1">
        <input ref={searchInput} aria-label={t('ccAgent.presentation.search')} value={query}
          className="h-7 min-w-0 flex-1 rounded-full bg-[var(--surface-chip)] px-3 text-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onChange={event => { setQuery(event.target.value); controls.current?.search(event.target.value); }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Enter') { event.preventDefault(); controls.current?.search(query, event.shiftKey); }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setSearching(false); controls.current?.search(''); void controls.current?.acquire(); }
          }} />
        <Tip text={t('ccAgent.presentation.previousMatch')}><button type="button" aria-label={t('ccAgent.presentation.previousMatch')} onClick={() => controls.current?.search(query, true)} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-ring"><ChevronUp size={14} /></button></Tip>
        <Tip text={t('ccAgent.presentation.nextMatch')}><button type="button" aria-label={t('ccAgent.presentation.nextMatch')} onClick={() => controls.current?.search(query)} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-ring"><ChevronDown size={14} /></button></Tip>
        <Tip text={t('ccAgent.presentation.closeSearch')}><button type="button" aria-label={t('ccAgent.presentation.closeSearch')} onClick={() => { setSearching(false); controls.current?.search(''); void controls.current?.acquire(); }} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-ring"><X size={14} /></button></Tip>
      </div>}
      <div ref={host} className="min-h-0 flex-1 overflow-hidden px-2 py-1" />
    </div>
  );
}
