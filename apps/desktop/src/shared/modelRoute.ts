export const MODEL_ROUTE_CHAIN_MAX = 5;

/** Engine identity used by the ordinary model picker. */
export type ModelHarness = 'claude' | 'codex' | 'pi' | 'omp';

/** One complete runtime model selection. */
export interface ModelRoute {
  harness: ModelHarness;
  model: string;
  providerId: string | null;
  effort: string;
  fastMode: boolean;
}

export function normalizeModelHarness(value: unknown): ModelHarness {
  return value === 'codex' || value === 'pi' || value === 'omp' || value === 'claude'
    ? value
    : 'claude';
}

export function normalizeModelRoute(value: unknown): ModelRoute | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.model !== 'string' || !record.model.trim()) return null;
  return {
    harness: normalizeModelHarness(record.harness),
    model: record.model.trim(),
    providerId:
      typeof record.providerId === 'string' && record.providerId.trim()
        ? record.providerId.trim()
        : null,
    effort: typeof record.effort === 'string' ? record.effort : '',
    fastMode: record.fastMode === true,
  };
}

/**
 * Normalize legacy model picker snapshots without inventing a selection.
 * Duplicate routes are dropped because retrying the same endpoint cannot recover it.
 */
export function normalizeModelRoutes(
  value: unknown,
  legacy?: Record<string, unknown> | null,
): ModelRoute[] {
  const candidates = Array.isArray(value)
    ? value.map(normalizeModelRoute).filter((item): item is ModelRoute => item !== null)
    : [];
  if (candidates.length === 0 && legacy) {
    const single = normalizeModelRoute(legacy);
    if (single) candidates.push(single);
  }
  const seen = new Set<string>();
  return candidates.filter((item) => {
    const key = `${item.harness}\u0000${item.providerId ?? ''}\u0000${item.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MODEL_ROUTE_CHAIN_MAX);
}
