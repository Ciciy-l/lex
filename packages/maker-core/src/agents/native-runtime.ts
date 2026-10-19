import type { Effort } from '../types/common.js';

/** A native menu request, never an IPC-supplied provider or executable route. */
export interface AgentNativeRuntimePatch {
  model?: string;
  effort?: Effort;
  fastMode?: boolean;
  planMode?: boolean;
}
export interface AgentNativeRuntimeRequest {
  readonly nativeSessionId: string;
  readonly patch: Readonly<AgentNativeRuntimePatch>;
  readonly signal: AbortSignal;
}
export type AgentNativeRuntimeResolver = (request: AgentNativeRuntimeRequest) => Promise<void>;

/** The task's product binding outlives a view, but never an account or runtime. */
export class AgentNativeRuntimeBinding {
  private owner?: { resolve: AgentNativeRuntimeResolver; lifetime: AbortController };
  constructor(private readonly currentNativeId: () => string | undefined,
    private readonly active: () => boolean) {}

  bind(resolve: AgentNativeRuntimeResolver): () => void {
    if (!this.active() || this.owner) throw new Error('Native runtime already owned or unavailable');
    const owner = { resolve, lifetime: new AbortController() };
    this.owner = owner;
    return () => {
      owner.lifetime.abort();
      if (this.owner === owner) this.owner = undefined;
    };
  }
  retire(): void { this.owner?.lifetime.abort(); this.owner = undefined; }

  async resolve(request: AgentNativeRuntimeRequest): Promise<void> {
    const owner = this.owner;
    if (!owner) throw new Error('Native runtime has no product owner');
    const nativeId = request.nativeSessionId;
    const signal = AbortSignal.any([request.signal, owner.lifetime.signal]);
    const check = () => {
      if (!this.active() || signal.aborted || owner !== this.owner || !nativeId
        || nativeId !== this.currentNativeId()) throw new Error('Native runtime owner changed');
    };
    check();
    await owner.resolve({ nativeSessionId: nativeId, patch: Object.freeze(structuredClone(request.patch)), signal });
    check();
  }
}
