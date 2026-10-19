import { waitForCodexNativeAttach } from './native-attach-readiness.js';
import type { CodexNativeTaskRoutingOptions } from './native-task-routing.js';
import type { AgentSessionPresentation } from '../presentation.js';
import type { CodexNativeSessionHandle } from './native-input.js';
import type { CodexNativeServiceBinding } from './native-service-slot.js';
import type { CodexNativeTaskCreation } from './native-task-creation.js';
import type { AppServerHost } from './app-server/host.js';
import type { ThreadStartParams } from './app-server/protocol.js';
import type { CodexNativeRuntimeSnapshot } from './native-input.js';

export interface CodexNativePresentationLaunch {
  handle: CodexNativeSessionHandle;
  service: CodexNativeServiceBinding;
  cwd: string;
  signal: AbortSignal;
  /** Product account/DB/Session binding; never a renderer attachment. */
  ownerSignal?: AbortSignal;
  isCurrent(): boolean;
  routingContext: Pick<CodexNativeTaskRoutingOptions, 'ownsDescendant' | 'titleContext'> & { control?: CodexNativeTaskRoutingOptions['control'] };
}
export interface CodexNativePresentationOwner {
  presentation: AgentSessionPresentation;
  /** Genuine original-thread resume ACK has been written to the frontend. */
  ready: Promise<void>;
  close(): Promise<void>;
}
export type CodexNativePresentationFactory = (launch: CodexNativePresentationLaunch) => Promise<CodexNativePresentationOwner>;

/** Fresh TUI starts before a native id exists. Binding never fabricates a handle. */
export interface CodexNativeFreshPresentationLaunch {
  sessionId: string;
  service: CodexNativeServiceBinding;
  host: Pick<AppServerHost, 'request'>;
  creation: CodexNativeTaskCreation;
  cwd: string;
  signal: AbortSignal;
  isCurrent(): boolean;
  readRuntime(): Readonly<CodexNativeRuntimeSnapshot>;
  prepareStart(params: Record<string, unknown>): Promise<ThreadStartParams>;
  attachNativeApprovalFrontend: CodexNativeSessionHandle['attachNativeApprovalFrontend'];
  attachNativeToolFrontend?: CodexNativeSessionHandle['attachNativeToolFrontend'];
}
export interface CodexNativePreparedPresentation {
  bind(launch: CodexNativePresentationLaunch): CodexNativePresentationOwner;
  close(): Promise<void>;
}
export type CodexNativeFreshPresentationFactory = (launch: CodexNativeFreshPresentationLaunch) => Promise<CodexNativePreparedPresentation>;

/** One task owns this lifetime; view attachments never call start or close. */
export class CodexNativeTaskPresentation {
  private readonly lifetime = new AbortController();
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private owner?: CodexNativePresentationOwner;
  private attached = false;
  private stopService?: () => void;
  private current?: () => boolean;
  constructor(private readonly warn: (message: string) => void) {}
  get presentation(): AgentSessionPresentation | undefined {
    if (this.owner && this.current && !this.current()) {
      void this.close().catch(() => this.warn('native Codex stale frontend close unconfirmed'));
      return undefined;
    }
    return this.lifetime.signal.aborted || !this.attached ? undefined : this.owner?.presentation;
  }
  async start(factory: CodexNativePresentationFactory, launch: Omit<CodexNativePresentationLaunch, 'signal'>,
    prepare?: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.startPromise || this.lifetime.signal.aborted) throw new Error('Native Codex frontend lifetime already started or retired');
    const nativeId = launch.handle.id;
    const isCurrent = () => !this.lifetime.signal.aborted && !launch.service.signal.aborted && !launch.ownerSignal?.aborted
      && nativeId === launch.handle.id && launch.service.isCurrent() && launch.isCurrent();
    this.current = isCurrent;
    const check = () => { if (!isCurrent()) throw new Error('Native Codex frontend task changed'); };
    check();
    const retire = () => { void this.close().catch(() => { this.warn('native Codex task frontend close unconfirmed'); }); };
    launch.service.signal.addEventListener('abort', retire, { once: true });
    launch.ownerSignal?.addEventListener('abort', retire, { once: true });
    this.stopService = () => {
      launch.service.signal.removeEventListener('abort', retire);
      launch.ownerSignal?.removeEventListener('abort', retire);
    };
    // Defer factory invocation until the pending start is published. A service
    // may retire synchronously from inside the factory's first callbacks.
    this.startPromise = Promise.resolve().then(async () => {
      check();
      if (prepare) await waitForCodexNativeAttach(prepare(this.lifetime.signal), this.lifetime.signal);
      check();
      this.owner = await factory({ ...launch, isCurrent, signal: this.lifetime.signal });
      check();
      // Abort breaks this wait before close waits for startPromise: no cycle.
      await waitForCodexNativeAttach(this.owner.ready, this.lifetime.signal);
      check(); this.attached = true;
    });
    try { await this.startPromise; }
    catch (error) { await this.close(); throw error; }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = Promise.resolve().then(async () => {
      // A late factory result still belongs to us and must be retired.
      await this.startPromise?.catch(() => {});
      await this.owner?.close();
    });
    // Publish first, then revoke synchronously: abort observers may re-enter.
    this.lifetime.abort(); this.stopService?.(); this.stopService = undefined;
    return this.closePromise;
  }
}
