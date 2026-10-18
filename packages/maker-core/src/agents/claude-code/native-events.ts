import type { AgentEvent } from '../../types/events.js';
import { UsageTracker, type UsageSegment } from '../shared/usage-tracker.js';
import type { ClaudeBridgeEvent } from './native-bridge.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined => value && typeof value === 'object' && !Array.isArray(value)
  ? value as RecordValue : undefined;
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

interface NativeStep {
  index: number; model?: string;
  thinking: Map<number, { id: string; text: string; startedAt: number }>;
}
interface NativeTurn {
  id: string; admitted: boolean; steps: Map<number, NativeStep>; tools: Map<string, string>;
  emittedTools: Set<string>; resultTools: Set<string>; rows: Set<string>;
}

/** Semantic events only. Never reconstruct an SDK envelope or parse terminal text. */
export class ClaudeNativeEvents {
  private turn: NativeTurn | undefined;
  private sequence = 0;
  private closed = false;
  constructor(private readonly sessionId: string, private readonly emit: (event: AgentEvent) => void,
    readonly usage = new UsageTracker(), private readonly now = Date.now,
    private readonly requireAdmission = false) {}

  /** Product reservation must precede visible running/finality, even for TUI input. */
  admitTurn(turnId: string): void {
    const turn = this.turn;
    if (this.closed || !turn || turn.id !== turnId) throw new Error('Native GUI admission identity changed');
    if (turn.admitted) return;
    turn.admitted = true;
    this.usage.beginTurn();
    this.push('status', { ...this.usage.snapshot(), isRunning: true });
  }

  accept(event: ClaudeBridgeEvent): void {
    if (this.closed || event.sequence <= this.sequence) return;
    if (event.sequence !== this.sequence + 1) throw new Error('Native GUI event sequence gap');
    this.sequence = event.sequence;
    const value = record(event.value); if (!value || value.agentId !== undefined) return;
    if (event.kind === 'turn.start') {
      if (this.turn || typeof value.turnId !== 'string' || !value.turnId) throw new Error('Native GUI turn identity changed');
      this.turn = { id: value.turnId, admitted: false, steps: new Map(), tools: new Map(), emittedTools: new Set(), resultTools: new Set(), rows: new Set() };
      if (!this.requireAdmission) this.admitTurn(value.turnId);
      return;
    }
    const turn = this.turn; if (!turn) return;
    if (!turn.admitted) {
      // A refused append still has a native aborted turn. It must not finish
      // a different GUI reservation, clear its error or make the task look busy.
      if (value.turnId === turn.id && event.kind === 'turn.complete') {
        if (value.reason !== 'aborted' || value.isAborted !== true) throw new Error('Unadmitted native turn completed');
        this.turn = undefined;
      } else if (value.turnId === turn.id && ['step-start', 'chunk', 'step-result'].includes(event.kind)) {
        throw new Error('Native provider step preceded product admission');
      }
      return;
    }
    if (event.kind === 'tool.result') { this.toolResult(value); return; }
    if (event.kind === 'tool.call') { this.toolCall(value); return; }
    if (event.kind === 'session.append') { this.assistantRow(value); return; }
    if (value.turnId !== turn.id) return;
    if (event.kind === 'step-start') {
      const index = count(value.index);
      if (index === undefined || turn.steps.has(index) || turn.steps.size >= 4096) throw new Error('Invalid native GUI step');
      turn.steps.set(index, { index, model: typeof value.model === 'string' ? value.model : undefined, thinking: new Map() });
    } else if (event.kind === 'chunk') {
      const step = turn.steps.get(value.step as number), chunk = record(value.chunk);
      if (!step || !chunk) throw new Error('Native GUI chunk has no step');
      const index = count(chunk.index);
      if (chunk.kind === 'text' && typeof chunk.text === 'string' && index !== undefined) {
        this.push('text', { text: chunk.text, isFinal: false }, this.meta(step));
      } else if (chunk.kind === 'thinking' && typeof chunk.text === 'string' && index !== undefined) {
        let thinking = step.thinking.get(index);
        if (!thinking) {
          thinking = { id: `native-thinking:${turn.id}:${step.index}:${index}`, text: '', startedAt: this.now() };
          step.thinking.set(index, thinking);
          this.push('thinking', { stage: 'start', blockId: thinking.id, startedAt: thinking.startedAt }, this.meta(step));
        }
        if (thinking.text.length + chunk.text.length > 4 * 1024 * 1024) throw new Error('Native thinking exceeds GUI buffer');
        thinking.text += chunk.text;
        this.push('thinking', { stage: 'delta', blockId: thinking.id, text: chunk.text }, this.meta(step));
      } else if (chunk.kind === 'tool' && typeof chunk.id === 'string' && typeof chunk.name === 'string') {
        if (turn.tools.size >= 10_000 || (turn.tools.has(chunk.id) && turn.tools.get(chunk.id) !== chunk.name)) {
          throw new Error('Native tool identity changed');
        }
        turn.tools.set(chunk.id, chunk.name);
      } else if (chunk.kind === 'stop') {
        this.stepUsage(step, chunk.usage); this.finishThinking(step);
      }
    } else if (event.kind === 'step-result') {
      const step = turn.steps.get(value.index as number); if (!step) throw new Error('Native result has no step');
      this.stepUsage(step, value.usage); this.finishThinking(step);
    } else if (event.kind === 'turn.complete') {
      this.complete(value);
    }
  }

