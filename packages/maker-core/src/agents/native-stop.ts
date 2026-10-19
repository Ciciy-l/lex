/** Host-only explicit Stop, bound to the native turn the user actually saw. */
export interface AgentNativeStopRequest {
  readonly nativeSessionId: string;
  readonly nativeTurnId: string;
  readonly signal: AbortSignal;
}
export type AgentNativeStopResolver = (request: AgentNativeStopRequest) => Promise<void>;

export class AgentNativeStopBinding {
  private owner?: { resolve: AgentNativeStopResolver; lifetime: AbortController };
  private pending = false;
  constructor(private readonly nativeId: () => string | undefined,
    private readonly active: () => boolean, private readonly turnId: () => string | null) {}
  bind(resolve: AgentNativeStopResolver): () => void {
    if (!this.active() || this.owner) throw new Error('Native stop already owned or unavailable');
    const owner = { resolve, lifetime: new AbortController() }; this.owner = owner;
    return () => { owner.lifetime.abort(); if (this.owner === owner) this.owner = undefined; };
  }
  retire(): void { this.owner?.lifetime.abort(); this.owner = undefined; }
  async resolve(request: AgentNativeStopRequest): Promise<void> {
    const owner = this.owner, nativeSessionId = request.nativeSessionId, nativeTurnId = request.nativeTurnId;
    if (!owner || this.pending) throw new Error('Native stop has no available product owner');
    const signal = AbortSignal.any([request.signal, owner.lifetime.signal]);
    const checkOwner = () => {
      if (!this.active() || signal.aborted || this.owner !== owner || !nativeSessionId
        || this.nativeId() !== nativeSessionId) throw new Error('Native stop owner changed');
    };
    checkOwner();
    if (!nativeTurnId || this.turnId() !== nativeTurnId) throw new Error('Native stop turn changed');
    this.pending = true;
    try {
      await owner.resolve({ nativeSessionId, nativeTurnId, signal });
      // Successful stop normally clears the turn. Only ownership remains a postcondition.
      checkOwner();
    } finally { this.pending = false; }
  }
}
