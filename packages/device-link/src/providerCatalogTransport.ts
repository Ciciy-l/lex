import { DeviceLinkError, type InvokePayload, type InvokeResultPayload } from './protocol.js';

export const PROVIDER_CATALOG_PAGES_CAPABILITY = 'provider-catalog-pages-v1';
export const PROVIDER_CATALOG_PAGE_CHARS = 256 * 1024;
const channel = 'maker:provider:list';
const format = 'provider-catalog-page-v1';
// Bound controller-side assembly independently of the per-message transport limit.
const maxCatalogChars = 64 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function isProviderCatalogCursor(value: unknown): value is { offset: number; revision: string } {
  return record(value) && Object.keys(value).every(key => key === 'offset' || key === 'revision')
    && Number.isSafeInteger(value.offset) && (value.offset as number) > 0
    && (value.offset as number) < maxCatalogChars
    && typeof value.revision === 'string' && /^[a-f0-9]{64}$/.test(value.revision);
}

/** Called only after the host's normal authorization and credential-free projection. */
export function encodeProviderCatalogPage(
  args: readonly unknown[], value: unknown, revisionOf: (json: string) => string,
): unknown {
  const options = args[0];
  if (!record(options) || !Array.isArray(options.capabilities)
    || !options.capabilities.includes(PROVIDER_CATALOG_PAGES_CAPABILITY)) return value;
  const json = JSON.stringify(value);
  if (json === undefined) return value;
  if (json.length > maxCatalogChars) throw new Error('[PRECONDITION_FAILED] Provider catalog exceeds assembly budget');
  const revision = revisionOf(json);
  const cursor = options.catalogPage;
  if (cursor !== undefined && !isProviderCatalogCursor(cursor)) {
    throw new Error('[INVALID_PARAMS] Invalid provider catalog cursor');
  }
  if (cursor && (cursor.revision !== revision || cursor.offset >= json.length)) {
    throw new Error('[PRECONDITION_FAILED] Provider catalog changed during read');
  }
  const offset = cursor?.offset ?? 0;
  // Even worst-case JSON escaping stays below the legacy 2MiB frame budget.
  return { format, revision, offset, total: json.length, data: json.slice(offset, offset + PROVIDER_CATALOG_PAGE_CHARS) };
}

/** Preserve the public invoke result, assembling the entire catalog before publishing it. */
export async function readProviderCatalog(
  payload: InvokePayload,
  invoke: (payload: InvokePayload) => Promise<InvokeResultPayload>,
): Promise<InvokeResultPayload> {
  if (payload.channel !== channel) return invoke(payload);
  const original = payload.args?.[0];
  if (original !== undefined && !record(original)) return invoke(payload);
  const options = {
    ...original,
    capabilities: [...new Set([
      ...(Array.isArray(original?.capabilities) ? original.capabilities : []),
      PROVIDER_CATALOG_PAGES_CAPABILITY,
    ])],
  };
  let response = await invoke({ ...payload, args: [options, ...(payload.args?.slice(1) ?? [])] });
  // Old hosts ignore the capability and return the original complete catalog.
  if (!response.ok || !record(response.result) || response.result.format !== format) return response;
  const revision = response.result.revision;
  const total = response.result.total;
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)
    || !Number.isSafeInteger(total) || (total as number) <= 0 || (total as number) > maxCatalogChars) {
    throw new DeviceLinkError('BAD_REQUEST', 'Invalid provider catalog page');
  }
  const parts: string[] = [];
  let offset = 0;
  while (response.ok) {
    const page = response.result;
    if (!record(page) || page.format !== format || page.revision !== revision || page.total !== total
      || page.offset !== offset || typeof page.data !== 'string' || !page.data.length
      || page.data.length !== Math.min(PROVIDER_CATALOG_PAGE_CHARS, (total as number) - offset)) {
      throw new DeviceLinkError('BAD_REQUEST', 'Inconsistent provider catalog page');
    }
    parts.push(page.data);
    offset += page.data.length;
    if (offset === total) return { ...response, result: JSON.parse(parts.join('')) };
    response = await invoke({ ...payload, args: [{ ...options, catalogPage: { offset, revision } }, ...(payload.args?.slice(1) ?? [])] });
  }
  return response;
}
