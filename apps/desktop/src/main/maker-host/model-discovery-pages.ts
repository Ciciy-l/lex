import {
  mergeModelMetadata,
  parseModelsListResponse,
  type DiscoveredModel,
} from '@cindy/model-providers';

export interface ModelDiscoveryPageCollection {
  models: DiscoveredModel[];
  complete: boolean;
}

/** Read paginated model catalogs without forwarding credentials outside the discovery endpoint. */
export async function collectModelDiscoveryPages(
  first: unknown,
  endpoint: string,
  fetchPage: (url: string) => Promise<unknown>,
): Promise<ModelDiscoveryPageCollection | null> {
  let origin: URL;
  try { origin = new URL(endpoint); } catch { return null; }
  const visited = new Set([origin.toString()]);
  const models = new Map<string, DiscoveredModel>();
  let page = first;
  let current = origin;
  for (let count = 0; count < 100; count += 1) {
    const parsed = parseModelsListResponse(page, endpoint);
    if (!parsed) return models.size ? { models: [...models.values()], complete: false } : null;
    for (const model of parsed) {
      const previous = models.get(model.id);
      models.set(model.id, previous ? {
        ...previous,
        ...model,
        name: model.discoveredMetadata?.name ?? previous.discoveredMetadata?.name ?? previous.name,
        contextWindow: model.contextWindow ?? previous.contextWindow,
        discoveredMetadata: mergeModelMetadata(previous.discoveredMetadata, model.discoveredMetadata),
        ...(previous.discoveredCost || model.discoveredCost
          ? { discoveredCost: { ...previous.discoveredCost, ...model.discoveredCost } }
          : {}),
      } : model);
      if (models.size > 10_000) return { models: [...models.values()], complete: false };
    }
    if (!page || typeof page !== 'object' || Array.isArray(page)) return { models: [...models.values()], complete: true };
    const data = page as Record<string, unknown>;
    const token = data.nextPageToken ?? data.next_page_token;
    const cursor = data.next_cursor;
    const link = data.next ?? (data.links as { next?: unknown } | undefined)?.next;
    const next = new URL(current);
    if (typeof token === 'string' && token) {
      next.searchParams.set(typeof data.nextPageToken === 'string' ? 'pageToken' : 'page_token', token);
    } else if (typeof cursor === 'string' && cursor) {
      next.searchParams.set('cursor', cursor);
    } else if (data.has_more === true && typeof data.last_id === 'string' && data.last_id) {
      next.searchParams.set('after_id', data.last_id);
    } else if (typeof link === 'string' && link) {
      let resolved: URL;
      try { resolved = new URL(link, current); } catch { return { models: [...models.values()], complete: false }; }
      if (resolved.origin !== origin.origin || resolved.pathname !== origin.pathname || resolved.username || resolved.password) {
        return { models: [...models.values()], complete: false };
      }
      next.href = resolved.href;
    } else {
      return { models: [...models.values()], complete: true };
    }
    if (visited.has(next.toString())) return { models: [...models.values()], complete: false };
    visited.add(next.toString());
    try { page = await fetchPage(next.toString()); } catch { return { models: [...models.values()], complete: false }; }
    current = next;
  }
  // Reaching the page cap means the snapshot is incomplete and must not replace LKG.
  return { models: [...models.values()], complete: false };
}
