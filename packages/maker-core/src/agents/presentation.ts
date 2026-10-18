import { randomUUID } from 'node:crypto';

/** Native UI transport owned by a task, never by a renderer or a tab. */
export interface AgentTerminalDriver {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(listener: (data: string, size?: { cols: number; rows: number }) => void): () => void;
  onExit(listener: (exit: { code: number | null; signal?: string }) => void): () => void;
  /** Parsed screen at the last delivered output, including native terminal modes. */
  snapshot?(): { data: string; cols: number; rows: number };
  close(): void | Promise<void>;
}

export interface AgentTerminalFrame {
  sequence: number;
  data: string;
  size?: { cols: number; rows: number };
}

export interface AgentPresentationState {
  generation: string;
  nativeSessionId: string;
  status: 'running' | 'exited' | 'closed';
  controller: string | null;
  cols: number;
  rows: number;
  sequence: number;
  exit?: { code: number | null; signal?: string };
}

export interface AgentTerminalReplay {
  state: AgentPresentationState;
  frames: readonly AgentTerminalFrame[];
  /** This exact attachment owns input, not merely another view of the same peer. */
  controlling: boolean;
  /** A screen snapshot is required. Never render a truncated ANSI tail as a full screen. */
  gap: boolean;
  /** Replaces a missing prefix; restore at these dimensions before later frames. */
  snapshot?: { sequence: number; data: string; cols: number; rows: number };
}

export interface AgentTerminalControl {
  generation: string;
  lease: string;
}

/** Host-only facade. The host authorizes the peer before giving it an attachment. */
export interface AgentPresentationAttachment {
  read(afterSequence?: number): AgentTerminalReplay;
  acquireControl(takeOver?: boolean): AgentTerminalControl | null;
  releaseControl(control: AgentTerminalControl): void;
  write(control: AgentTerminalControl, sequence: number, data: string): void;
  resize(control: AgentTerminalControl, cols: number, rows: number): void;
  detach(): void;
}

export interface AgentSessionPresentation {
  state(): AgentPresentationState;
  attach(peerId: string, notify: () => void): AgentPresentationAttachment;
}

/**
 * One native runtime, independently attached views and one raw-input writer.
 * Semantic sends/approvals still belong to AgentSessionHandle. This class does
 * not interpret ANSI, launch processes, authorize peers or synthesize messages.
 */
export class AgentPresentationRuntime implements AgentSessionPresentation {
  private readonly generation = randomUUID();
  private readonly attachments = new Map<string, { peerId: string; notify: () => void }>();
  private controller: { attachmentId: string; lease: string; inputSequence: number } | null = null;
  private readonly frames: AgentTerminalFrame[] = [];
  private bytes = 0;
  private sequence = 0;
  private status: AgentPresentationState['status'] = 'running';
  private exit?: AgentPresentationState['exit'];
  private cols: number;
  private rows: number;
  private readonly maxReplayBytes: number;
  private readonly stopData: () => void;
  private readonly stopExit: () => void;
  private closePromise?: Promise<void>;

  constructor(
    private readonly nativeSessionId: string,
    private readonly driver: AgentTerminalDriver,
    options: { cols?: number; rows?: number; maxReplayBytes?: number } = {},
  ) {
    if (!nativeSessionId) throw new Error('Native session identity is required');
    this.cols = options.cols ?? 120;
    this.rows = options.rows ?? 36;
    validateSize(this.cols, this.rows);
    if (!Number.isSafeInteger(options.maxReplayBytes ?? 1_048_576) || (options.maxReplayBytes ?? 1_048_576) < 1) {
      throw new Error('Invalid terminal replay limit');
    }
    this.maxReplayBytes = options.maxReplayBytes ?? 1_048_576;
    this.stopData = driver.onData((data, size) => this.append(data, size));
    this.stopExit = driver.onExit((exit) => {
      if (this.status !== 'running') return;
      this.status = 'exited';
      this.exit = { ...exit };
      this.controller = null;
      this.notify();
    });
  }

  state(): AgentPresentationState {
    const controller = this.controller && this.attachments.get(this.controller.attachmentId);
    return { generation: this.generation, nativeSessionId: this.nativeSessionId,
      status: this.status, controller: controller?.peerId ?? null, cols: this.cols, rows: this.rows,
      sequence: this.sequence, ...(this.exit ? { exit: { ...this.exit } } : {}) };
  }

