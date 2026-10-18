import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import type { Terminal as BrowserTerminal } from '@xterm/xterm';
import type { AgentTerminalDriver } from '@cindy/maker-core';
import type { IPty } from 'node-pty';
import { defaultPtySpawn, type PtySpawnFn } from './ptyFactory.js';
import { TerminalEscapeTail } from './terminalEscapeTail.js';

/** Host-created launch spec. Never accept one over the presentation IPC. */
export interface AgentTerminalLaunch {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
}
type Size = { cols: number; rows: number };
type Exit = { code: number | null; signal?: string };
type Operation = { data: string } | { size: Size } | { exit: Exit };

/**
 * The task owns both its PTY and a headless xterm. Screens and query responses
 * remain available without a renderer; observers never answer terminal queries.
 * This is transport only: native structured events remain the message authority.
 */
export class AgentTerminalPtyDriver implements AgentTerminalDriver {
  readonly pid: number;
  private readonly pty: IPty;
  private readonly screen: Terminal;
  private readonly serializer = new SerializeAddon();
  private readonly escapeTail = new TerminalEscapeTail();
  private readonly dataListeners = new Set<(data: string, size: Size) => void>();
  private readonly exitListeners = new Set<(exit: Exit) => void>();
  private readonly operations: Operation[] = [];
  private readonly subscriptions: Array<{ dispose(): void }> = [];
  private busy = false;
  private closed = false;
  private exited = false;
  private paused = false;
  private queuedBytes = 0;
  private lastExit?: Exit;
  private resolveExit!: () => void;
  private readonly exitPromise = new Promise<void>((resolve) => { this.resolveExit = resolve; });
  private closing?: Promise<void>;

  constructor(spec: AgentTerminalLaunch, spawn: PtySpawnFn = defaultPtySpawn) {
    const cols = spec.cols ?? 120, rows = spec.rows ?? 36;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 1000 || rows > 1000) {
      throw new Error('Invalid native terminal dimensions');
    }
    this.screen = new Terminal({ cols, rows, scrollback: 500, allowProposedApi: true });
    // SerializeAddon uses the common buffer API, supported by headless xterm.
    // Its public type names browser Terminal, although no DOM methods are used.
    this.serializer.activate(this.screen as unknown as BrowserTerminal);
    try {
      this.pty = spawn(spec.executable, [...spec.args], {
        name: 'xterm-256color', cols, rows, cwd: spec.cwd, env: { ...spec.env },
      });
    } catch (error) { this.serializer.dispose(); this.screen.dispose(); throw error; }
    this.pid = this.pty.pid;
    this.subscriptions.push(
      this.screen.onData((data) => { if (!this.closed && !this.exited) this.pty.write(data); }),
      this.pty.onData((data) => {
        if (this.closed || this.exited || !data) return;
        this.queuedBytes += Buffer.byteLength(data);
        this.operations.push({ data });
        if (!this.paused && this.queuedBytes >= 262_144) { this.paused = true; this.pty.pause(); }
        this.drain();
      }),
      this.pty.onExit(({ exitCode, signal }) => {
        this.exited = true;
        this.resolveExit();
        this.operations.push({ exit: { code: exitCode, ...(signal ? { signal: String(signal) } : {}) } });
        this.drain();
      }),
    );
  }

  write(data: string): void {
    if (this.closed || this.exited) throw new Error('Native terminal exited');
    this.pty.write(data);
  }
  resize(cols: number, rows: number): void {
    if (this.closed || this.exited) throw new Error('Native terminal exited');
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 1000 || rows > 1000) {
      throw new Error('Invalid native terminal dimensions');
    }
    // Coalesce queued resizes, never reorder them across native output.
    const last = this.operations.at(-1);
    if (last && 'size' in last) last.size = { cols, rows };
    else this.operations.push({ size: { cols, rows } });
    this.drain();
  }
  onData(listener: (data: string, size: Size) => void): () => void {
    this.dataListeners.add(listener); return () => { this.dataListeners.delete(listener); };
  }
  onExit(listener: (exit: Exit) => void): () => void {
    this.exitListeners.add(listener);
    if (this.lastExit) queueMicrotask(() => { if (!this.closed && this.exitListeners.has(listener)) listener({ ...this.lastExit! }); });
    return () => { this.exitListeners.delete(listener); };
  }
  snapshot(): { data: string; cols: number; rows: number } {
    if (this.closed) throw new Error('Native terminal closed');
    // Retain the full visible screen; trim only older scrollback to fit a frame.
    for (const scrollback of [500, 100, 0]) {
      const data = this.serializer.serialize({ scrollback }) + this.escapeTail.pending();
      if (Buffer.byteLength(JSON.stringify(data)) <= 1_048_576) {
        return { data, cols: this.screen.cols, rows: this.screen.rows };
      }
    }
    throw new Error('Native terminal screen exceeds the recovery limit');
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.operations.length = 0; this.dataListeners.clear(); this.exitListeners.clear();
    this.serializer.dispose(); this.screen.dispose();
    this.closing = Promise.resolve().then(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.exitPromise, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Native terminal exit unconfirmed')), 5_000); timer.unref();
        })]);
      } finally { clearTimeout(timer); for (const sub of this.subscriptions) sub.dispose(); }
    });
    try { if (!this.exited) this.pty.kill(); }
    catch { /* Wait for the authoritative exit event; never infer death from kill. */ }
    return this.closing;
  }

  private drain(): void {
    if (this.closed || this.busy) return;
    const op = this.operations.shift();
    if (!op) return;
    if ('data' in op) {
      this.busy = true;
      this.screen.write(op.data, () => {
        if (this.closed) return;
        this.escapeTail.accept(op.data);
        this.queuedBytes -= Buffer.byteLength(op.data);
        this.deliver(op.data);
        this.busy = false;
        if (this.paused && this.queuedBytes < 65_536 && !this.exited) { this.paused = false; this.pty.resume(); }
        this.drain();
      });
    } else if ('size' in op) {
      this.screen.resize(op.size.cols, op.size.rows);
      if (!this.exited) this.pty.resize(op.size.cols, op.size.rows);
      this.deliver(''); this.drain();
    } else {
      this.lastExit = op.exit;
      for (const listener of this.exitListeners) { try { listener({ ...op.exit }); } catch { /* Isolate dead views. */ } }
    }
  }
  private deliver(data: string): void {
    for (const listener of this.dataListeners) {
      try { listener(data, { cols: this.screen.cols, rows: this.screen.rows }); } catch { /* Isolate dead views. */ }
    }
  }
}
