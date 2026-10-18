import type { ContextUsageData } from '../../types/context-usage.js';
import type { ClaudeNativeRuntime } from './native-runtime.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const rows = (value: unknown, valid: (row: RecordValue) => boolean) => Array.isArray(value) && value.every(row => record(row) && valid(row));

function contextPayload(value: unknown): ContextUsageData {
  const data = record(value) && record(value.context) ? value.context.breakdown : undefined;
  if (!record(data) || typeof data.model !== 'string' || !data.model
    || !['totalTokens', 'maxTokens', 'rawMaxTokens', 'percentage'].every(key => number(data[key]))
    || typeof data.isAutoCompactEnabled !== 'boolean'
    || !rows(data.categories, row => typeof row.name === 'string' && typeof row.color === 'string' && number(row.tokens))
    || !rows(data.memoryFiles, row => typeof row.path === 'string' && typeof row.type === 'string' && number(row.tokens))
    || !rows(data.mcpTools, row => typeof row.name === 'string' && typeof row.serverName === 'string' && number(row.tokens))
    || !rows(data.agents, row => typeof row.agentType === 'string' && typeof row.source === 'string' && number(row.tokens))
    || !Array.isArray(data.gridRows) || !data.gridRows.every(row => rows(row, square =>
      typeof square.color === 'string' && typeof square.categoryName === 'string' && typeof square.isFilled === 'boolean'
      && ['tokens', 'percentage', 'squareFullness'].every(key => number(square[key]))))
    || !(data.apiUsage === null || (record(data.apiUsage)
      && ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].every(key => number((data.apiUsage as RecordValue)[key]))))) {
    throw new Error('Native Claude did not return a complete context breakdown');
  }
  // Preserve the native /context categories and future metadata. Do not replace
  // missing counts with zero or reconstruct them from terminal text.
  return data as unknown as ContextUsageData;
}

function untilCancelled<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new Error(signal.reason?.name === 'TimeoutError'
      ? 'Native Claude context request timed out' : 'Native Claude context request cancelled'));
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener('abort', cancel, { once: true });
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

/** An explicit GUI read, never a per-token query or a second accounting ledger. */
export function createClaudeNativeContextReader(
  runtime: Pick<ClaudeNativeRuntime, 'ready' | 'command'>, signal: AbortSignal, isLive: () => boolean,
): () => Promise<ContextUsageData> {
  let inFlight: Promise<ContextUsageData> | undefined;
  const checkLive = () => { if (signal.aborted || !isLive()) throw new Error('Native Claude context owner is no longer active'); };
  return async () => {
    checkLive();
    if (!inFlight) {
      const read = (async () => {
        const pending = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
        await untilCancelled(runtime.ready, pending);
        checkLive();
        const result = await untilCancelled(runtime.command('context-usage', {}, 30_000), pending);
        checkLive();
        return contextPayload(result);
      })();
      inFlight = read;
      void read.finally(() => { if (inFlight === read) inFlight = undefined; }).catch(() => {});
    }
    // Concurrent consumers share one native count request, not mutable results.
    return structuredClone(await inFlight);
  };
}
