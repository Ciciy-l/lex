import type { ProviderRuntimeModelConfig } from '@cindy/model-providers';

export function modelsAfterProviderEndpointEdit(
  models: ProviderRuntimeModelConfig[],
  previousBaseUrl: string | undefined,
  nextBaseUrl: string,
): ProviderRuntimeModelConfig[] {
  if (!previousBaseUrl) return models;
  const parse = (value: string): URL | undefined => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
        ? url
        : undefined;
    } catch {
      return undefined;
    }
  };
  const previous = parse(previousBaseUrl);
  const next = parse(nextBaseUrl);
  if (!previous || !next || previous.href === next.href) return models;
  const trimTrailingSlashes = (value: string) => {
    let end = value.length;
    while (end > 0 && value[end - 1] === '/') end -= 1;
    return value.slice(0, end);
  };
  const sameBase = (left: URL, right: URL) => left.origin === right.origin
    && trimTrailingSlashes(left.pathname) === trimTrailingSlashes(right.pathname)
    && left.search === right.search && left.hash === right.hash;
  return models.map((model) => {
    if (!model.route) return model;
    const route = parse(model.route.baseUrl);
    if (!route || route.origin !== previous.origin) return model;
    const baseUrl = sameBase(route, previous)
      ? nextBaseUrl.trim()
      : next.origin + route.pathname + route.search + route.hash;
    if (baseUrl === model.route.baseUrl) return model;
    return { ...model, route: { ...model.route, baseUrl } };
  });
}
