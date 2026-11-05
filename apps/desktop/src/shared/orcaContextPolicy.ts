/**
 * Host / renderer shared contract for Orca context dispatch policy.
 *
 * `keep` is the compatibility default and never needs a capability probe.
 * `clear` / `compact` are explicit requests: an old host, a remote session or a
 * harness without proven native completion must refuse them instead of silently
 * falling back to `keep`.
 */
export const ORCA_CONTEXT_POLICIES = ['keep', 'clear', 'compact'] as const;

export type OrcaContextPolicy = (typeof ORCA_CONTEXT_POLICIES)[number];

/** Only applied outcomes; a refusal is reported separately as an error code. */
export type OrcaContextAppliedOutcome = 'kept' | 'cleared' | 'compacted';

export type OrcaContextUnsupportedReason =
  | 'host-version'
  | 'remote-session'
  | 'manual-compact-unavailable'
  | 'native-presentation'
  | 'native-completion-unverified';

export interface OrcaContextCapability {
  supported: boolean;
  reason?: OrcaContextUnsupportedReason;
  /**
   * A dormant Codex/Pi worker may attempt manual compact before it has a live
   * handle; the hint must not promise that the resumed runtime can compress.
   */
  provisional?: boolean;
}

/** Per-worker support for the two destructive/async policies. */
export interface OrcaWorkerContextSupport {
  clear: OrcaContextCapability;
  compact: OrcaContextCapability;
}

/**
 * Safe dispatch receipt. Never carries message text, native ids or credentials.
 * `applied` is true only after the host observed the real clear/compact
 * completion boundary; a failure after clear keeps `outcome: 'cleared'` with
 * `applied: true` so callers can report the irreversible part truthfully.
 */
export interface OrcaContextOutcome {
  policy: OrcaContextPolicy;
  outcome: OrcaContextAppliedOutcome;
  applied: boolean;
  /** compact only: the native compaction reported no work to do. */
  compactNoop?: boolean;
}

export type OrcaContextAuditOutcome = 'cleared' | 'compacted' | 'failed' | 'refused';

/** Content-free audit record for an explicit clear/compact dispatch policy. */
export interface OrcaContextAuditEvent {
  leadSessionId: string;
  workerId: string;
  workerSessionId: string;
  policy: Exclude<OrcaContextPolicy, 'keep'>;
  outcome: OrcaContextAuditOutcome;
  reason?: string;
}

export function isOrcaContextPolicy(value: unknown): value is OrcaContextPolicy {
  return value === 'keep' || value === 'clear' || value === 'compact';
}

export function normalizeOrcaContextPolicy(value: unknown): OrcaContextPolicy | null {
  if (value === undefined || value === null) return 'keep';
  return isOrcaContextPolicy(value) ? value : null;
}

export function contextCapabilityForPolicy(
  support: OrcaWorkerContextSupport | null | undefined,
  policy: OrcaContextPolicy,
): OrcaContextCapability {
  if (policy === 'keep') return { supported: true };
  if (!support) return { supported: false, reason: 'host-version' };
  return support[policy];
}

export const UNSUPPORTED_ORCA_CONTEXT_SUPPORT: OrcaWorkerContextSupport = {
  clear: { supported: false, reason: 'host-version' },
  compact: { supported: false, reason: 'host-version' },
};
