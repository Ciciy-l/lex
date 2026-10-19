import type { Effort } from '../../types/common.js';
import type { AgentNativeRuntimePatch, AgentNativeRuntimeResolver } from '../native-runtime.js';

export type CodexNativeRuntimePatch = AgentNativeRuntimePatch;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const efforts = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
function model(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f]/.test(value)) throw new Error('Invalid native model selection');
  return value;
}
function effort(value: unknown): Effort {
  if (typeof value !== 'string' || !efforts.has(value)) throw new Error('Native reasoning level requires a supported product selection');
  return value as Effort;
}

/** Decode a native menu choice; provider, sandbox and arbitrary config are not model controls. */
export function decodeCodexNativeRuntimePatch(value: unknown, threadId: string): CodexNativeRuntimePatch {
  if (!record(value) || value.threadId !== threadId) throw new Error('Native settings belong to another task');
  const allowed = new Set(['threadId', 'model', 'effort', 'serviceTier', 'collaborationMode']);
  if (Object.entries(value).some(([key, val]) => val != null && !allowed.has(key))) {
    throw new Error('Native settings require a separate product control');
  }
  const patch: CodexNativeRuntimePatch = {};
  if (value.model != null) patch.model = model(value.model);
  if (value.effort != null) patch.effort = effort(value.effort);
  // serviceTier alone is a nullable override: null explicitly restores standard.
  if (Object.hasOwn(value, 'serviceTier')) {
    if (value.serviceTier === null || value.serviceTier === 'default') patch.fastMode = false;
    else if (value.serviceTier === 'fast' || value.serviceTier === 'priority') patch.fastMode = true;
    else throw new Error('Native service tier requires a supported product selection');
  }
  if (value.collaborationMode != null) {
    const mode = value.collaborationMode;
    if (!record(mode) || Object.keys(mode).some(key => !['mode', 'settings'].includes(key))
      || !['default', 'plan'].includes(String(mode.mode)) || !record(mode.settings)) throw new Error('Invalid native collaboration mode');
    const settings = mode.settings;
    if (Object.entries(settings).some(([key, val]) => val != null && !['model', 'reasoning_effort'].includes(key))) {
      throw new Error('Native mode cannot replace task instructions');
    }
    if (settings.model != null) {
      const selected = model(settings.model);
      if (patch.model !== undefined && patch.model !== selected) throw new Error('Native model selections disagree');
      patch.model = selected;
    }
    if (settings.reasoning_effort != null) {
      const selected = effort(settings.reasoning_effort);
      if (patch.effort !== undefined && patch.effort !== selected) throw new Error('Native reasoning selections disagree');
      patch.effort = selected;
    }
    patch.planMode = mode.mode === 'plan';
  }
  return patch;
}

/** One native settings operation at a time, owned by the existing product task. */
export class CodexNativeRuntimeControls {
  private resolver?: AgentNativeRuntimeResolver;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly lifetime = new AbortController();
  constructor(private readonly thread: () => string,
    private readonly confirmed: <T>(run: () => Promise<T>, signal: AbortSignal) => Promise<T>) {}
  bind(resolver: NonNullable<CodexNativeRuntimeControls['resolver']>): void {
    if (this.lifetime.signal.aborted) throw new Error('Native settings owner closed');
    this.resolver = resolver;
  }
  close(): void { this.lifetime.abort(); this.resolver = undefined; }
  async apply(params: unknown, signal: AbortSignal): Promise<Record<string, never>> {
    const owner = this.resolver, threadId = this.thread();
    const patch = decodeCodexNativeRuntimePatch(params, threadId);
    const ownedSignal = AbortSignal.any([signal, this.lifetime.signal]);
    const check = () => {
      if (!owner || owner !== this.resolver || ownedSignal.aborted || this.thread() !== threadId) throw new Error('Native settings no longer have a product owner');
    };
    check();
    const operation = this.chain.then(async () => {
      check();
      await this.confirmed(() => owner!({ nativeSessionId: threadId, patch: Object.freeze(patch), signal: ownedSignal }), ownedSignal);
      check(); return {};
    });
    this.chain = operation.catch(() => {}); return operation;
  }
}
