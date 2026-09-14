import { isOmpRecord } from './commands.js';
import { OMP_MAX_FRAME_BYTES } from './jsonl-reader.js';

export interface OmpRpcTransport {
  writeLine(line: string): void;
  onLine(listener: (line: string) => void): () => void;
  onClose(listener: () => void): () => void;
}

export type OmpRpcRequest =
  | { type: 'get_available_commands' | 'get_state' | 'abort' }
  | { type: 'prompt'; message: string };

export interface OmpRpcResponse {
  type: 'response';
  id: string;
  command: OmpRpcRequest['type'];
  success: true;
  data?: unknown;
}

export type OmpUiResponse =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true; timedOut?: boolean };

interface PendingRequest {
  command: OmpRpcRequest['type'];
  resolve: (response: OmpRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const MAX_PENDING_REQUESTS = 64;
const REQUEST_TYPES = new Set([
  'get_available_commands',
  'get_state',
  'abort',
  'prompt',
]);

export class OmpRpcClient {
  private sequence = 0;
  private closed = false;
  private acceptingRequests = true;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly prompts = new Set<string>();
  private readonly unsubscribe: (() => void)[] = [];

  constructor(
    private readonly transport: OmpRpcTransport,
    private readonly onEvent: (
      event: Readonly<Record<string, unknown>>,
    ) => void,
    private readonly onClosed: () => void,
  ) {
    try {
      this.registerCleanup(transport.onLine((line) => this.receive(line)));
      if (!this.closed)
        this.registerCleanup(transport.onClose(() => this.close()));
    } catch {
      this.close();
    }
  }

  request(
    command: OmpRpcRequest,
    timeoutMs = 30_000,
  ): { id: string; response: Promise<OmpRpcResponse> } {
    if (this.closed) throw new Error('OMP RPC is closed');
    if (!this.acceptingRequests) throw new Error('OMP RPC is draining');
    if (
      !isOmpRecord(command) ||
      !REQUEST_TYPES.has(command.type) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 600_000
    ) {
      throw new Error('Invalid OMP RPC request');
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS)
      throw new Error('OMP RPC request limit reached');
    if (command.type === 'prompt' && this.prompts.size >= MAX_PENDING_REQUESTS)
      throw new Error('OMP unresolved prompt limit reached');
    if (command.type === 'prompt' && typeof command.message !== 'string')
      throw new Error('Invalid OMP prompt');
    const id = 'omp-' + ++this.sequence;
    const payload =
      command.type === 'prompt'
        ? { type: command.type, message: command.message, id }
        : { type: command.type, id };
    const line = this.encode(payload);
    if (command.type === 'prompt') this.prompts.add(id);
    const response = new Promise<OmpRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error('OMP RPC request timed out; execution outcome is unknown'),
        );
      }, timeoutMs);
      this.pending.set(id, { command: command.type, resolve, reject, timer });
      try {
        this.transport.writeLine(line);
      } catch {
        this.close();
      }
    });
    return { id, response };
  }

  respondToUi(id: string, response: OmpUiResponse): void {
    if (this.closed) throw new Error('OMP RPC is closed');
    if (!this.acceptingRequests) throw new Error('OMP RPC is draining');
    if (
      typeof id !== 'string' ||
      !id ||
      id.length > 256 ||
      Array.from(id).some((char) => char.charCodeAt(0) < 32)
    ) {
      throw new Error('Invalid OMP interaction identity');
    }
    if (!isOmpRecord(response))
      throw new Error('Invalid OMP interaction response');
    const variants = ['value', 'confirmed', 'cancelled'].filter(
      (key) => key in response,
    );
    if (variants.length !== 1)
      throw new Error('Invalid OMP interaction response');
    const allowedKeys =
      variants[0] === 'cancelled' ? ['cancelled', 'timedOut'] : variants;
    if (Object.keys(response).some((key) => !allowedKeys.includes(key))) {
      throw new Error('Invalid OMP interaction response');
    }
    let payload: Record<string, unknown>;
    if ('cancelled' in response && response.cancelled === true) {
      if (
        response.timedOut !== undefined &&
        typeof response.timedOut !== 'boolean'
      ) {
        throw new Error('Invalid OMP interaction response');
      }
      payload = {
        cancelled: true,
        ...(response.timedOut === true ? { timedOut: true } : {}),
      };
    } else if ('value' in response && typeof response.value === 'string') {
      payload = { value: response.value };
    } else if (
      'confirmed' in response &&
      typeof response.confirmed === 'boolean'
    ) {
      payload = { confirmed: response.confirmed };
    } else {
      throw new Error('Invalid OMP interaction response');
    }
    const line = this.encode({ ...payload, type: 'extension_ui_response', id });
    try {
      this.transport.writeLine(line);
    } catch {
      this.close();
      throw new Error('OMP interaction transport failed');
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('OMP RPC closed; execution outcome is unknown'));
    }
    this.pending.clear();
    this.prompts.clear();
    for (const unsubscribe of this.unsubscribe.splice(0))
      this.cleanup(unsubscribe);
    this.cleanup(this.onClosed);
  }

  releasePrompt(id: string): void {
    this.prompts.delete(id);
  }

  stopAcceptingRequests(): void {
    this.acceptingRequests = false;
  }

  private cleanup(callback: () => void): void {
    try {
      callback();
    } catch {
      return;
    }
  }

  private registerCleanup(callback: () => void): void {
    if (this.closed) this.cleanup(callback);
    else this.unsubscribe.push(callback);
  }

  private emit(event: Readonly<Record<string, unknown>>): void {
    try {
      this.onEvent(event);
    } catch {
      this.close();
    }
  }

  private encode(payload: Record<string, unknown>): string {
    const line = JSON.stringify(payload);
    if (Buffer.byteLength(line, 'utf8') > OMP_MAX_FRAME_BYTES)
      throw new Error('OMP RPC frame exceeds limit');
    return line;
  }

  private receive(line: string): void {
    if (this.closed) return;
    if (Buffer.byteLength(line, 'utf8') > OMP_MAX_FRAME_BYTES) {
      this.close();
      return;
    }
    if (!line.trim()) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      this.close();
      return;
    }
    if (!isOmpRecord(event) || typeof event.type !== 'string') {
      this.close();
      return;
    }
    if (event.type === 'rpc_chunk') {
      this.close();
      return;
    }
    if (event.type !== 'response') {
      this.emit(event);
      return;
    }
    if (typeof event.id !== 'string') return;
    const pending = this.pending.get(event.id);
    if (!pending) {
      if (!this.prompts.has(event.id)) return;
      if (event.command !== 'prompt' || typeof event.success !== 'boolean') {
        this.close();
        return;
      }
      if (!event.success) {
        this.prompts.delete(event.id);
        this.emit({
          type: 'omp_prompt_failure',
          id: event.id,
          command: 'prompt',
          message: 'OMP prompt execution failed',
        });
      }
      return;
    }
    if (
      event.command !== pending.command ||
      typeof event.success !== 'boolean'
    ) {
      this.close();
      return;
    }
    this.pending.delete(event.id);
    clearTimeout(pending.timer);
    if (!event.success) {
      this.prompts.delete(event.id);
      pending.reject(new Error('OMP RPC command failed'));
    } else
      pending.resolve({
        type: 'response',
        id: event.id,
        command: pending.command,
        success: true,
        data: event.data,
      });
  }
}
