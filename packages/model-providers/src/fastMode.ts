/** APIs whose serializers can carry an explicit Fast service-tier request.
 * This is transport capability, not provider support or an actual billing tier. */
export function supportsFastServiceTier(api: string | null | undefined): boolean {
  return api === 'openai-responses' || api === 'openai-chat'
    || api === 'openai-completions' || api === 'azure-openai-responses';
}

export function isFastServiceTier(value: unknown): boolean {
  return value === 'fast' || value === 'priority';
}