  attach(peerId: string, notify: () => void): AgentPresentationAttachment {
    if (!peerId || this.status === 'closed') throw new Error('Terminal attachment unavailable');
    const id = randomUUID();
    this.attachments.set(id, { peerId, notify });
    const attached = () => {
      if (!this.attachments.has(id) || this.status === 'closed') throw new Error('Terminal attachment expired');
    };
    const controls = (control: AgentTerminalControl) => {
      attached();
      if (this.status !== 'running' || control.generation !== this.generation
        || this.controller?.attachmentId !== id || this.controller.lease !== control.lease) {
        throw new Error('Terminal control expired');
      }
      return this.controller;
    };
    return {
      read: (afterSequence = 0) => {
        attached();
        if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || afterSequence > this.sequence) {
          throw new Error('Invalid terminal output cursor');
        }
        const gap = afterSequence < (this.frames[0]?.sequence ?? this.sequence + 1) - 1;
        const screen = gap ? this.driver.snapshot?.() : undefined;
        if (screen) {
          return { state: this.state(), controlling: this.controller?.attachmentId === id, frames: [], gap: false,
            snapshot: { ...screen, sequence: this.sequence } };
        }
        // Page output, including JSON escaping, below the legacy Device Link frame limit.
        const frames: AgentTerminalFrame[] = [];
        let bytes = 0;
        for (const frame of this.frames) {
          if (frame.sequence <= afterSequence) continue;
          const size = Buffer.byteLength(JSON.stringify(frame));
          if (frames.length && bytes + size > 262_144) break;
          frames.push({ ...frame, ...(frame.size ? { size: { ...frame.size } } : {}) });
          bytes += size;
        }
        return { state: this.state(), controlling: this.controller?.attachmentId === id, frames, gap };
      },
      acquireControl: (takeOver = false) => {
        attached();
        if (this.status !== 'running') return null;
        if (this.controller?.attachmentId === id) {
          return { generation: this.generation, lease: this.controller.lease };
        }
        if (this.controller && !takeOver) return null;
        this.controller = { attachmentId: id, lease: randomUUID(), inputSequence: 0 };
        const result = { generation: this.generation, lease: this.controller.lease };
        this.notify();
        return result;
      },
      releaseControl: (control) => {
        controls(control);
        this.controller = null;
        this.notify();
      },
      write: (control, sequence, data) => {
        const owner = controls(control);
        if (!Number.isSafeInteger(sequence) || sequence !== owner.inputSequence + 1) {
          throw new Error('Terminal input sequence mismatch');
        }
        if (typeof data !== 'string' || Buffer.byteLength(data) > 65_536) throw new Error('Terminal input too large');
        // Claim before dispatch: an error does not prove the native write did not happen.
        owner.inputSequence = sequence;
        this.driver.write(data);
      },
      resize: (control, cols, rows) => {
        controls(control);
        validateSize(cols, rows);
        this.driver.resize(cols, rows);
        this.cols = cols;
        this.rows = rows;
        this.notify();
      },
      detach: () => {
        if (!this.attachments.delete(id)) return;
        if (this.controller?.attachmentId === id) {
          this.controller = null;
          this.notify();
        }
        // No driver.close(): presentation lifetime never owns the task.
      },
    };
  }

  /** Only the owning task may close its driver; never expose this through a view handle. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.status = 'closed';
    this.controller = null;
    this.stopData();
    this.stopExit();
    // Install the promise before notifications, which may reenter close().
    this.closePromise = Promise.resolve().then(() => this.driver.close());
    this.notify();
    this.attachments.clear();
    this.frames.length = 0;
    this.bytes = 0;
    return this.closePromise;
  }

  private append(data: string, size?: { cols: number; rows: number }): void {
    if (this.status !== 'running' || (!data && !size)) return;
    if (size) { this.cols = size.cols; this.rows = size.rows; }
    // Drivers bound frames; retain streaming parser state between pieces. Avoid
    // splitting surrogate pairs, but ANSI sequences may cross frame boundaries.
    for (let offset = 0; offset < data.length || (offset === 0 && !data);) {
      let end = Math.min(offset + 16_384, data.length);
      const last = data.charCodeAt(end - 1);
      if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
      const part = data.slice(offset, end);
      this.frames.push({ sequence: ++this.sequence, data: part, ...(size ? { size: { ...size } } : {}) });
      this.bytes += Buffer.byteLength(part);
      offset = end;
      if (!data) break;
    }
    // Drop whole frames, never split UTF-8, a surrogate pair or an ANSI sequence.
    while ((this.bytes > this.maxReplayBytes || this.frames.length > 4096) && this.frames.length) {
      this.bytes -= Buffer.byteLength(this.frames.shift()!.data);
    }
    this.notify();
  }

  private notify(): void {
    for (const { notify } of [...this.attachments.values()]) {
      try { notify(); } catch { /* One dead observer cannot break a native turn or another peer. */ }
    }
  }
}

function validateSize(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 1000 || rows > 1000) {
    throw new Error('Invalid terminal dimensions');
  }
}