  private meta(step?: NativeStep, uuid?: string): RecordValue {
    return { sdkSessionId: this.sessionId, nativeTurnId: this.turn!.id,
      ...(step ? { nativeStep: step.index, ...(step.model ? { model: step.model } : {}) } : {}),
      ...(uuid ? { uuid } : {}) };
  }
  private push(type: AgentEvent['type'], data: unknown, agentMeta?: RecordValue): void {
    this.emit({ type, data, source: 'claude-code', ...(agentMeta ? { agentMeta } : {}) });
  }
  private finishThinking(step: NativeStep): void {
    for (const thinking of step.thinking.values()) this.push('thinking', { stage: 'final', blockId: thinking.id,
      text: thinking.text, durationMs: Math.max(0, this.now() - thinking.startedAt) }, this.meta(step));
    step.thinking.clear();
  }
  private stepUsage(step: NativeStep, value: unknown): void {
    const usage = nativeUsage(value); if (!usage) return;
    // This is a native step identity, not a provider message/request id. The
    // stop chunk and step result carry the same snapshot; count it only once.
    this.usage.upsertApiCallUsage(`native:${this.turn!.id}:${step.index}`, usage);
    this.push('status', { ...this.usage.snapshot(), isRunning: true });
  }
  private assistantRow(value: RecordValue): void {
    const turn = this.turn!, result = record(value.result), message = record(result?.message);
    // Native policy can refuse a tool before tool.call. The actual tool-result
    // transcript row still settles that known tool identity in the GUI.
    if (message?.type === 'user' && value.door === 'tool-result' && result?.uuid === value.uuid
      && typeof result?.uuid === 'string' && Array.isArray(message.content)) {
      for (const raw of message.content) {
        const block = record(raw);
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content)
          ? block.content.flatMap(raw => { const item = record(raw); return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []; }).join('\n')
          : undefined;
        if (text !== undefined) this.toolResult({ tool_use_id: block.tool_use_id, result: { text, isError: block.is_error === true } });
      }
      return;
    }
    if (value.agentId !== undefined || message?.type !== 'assistant') return;
    // The Mod supplies correlation only while the actual step hook is active.
    // A background transcript append cannot be assigned to the current turn.
    if (value.nativeTurnId !== turn.id) return;
    const step = turn.steps.get(value.nativeStep as number);
    if (!step || typeof result?.uuid !== 'string' || result.uuid !== value.uuid || !Array.isArray(message.content)) {
      throw new Error('Native assistant receipt identity changed');
    }
    if (turn.rows.has(result.uuid)) return;
    if (turn.rows.size >= 4096) throw new Error('Native assistant receipt limit');
    turn.rows.add(result.uuid);
    const meta = this.meta(step, result.uuid);
    for (const raw of message.content) {
      const block = record(raw); if (!block) continue;
      if (block.type === 'text' && typeof block.text === 'string') this.push('text', { text: block.text, isFinal: true }, meta);
      else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        this.emitTool(block.id, block.name, block.input, meta);
      }
    }
  }
  private emitTool(id: string, name: string, input: unknown, meta = this.meta()): void {
    const turn = this.turn!;
    if (turn.tools.size >= 10_000 || (turn.tools.has(id) && turn.tools.get(id) !== name)) throw new Error('Native tool identity changed');
    turn.tools.set(id, name);
    if (turn.emittedTools.has(id)) return;
    turn.emittedTools.add(id);
    this.push('tool_use', { toolUseId: id, toolName: name, input }, meta);
  }
  private toolCall(value: RecordValue): void {
    // A native tool.call may also originate from a plugin outside the model
    // response. Only ids already seen in a root model response belong here.
    const id = value.tool_use_id;
    if (typeof id !== 'string' || !this.turn!.tools.has(id)) return;
    if (value.tool !== this.turn!.tools.get(id)) throw new Error('Native tool identity changed');
    // Mods tool.call flattens arguments into the envelope. An argument named
    // "input" is ordinary tool data, not a wrapper (unlike tool.check).
    const { tool: _tool, tool_use_id: _id, agentId: _agent, consent: _consent, ...input } = value;
    this.emitTool(id, this.turn!.tools.get(id)!, input);
  }
  private toolResult(value: RecordValue): void {
    const turn = this.turn!, id = value.tool_use_id, result = record(value.result);
    if (typeof id !== 'string' || !turn.emittedTools.has(id) || turn.resultTools.has(id) || !result) return;
    const fullText = typeof result.text === 'string' ? result.text : typeof result.deny === 'string' ? result.deny : undefined;
    if (fullText === undefined) return; // No invented model text from an opaque typed result.
    turn.resultTools.add(id);
    this.push('tool_result_full', { toolUseId: id, fullText, isError: result.isError === true || typeof result.deny === 'string' }, this.meta());
  }
  private complete(value: RecordValue): void {
    const turn = this.turn!;
    if (!['answer', 'aborted', 'refusal', 'error'].includes(value.reason as string)
      || (value.reason === 'aborted') !== (value.isAborted === true)) throw new Error('Invalid native turn terminal');
    for (const step of turn.steps.values()) this.finishThinking(step);
    const aggregate = nativeUsage(value.usage), segments = this.usage.getTurnUsageSegments();
    const snapshot = this.usage.endTurn(aggregate);
    const failed = value.reason === 'error' || value.reason === 'refusal';
    if (failed) this.push('error', { message: '任务执行失败（模型未返回错误详情）。', isTerminal: true, reason: 'turn-failed' });
    this.push('status', { ...snapshot, isRunning: false });
    this.push('done', { result: typeof value.answer === 'string' ? value.answer : '', is_error: failed,
      ...(value.isAborted === true ? { silentStop: true } : {}), nativeTurnId: turn.id,
      duration_ms: count(value.durationMs), usage: record(value.usage), usageSegments: segments,
      // Mods does not expose per-request ids or retry/fork accounting. Never
      // call these segments a complete billing ledger merely because sums match.
      usageSegmentsComplete: false,
    });
    this.turn = undefined;
  }
  close(): void { this.closed = true; this.turn = undefined; }
}

function nativeUsage(value: unknown): UsageSegment | undefined {
  const raw = record(value); if (!raw) return;
  const inputTokens = count(raw.input_tokens), outputTokens = count(raw.output_tokens);
  const cacheReadTokens = count(raw.cache_read_input_tokens), cacheCreateTokens = count(raw.cache_creation_input_tokens);
  if (inputTokens === undefined || outputTokens === undefined || cacheReadTokens === undefined || cacheCreateTokens === undefined) return;
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens,
    ...(typeof raw.model === 'string' ? { model: raw.model } : {}) };
}
