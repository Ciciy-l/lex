import type { DynamicToolCallParams, DynamicToolCallResponse } from './app-server/protocol.js';

type Id = string | number;
export type CodexNativeToolEvent =
  | { kind: 'request'; request: { id: Id; method: 'item/tool/call'; params: DynamicToolCallParams } }
  | { kind: 'resolved'; id: Id; threadId: string };
export interface CodexNativeToolFrontend {
  ready(): void;
  answer(id: Id, response: unknown): boolean;
  detach(): void;
}
interface Frontend { receive(event: CodexNativeToolEvent): Promise<boolean>; ready: boolean }
interface Pending {
  frontend: Frontend;
  request: Extract<CodexNativeToolEvent, { kind: 'request' }>['request'];
  resolve(response: DynamicToolCallResponse): void;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function failure(text: string): DynamicToolCallResponse {
  return { success: false, contentItems: [{ type: 'inputText', text }] };
}
function response(value: unknown): value is DynamicToolCallResponse {
  return record(value) && typeof value.success === 'boolean' && Array.isArray(value.contentItems)
    && value.contentItems.every(item => record(item) &&
      (item.type === 'inputText' && typeof item.text === 'string'
        || item.type === 'inputImage' && typeof item.imageUrl === 'string'));
}

/** The original TUI executes an admitted dynamic tool once. Core alone answers
 * app-server. Unlike human prompts, side effects are never broadcast or replayed. */
export class CodexNativeDynamicTools {
  private readonly tools = new Set<string>();
  private readonly frontends = new Set<Frontend>();
  private readonly pending = new Map<Id, Pending>();
  private closed = false;
  constructor(private readonly isCurrent: () => boolean) {}

  register(specs: unknown): void {
    if (specs == null) return;
    if (!Array.isArray(specs) || this.closed) throw new Error('Invalid native dynamic tool declarations');
    const keys = new Set<string>();
    for (const spec of specs) {
      // This is the official external TUI executor's namespace. Its MCP
      // transport (including delegation/worktrees) remains entirely original.
      if (!record(spec) || spec.type !== 'namespace' || spec.name !== 'codex_tui') continue;
      if (!Array.isArray(spec.tools)) throw new Error('Invalid native dynamic tool namespace');
      for (const tool of spec.tools) {
        if (!record(tool) || tool.type !== 'function' || typeof tool.name !== 'string' || !tool.name) {
          throw new Error('Invalid native dynamic tool');
        }
        const key = spec.name + '\u0000' + tool.name;
        if (keys.has(key)) throw new Error('Conflicting native dynamic tool');
        keys.add(key);
      }
    }
    this.tools.clear();
    for (const key of keys) this.tools.add(key);
  }
  supports(params: Pick<DynamicToolCallParams, 'namespace' | 'tool'>): boolean {
    return !this.closed && this.isCurrent() && this.tools.has((params.namespace ?? '') + '\u0000' + params.tool);
  }
  execute(id: Id, params: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    if (!this.supports(params)) return Promise.resolve(failure('Native dynamic tool is not registered for this task.'));
    const frontend = [...this.frontends].reverse().find(value => value.ready);
    if (!frontend || this.pending.has(id) || this.pending.size >= 128) {
      return Promise.resolve(failure('Native dynamic tool executor is unavailable.'));
    }
    const request = { id, method: 'item/tool/call' as const, params: structuredClone(params) };
    return new Promise(resolve => {
      const entry = { frontend, request, resolve };
      this.pending.set(id, entry);
      // Publish pending ownership before any synchronous callback can answer.
      void Promise.resolve().then(() => {
        if (this.pending.get(id) !== entry) return true;
        if (!this.isCurrent()) return false;
        return frontend.receive({ kind: 'request', request });
      }).then(delivered => {
        if (!delivered) this.finish(entry, failure('Native tool dispatch is unconfirmed; it will not be replayed.'));
      }, () => this.finish(entry, failure('Native tool dispatch is unconfirmed; it will not be replayed.')));
    });
  }
  cancel(id: Id, threadId: string): void {
    const entry = this.pending.get(id);
    if (!entry || entry.request.params.threadId !== threadId) return;
    this.finish(entry, failure('Native tool execution was cancelled.'));
    void Promise.resolve().then(() => entry.frontend.receive({ kind: 'resolved', id, threadId })).catch(() => {});
  }
  attach(receive: Frontend['receive']): CodexNativeToolFrontend {
    if (this.closed || !this.isCurrent() || this.frontends.size >= 128) throw new Error('Native tool owner is unavailable');
    const frontend: Frontend = { receive, ready: false };
    this.frontends.add(frontend);
    return {
      ready: () => { if (!this.closed && this.isCurrent() && this.frontends.has(frontend)) frontend.ready = true; },
      answer: (id, value) => {
        const entry = this.pending.get(id);
        if (this.closed || !this.isCurrent() || !entry || entry.frontend !== frontend) return false;
        this.finish(entry, response(value) ? structuredClone(value) : failure('Native tool returned an invalid response.'));
        return true;
      },
      detach: () => {
        this.frontends.delete(frontend);
        for (const entry of [...this.pending.values()]) {
          if (entry.frontend === frontend) this.finish(entry, failure('Native tool executor disconnected; execution will not be replayed.'));
        }
      },
    };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of [...this.pending.values()]) this.cancel(entry.request.id, entry.request.params.threadId);
    this.frontends.clear(); this.tools.clear();
  }
  private finish(entry: Pending, result: DynamicToolCallResponse): void {
    if (this.pending.get(entry.request.id) !== entry) return;
    this.pending.delete(entry.request.id); entry.resolve(result);
  }
}
