import { randomUUID } from 'node:crypto';
import type { AgentPresentationAttachment, AgentSessionPresentation, AgentPresentationInitialization } from '@cindy/maker-core';
import type { AgentPresentationRequest, AgentTerminalControl, AgentRuntimeSnapshot } from '../../shared/agentPresentation.js';

export interface PresentationPeer {
  /** Derived from the trusted window/device context, never a wire argument. */
  id: string;
  /** Recheck account, transport generation and task access after any wait. */
  assertCurrent(): void;
}
export interface PresentationInitialization {
  readonly settled: Promise<AgentPresentationInitialization>;
  isCurrent(): boolean;
}
interface Entry {
  sessionId: string;
  peer: PresentationPeer;
  runtime: AgentSessionPresentation;
  view: AgentPresentationAttachment;
  wake?: () => void;
  touchedAt: number;
}

/** Views attach to already-live task handles. This service cannot start an engine. */
export class AgentPresentationService {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly resolve: (sessionId: string) => AgentSessionPresentation | undefined,
    private readonly now = Date.now,
    private readonly initialization?: (sessionId: string) => PresentationInitialization | undefined,
    private readonly runtimeSnapshot?: (sessionId: string) => AgentRuntimeSnapshot | undefined) {}

  async invoke(peer: PresentationPeer, raw: unknown): Promise<unknown> {
    const request = validate(raw);
    peer.assertCurrent();
    this.prune();
    let initialized: AgentPresentationInitialization | undefined;
    if (request.action === 'status' || request.action === 'attach') {
      const activation = this.initialization?.(request.sessionId);
      if (activation) {
        // Observe host-owned work only. A missing Main binding must not hang a
        // view indefinitely or cause that view to create an engine/frontend.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          initialized = await Promise.race([activation.settled, new Promise<AgentPresentationInitialization>(resolve => {
            timer = setTimeout(() => resolve({ status: 'unavailable', reason: 'startup-failed' }), 60_000);
            timer.unref();
          })]);
          peer.assertCurrent();
          if (!activation.isCurrent()) throw new Error('Native task generation changed during activation');
        } finally { if (timer) clearTimeout(timer); }
      }
    }
    const runtime = this.resolve(request.sessionId);
    if (request.action === 'status') {
      const snapshot = this.runtimeSnapshot?.(request.sessionId);
      return runtime ? { supported: true, state: runtime.state(), ...(snapshot ? { runtime: snapshot } : {}) }
        : { supported: false, ...(snapshot ? { runtime: snapshot } : {}),
          ...(initialized ? { reason: initialized.status === 'unavailable' ? initialized.reason : 'startup-failed' } : {}) };
    }
    if (request.action === 'attach') {
      if (!runtime) throw new Error('Native presentation unavailable');
      if (this.entries.size >= 256 || [...this.entries.values()].filter((e) => e.peer.id === peer.id).length >= 16) {
        throw new Error('Too many native presentation views');
      }
      const attachmentId = randomUUID();
      let entry: Entry | undefined;
      const view = runtime.attach(peer.id, () => entry?.wake?.());
      entry = { sessionId: request.sessionId, peer, runtime, view, touchedAt: this.now() };
      this.entries.set(attachmentId, entry);
      try { return { attachmentId, replay: view.read() }; }
      catch (error) { this.detach(attachmentId); throw error; }
    }
    const entry = this.entries.get(request.attachmentId);
    if (!entry || entry.peer.id !== peer.id || entry.sessionId !== request.sessionId) throw new Error('Native presentation view expired');
    try { entry.peer.assertCurrent(); } catch (error) { this.detach(request.attachmentId); throw error; }
    if (entry.runtime !== runtime) { this.detach(request.attachmentId); throw new Error('Native task generation changed'); }
    entry.touchedAt = this.now();
    switch (request.action) {
      case 'detach': this.detach(request.attachmentId); return;
      case 'control': return entry.view.acquireControl(request.takeOver);
      case 'release': return entry.view.releaseControl(request.control);
      case 'write': return entry.view.write(request.control, request.sequence, request.data);
      case 'resize': return entry.view.resize(request.control, request.cols, request.rows);
      case 'read': {
        if (entry.wake) throw new Error('Native presentation read already pending');
        const initial = entry.view.read(request.afterSequence);
        if (!request.wait || initial.gap || initial.snapshot || initial.frames.length || initial.state.status !== 'running') return initial;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await new Promise<void>((resolve) => {
            entry.wake = resolve;
            timer = setTimeout(resolve, 20_000);
            timer.unref();
          });
          peer.assertCurrent(); entry.peer.assertCurrent();
          if (this.resolve(request.sessionId) !== runtime) throw new Error('Native task generation changed');
          entry.touchedAt = this.now();
          return entry.view.read(request.afterSequence);
        } catch (error) { this.detach(request.attachmentId); throw error; }
        finally { if (timer) clearTimeout(timer); entry.wake = undefined; }
      }
    }
  }

  detachPeer(peerId: string): void {
    for (const [id, entry] of this.entries) if (entry.peer.id === peerId) this.detach(id);
  }
  close(): void { for (const id of this.entries.keys()) this.detach(id); }
  private detach(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id); entry.wake?.(); entry.view.detach();
  }
  private prune(): void {
    for (const [id, entry] of this.entries) {
      if (this.now() - entry.touchedAt > 60_000 || this.resolve(entry.sessionId) !== entry.runtime) this.detach(id);
      else { try { entry.peer.assertCurrent(); } catch { this.detach(id); } }
    }
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid presentation request');
  return value as Record<string, unknown>;
}
function id(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256; }
function control(value: unknown): value is AgentTerminalControl {
  const entry = object(value); return id(entry.generation) && id(entry.lease);
}
function validate(raw: unknown): AgentPresentationRequest {
  const r = object(raw);
  if (!id(r.sessionId)) throw new Error('Invalid presentation task');
  if (r.action === 'status' || r.action === 'attach') return { sessionId: r.sessionId, action: r.action };
  if (!id(r.attachmentId)) throw new Error('Invalid presentation attachment');
  const base = { sessionId: r.sessionId, attachmentId: r.attachmentId };
  if (r.action === 'detach') return { ...base, action: r.action };
  if (r.action === 'control' && (r.takeOver === undefined || typeof r.takeOver === 'boolean')) return { ...base, action: r.action, takeOver: r.takeOver };
  if (r.action === 'read' && Number.isSafeInteger(r.afterSequence) && (r.afterSequence as number) >= 0
    && (r.wait === undefined || typeof r.wait === 'boolean')) return { ...base, action: r.action, afterSequence: r.afterSequence as number, wait: r.wait };
  if (r.action === 'write' && control(r.control) && Number.isSafeInteger(r.sequence) && (r.sequence as number) > 0
    && typeof r.data === 'string' && Buffer.byteLength(r.data) <= 65_536) return { ...base, action: r.action, control: { generation: r.control.generation, lease: r.control.lease }, sequence: r.sequence as number, data: r.data };
  if (r.action === 'release' && control(r.control)) return { ...base, action: r.action, control: { generation: r.control.generation, lease: r.control.lease } };
  if (r.action === 'resize' && control(r.control) && Number.isInteger(r.cols) && Number.isInteger(r.rows)
    && (r.cols as number) >= 2 && (r.cols as number) <= 1000 && (r.rows as number) >= 2 && (r.rows as number) <= 1000) return { ...base, action: r.action, control: { generation: r.control.generation, lease: r.control.lease }, cols: r.cols as number, rows: r.rows as number };
  throw new Error('Invalid presentation operation');
}
