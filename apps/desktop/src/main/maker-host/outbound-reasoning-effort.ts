import { clampEffortToSupported, EFFORT_VALUES, type Effort } from '@cindy/model-providers';

/** Resolve an outgoing preference against this invocation's declared capabilities. */
export function reconcileOutboundReasoningEffort(
  requested: unknown,
  efforts: readonly Effort[],
): Effort | undefined {
  if (typeof requested !== 'string' || !efforts.length
    || !(EFFORT_VALUES as readonly string[]).includes(requested)) return undefined;
  return clampEffortToSupported(requested as Effort, efforts) as Effort | undefined;
}
