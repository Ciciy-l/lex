import type { PrepareResult } from './types.js';

/** Retry delay for an optional Pi runtime that missed the startup network. */
export const PI_RUNTIME_RECOVERY_RETRY_MS = 30_000;

/** Only errors that may change when connectivity returns are worth retrying. */
export function isRetryablePiPrepareError(error?: string): boolean {
  return error === 'manifest_failed'
    || error === 'NETWORK'
    || error === 'HTTP_5XX'
    || error === 'ABORTED';
}

export interface PiRuntimeRecoveryOptions {
  /** Display-only label; Pi keeps the historical default, other optional engines reuse this state machine. */
  runtimeName?: string;
  isOnline: () => boolean;
  prepare: () => Promise<PrepareResult>;
  register: () => boolean;
  onRegistered: () => void;
  logWarn?: (message: string, error?: unknown) => void;
  retryDelayMs?: number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

export interface PiRuntimeRecovery {
  /**
   * Begin the optional runtime's first background prepare without making the
   * caller wait for it. Subsequent calls may prompt an immediate retry while
   * the runtime remains unavailable; a recovered runtime is left alone.
   */
  start(reason?: string): Promise<boolean>;
  /** Mark the startup prepare as unavailable and begin background recovery. */
  markUnavailable(error?: string): void;
  /** Try recovery immediately; returns true only when Pi was registered. */
  retryNow(reason?: string): Promise<boolean>;
  /** Stop future retries during app shutdown or test cleanup. */
  dispose(): void;
  isDisabled(): boolean;
}

/**
 * Owns the small recovery state machine for an optional Pi runtime.
 *
 * The CDN policy remains unchanged: every retry calls the managed prepare path,
 * so a local runtime is accepted only after the manifest and verification rules
 * have succeeded. Concurrent focus/timer signals share one prepare promise.
 */
export function createPiRuntimeRecovery(options: PiRuntimeRecoveryOptions): PiRuntimeRecovery {
  const runtimeName = options.runtimeName ?? 'Pi';
  const retryDelayMs = options.retryDelayMs ?? PI_RUNTIME_RECOVERY_RETRY_MS;
  const schedule = options.setTimeout ?? globalThis.setTimeout;
  const cancel = options.clearTimeout ?? globalThis.clearTimeout;
  let disabled = false;
  let disposed = false;
  let retryable = false;
  let retryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let inFlight: Promise<boolean> | null = null;
  let started = false;

  const logWarn = (message: string, error?: unknown): void => {
    options.logWarn?.(message, error);
  };

  const scheduleRetry = (): void => {
    if (disposed || !disabled || retryTimer !== null) return;
    retryTimer = schedule(() => {
      retryTimer = null;
      void recovery.retryNow('timer');
    }, retryDelayMs);
    const unref = (retryTimer as unknown as { unref?: () => void }).unref;
    unref?.call(retryTimer);
  };

  const recovery: PiRuntimeRecovery = {
    start(reason = 'startup') {
      if (disposed || (started && !disabled)) return Promise.resolve(false);
      started = true;
      // The first automatic attempt has no prior prepare result to classify.
      // Treat it as retryable until the managed provisioner returns a concrete
      // outcome; retryNow() then applies the usual network/single-flight rules.
      disabled = true;
      retryable = true;
      return recovery.retryNow(reason);
    },

    markUnavailable(error) {
      disabled = true;
      retryable = isRetryablePiPrepareError(error);
      if (!retryable && retryTimer !== null) {
        cancel(retryTimer);
        retryTimer = null;
      }
      if (error) {
        logWarn(
          retryable
            ? `${runtimeName} runtime unavailable; scheduling recovery`
            : `${runtimeName} runtime unavailable; recovery not scheduled for permanent prepare error`,
          error,
        );
      }
      if (retryable) scheduleRetry();
    },

    retryNow(reason = 'manual') {
      if (disposed || !disabled || !retryable) return Promise.resolve(false);
      if (inFlight) return inFlight;

      let online = false;
      try {
        online = options.isOnline();
      } catch (error) {
        logWarn(`${runtimeName} runtime network state probe failed`, error);
      }
      if (!online) {
        scheduleRetry();
        return Promise.resolve(false);
      }

      const attempt = (async (): Promise<boolean> => {
        try {
          const result = await options.prepare();
          if (!result.ready || !result.path) {
            logWarn(`${runtimeName} runtime recovery prepare failed (${reason})`, result.error);
            recovery.markUnavailable(result.error);
            return false;
          }
          if (!options.register()) {
            scheduleRetry();
            return false;
          }
          if (retryTimer !== null) {
            cancel(retryTimer);
            retryTimer = null;
          }
          disabled = false;
          retryable = false;
          options.onRegistered();
          return true;
        } catch (error) {
          logWarn(`${runtimeName} runtime recovery threw (${reason})`, error);
          recovery.markUnavailable(error instanceof Error ? error.message : String(error));
          return false;
        }
      })();
      inFlight = attempt;
      void attempt.then(() => {
        if (inFlight === attempt) inFlight = null;
      }, () => {
        if (inFlight === attempt) inFlight = null;
      });
      return attempt;
    },

    dispose() {
      disposed = true;
      if (retryTimer !== null) {
        cancel(retryTimer);
        retryTimer = null;
      }
    },

    isDisabled() {
      return disabled;
    },
  };

  return recovery;
}

/**
 * Shared alias for optional engines whose managed runtime may miss a startup
 * network window. Pi is the original user; OMP uses the same bounded,
 * single-flight retry contract rather than introducing a second scheduler.
 */
export type OptionalRuntimeRecoveryOptions = PiRuntimeRecoveryOptions;
export type OptionalRuntimeRecovery = PiRuntimeRecovery;
export const createOptionalRuntimeRecovery = createPiRuntimeRecovery;
