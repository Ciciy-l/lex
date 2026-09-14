import { OmpCommandCatalog, isOmpRecord, type OmpCatalogSnapshot } from './commands.js';
import { type OmpRpcClient } from './rpc-client.js';

/** A narrow, no-prompt view of a freshly isolated OMP RPC connection. */
export type OmpProbeStatus = 'idle' | 'probing' | 'ready' | 'failed' | 'closed';

/**
 * The probe deliberately projects no session state or raw diagnostic text.
 * Command metadata is the only native surface needed by the future slash menu.
 */
export interface OmpProbeSnapshot {
  readonly status: OmpProbeStatus;
  readonly commands: OmpCatalogSnapshot;
  readonly stateAvailable: boolean;
  readonly failure?:
    | 'invalid_command_catalog'
    | 'invalid_session_state'
    | 'probe_request_failed'
    | 'unexpected_interaction';
}

export interface OmpProbeControllerOptions {
  /** The already-connected RPC client owned by the isolated process host. */
  client: OmpRpcClient;
  /** Called with safe, immutable snapshots; callback faults never escape RPC. */
  onSnapshot?(snapshot: OmpProbeSnapshot): void;
  /** Bounded RPC request timeout; defaults to fifteen seconds. */
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_TIMEOUT_MS = 30_000;

function frozenSnapshot(
  status: OmpProbeStatus,
  commands: OmpCatalogSnapshot,
  stateAvailable: boolean,
  failure?: OmpProbeSnapshot['failure'],
): OmpProbeSnapshot {
  return Object.freeze({
    status,
    commands,
    stateAvailable,
    ...(failure === undefined ? {} : { failure }),
  });
}

function commandList(data: unknown): unknown {
  if (!isOmpRecord(data) || !('commands' in data)) throw new Error('Invalid OMP command catalog');
  return data.commands;
}

function isMinimalSessionState(data: unknown): boolean {
  return (
    isOmpRecord(data) &&
    typeof data.sessionId === 'string' &&
    data.sessionId.length > 0 &&
    data.sessionId.length <= 256 &&
    !data.sessionId.includes('\0')
  );
}

/**
 * Coordinates the first RPC-only capability read after a process host has
 * verified its `ready` frame. It can issue only `get_available_commands` and
 * `get_state`: no prompt, host tool, UI response, or native approval is ever
 * synthesized here. A native interaction arriving during this phase closes the
 * client rather than being mistaken for a Lex permission decision.
 */
export class OmpProbeController {
  private readonly catalog = new OmpCommandCatalog();
  private readonly requestTimeoutMs: number;
  private snapshot: OmpProbeSnapshot;
  private startPromise: Promise<OmpProbeSnapshot> | undefined;

  constructor(private readonly options: OmpProbeControllerOptions) {
    if (!options || typeof options !== 'object' || !options.client)
      throw new Error('OMP probe requires an RPC client');
    const timeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_REQUEST_TIMEOUT_MS) {
      throw new Error('Invalid OMP probe timeout');
    }
    this.requestTimeoutMs = timeout;
    this.snapshot = frozenSnapshot('idle', this.catalog.getSnapshot(), false);
  }

  getSnapshot(): OmpProbeSnapshot {
    return this.snapshot;
  }

  /**
   * Read the two capability endpoints once. The caller invokes this only after
   * the process host accepted protocol v1's ready frame.
   */
  start(): Promise<OmpProbeSnapshot> {
    if (this.startPromise) return this.startPromise;
    if (this.snapshot.status !== 'idle') return Promise.resolve(this.snapshot);

    const catalogTicket = this.catalog.beginRead();
    this.publish('probing', false);
    if (!this.isProbing()) {
      this.startPromise = Promise.resolve(this.snapshot);
      return this.startPromise;
    }

    let commands: ReturnType<OmpRpcClient['request']>;
    try {
      commands = this.options.client.request(
        { type: 'get_available_commands' },
        this.requestTimeoutMs,
      );
    } catch {
      this.startPromise = Promise.resolve(this.fail('probe_request_failed'));
      return this.startPromise;
    }

    // Attach a rejection handler before attempting the next request. A
    // synchronous transport failure closes OmpRpcClient and rejects this
    // response before the following request can throw for the closed client.
    const commandResult = commands.response.then(
      (response) => ({ response }),
      () => ({ response: undefined }),
    );
    if (!this.isProbing()) {
      this.startPromise = commandResult.then(() => this.snapshot);
      return this.startPromise;
    }

    let state: ReturnType<OmpRpcClient['request']>;
    try {
      state = this.options.client.request({ type: 'get_state' }, this.requestTimeoutMs);
    } catch {
      this.startPromise = commandResult.then(() =>
        this.snapshot.status === 'closed' ? this.snapshot : this.fail('probe_request_failed'),
      );
      return this.startPromise;
    }

    const stateResult = state.response.then(
      (response) => ({ response }),
      () => ({ response: undefined }),
    );
    this.startPromise = Promise.all([commandResult, stateResult]).then(([commands, state]) => {
      if (!this.isProbing()) return this.snapshot;
      if (!commands.response || !state.response) return this.fail('probe_request_failed');
      try {
        this.catalog.completeRead(catalogTicket, commandList(commands.response.data));
      } catch {
        return this.fail('invalid_command_catalog');
      }
      if (!isMinimalSessionState(state.response.data)) return this.fail('invalid_session_state');
      this.publish('ready', true);
      return this.snapshot;
    });
    return this.startPromise;
  }

  /**
   * Feed only stdout events received by the process host. Command pushes are
   * applied atomically; generic native interaction requests are intentionally
   * not translated into Lex approval and close the isolated connection.
   */
  observe(event: Readonly<Record<string, unknown>>): void {
    if (
      this.snapshot.status === 'failed' ||
      this.snapshot.status === 'closed' ||
      typeof event.type !== 'string'
    ) {
      return;
    }
    if (event.type === 'available_commands_update') {
      try {
        this.catalog.replace(commandList(event));
        this.publish(this.snapshot.status, this.snapshot.stateAvailable);
      } catch {
        this.fail('invalid_command_catalog');
      }
      return;
    }
    if (
      event.type === 'extension_ui_request' ||
      event.type === 'host_tool_call' ||
      event.type === 'host_tool_cancel' ||
      event.type === 'host_uri_request' ||
      event.type === 'host_uri_cancel'
    ) {
      this.fail('unexpected_interaction');
    }
  }

  /** Close the isolated connection without treating it as a completed probe. */
  close(): void {
    if (this.snapshot.status === 'closed' || this.snapshot.status === 'failed') {
      return;
    }
    this.options.client.close();
    this.publish('closed', this.snapshot.stateAvailable);
  }

  private fail(failure: NonNullable<OmpProbeSnapshot['failure']>): OmpProbeSnapshot {
    if (this.snapshot.status === 'failed') return this.snapshot;
    this.catalog.invalidate('failed');
    this.options.client.close();
    this.publish('failed', false, failure);
    return this.snapshot;
  }

  private publish(
    status: OmpProbeStatus,
    stateAvailable: boolean,
    failure?: OmpProbeSnapshot['failure'],
  ): void {
    this.snapshot = frozenSnapshot(status, this.catalog.getSnapshot(), stateAvailable, failure);
    try {
      this.options.onSnapshot?.(this.snapshot);
    } catch {
      // Projection observers are never allowed to destabilize the wire client.
    }
  }

  private isProbing(): boolean {
    return this.snapshot.status === 'probing';
  }
}
