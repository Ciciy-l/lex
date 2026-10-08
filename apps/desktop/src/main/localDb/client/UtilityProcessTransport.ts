import type {
  DbTransport,
  DbTransportTerminationInfo,
  LogEvent,
  VecStatusEvent,
} from './DbTransport.js';

export class UtilityProcessTransport implements DbTransport {
  constructor(opts: { userId?: string } = {}) {
    void opts;
    // Escape hatch placeholder. MR1 verifies interface parity only.
  }

  send<R = unknown>(
    op: string,
    args?: unknown,
    transferList?: unknown[],
    beforeDispatch?: () => void,
  ): Promise<R> {
    void op;
    void args;
    void transferList;
    void beforeDispatch;
    throw new Error('UtilityProcessTransport is not implemented yet, escape hatch placeholder');
  }

  on(_event: 'log', _cb: (payload: LogEvent) => void): void;
  on(_event: 'vec-status', _cb: (payload: VecStatusEvent) => void): void;
  on(): void {
    throw new Error('UtilityProcessTransport is not implemented yet, escape hatch placeholder');
  }

  onTerminated(cb: (info: DbTransportTerminationInfo) => void): void {
    void cb;
    throw new Error('UtilityProcessTransport is not implemented yet, escape hatch placeholder');
  }

  close(): Promise<void> {
    throw new Error('UtilityProcessTransport is not implemented yet, escape hatch placeholder');
  }
}
