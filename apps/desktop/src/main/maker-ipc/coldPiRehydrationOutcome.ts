/** A dead old route must not trap model selection; successful bootstrap still needs a live runtime. */
export function classifyColdPiRehydrationOutcome(input: {
  rehydrationFailed: boolean;
  liveAfterBootstrap: boolean;
}): 'verified' | 'degraded' | 'fail-closed' {
  if (input.liveAfterBootstrap) return 'verified';
  return input.rehydrationFailed ? 'degraded' : 'fail-closed';
}
