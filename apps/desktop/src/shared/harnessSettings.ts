export const HARNESS_KINDS = ['claude-code', 'codex', 'pi', 'omp'] as const;
export type HarnessKind = (typeof HARNESS_KINDS)[number];
export type HarnessSource = 'upstream' | 'baseline';
export type HarnessFailureStage = 'check' | 'download' | 'extract' | 'verify' | 'publish';
export interface HarnessRelease {
  version: string;
  source: HarnessSource;
}
export interface HarnessRuntimeState {
  kind: HarnessKind;
  currentVersion: string | null;
  selectedVersion: string | null;
  restartRequired: boolean;
  baseline: HarnessRelease | null;
  upstream: HarnessRelease | null;
  checkedAt: number | null;
  phase: 'idle' | 'checking' | 'downloading' | 'verifying' | 'ready' | 'cancelled' | 'failed';
  percent: number | null;
  error: string | null;
  /** Optional for older progress receipts. No paths or raw upstream errors. */
  failureStage?: HarnessFailureStage | null;
}
export interface HarnessRuntimeApi {
  state(kind: HarnessKind): Promise<HarnessRuntimeState>;
  check(kind: HarnessKind, force?: boolean): Promise<HarnessRuntimeState>;
  install(input: {
    kind: HarnessKind;
    source: HarnessSource;
    version: string;
  }): Promise<HarnessRuntimeState>;
  cancel(kind: HarnessKind): Promise<void>;
  onProgress(listener: (state: HarnessRuntimeState) => void): () => void;
}

export interface OmpHarnessSettings {
  unifiedMemory: boolean;
  nativeMemory: boolean;
  subagentModel: string | null;
  maxConcurrency: number | null;
  maxRecursionDepth: number | null;
  compactionEnabled: boolean;
  compactionThreshold: number | null;
  keepRecentTokens: number | null;
}
export const OMP_HARNESS_DEFAULTS: OmpHarnessSettings = {
  unifiedMemory: true,
  nativeMemory: false,
  subagentModel: null,
  maxConcurrency: null,
  maxRecursionDepth: null,
  compactionEnabled: true,
  compactionThreshold: null,
  keepRecentTokens: null,
};
export interface OmpHarnessState {
  ownerGeneration: number;
  value: OmpHarnessSettings;
  defaults: OmpHarnessSettings;
  isCustomized: boolean;
  customizedKeys: string[];
  unifiedEnabled: boolean;
}
export interface OmpHarnessApi {
  get(): Promise<OmpHarnessState>;
  set(patch: Partial<OmpHarnessSettings>, ownerGeneration: number): Promise<OmpHarnessState>;
  reset(keys: (keyof OmpHarnessSettings)[], ownerGeneration: number): Promise<OmpHarnessState>;
  clearMemory(ownerGeneration: number): Promise<void>;
}
