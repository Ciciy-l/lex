const OFFICIAL_XAI_API_HOSTS = new Set(['api.x.ai', 'us.api.x.ai']);

/** True only for the documented global and US regional public xAI API hosts. */
export function isOfficialXaiApiHost(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      !url.username && !url.password &&
      url.port === '' &&
      OFFICIAL_XAI_API_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** True only for the US public API endpoint, whose tariff differs from global pricing. */
export function isOfficialXaiUsApiHost(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      url.port === '' && url.hostname.toLowerCase() === 'us.api.x.ai';
  } catch {
    return false;
  }
}
