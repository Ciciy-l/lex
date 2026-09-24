import { pickModelMetadata, type ModelMetadata } from './modelMetadataLayers.js';

/** Compare numbered generations within one family/variant, never lexicographically.
 * Vendor namespaces are aliases; private namespaces remain part of the identity.
 * Dates and size suffixes stay in the variant, rather than becoming generations.
 */
function generation(id: string) {
  const normalized = id.toLowerCase().replace(/^(?:openai|anthropic|google|x-ai|xai|deepseek|qwen)\//, '');
  const match = /^([a-z][a-z0-9/-]*?)(\d{1,3}(?:[.-]\d{1,3})*)(.*)$/.exec(normalized);
  if (!match) return undefined;

  let rawVersion = match[2]!;
  let variant = match[3]!;
  // A trailing size such as Qwen's 30B is part of the model variant, not a
  // newer numeric generation. Date suffixes stay in the variant as well.
  const size = /([.-])(\d{1,3})$/.exec(rawVersion);
  if (size && /^(?:b|m|k|t)(?:-|$)/.test(variant)) {
    rawVersion = rawVersion.slice(0, size.index);
    variant = size[1] + size[2] + variant;
  }
  return { family: match[1] + '|' + variant, version: rawVersion.split(/[.-]/).map(Number) };
}
function compare(left: number[], right: number[]) {
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta) return delta;
  }
  return 0;
}
/** Oldest first so nearer generations override older defaults field by field. */
export function previousModelGenerations<T>(id: string, candidates: readonly T[], getId: (candidate: T) => string): T[] {
  const target = generation(id);
  if (!target) return [];
  return candidates.flatMap(candidate => {
    const source = generation(getId(candidate));
    return source && source.family === target.family && compare(source.version, target.version) < 0
      ? [{ candidate, version: source.version }] : [];
  }).sort((a, b) => compare(a.version, b.version)).map(entry => entry.candidate);
}
/** Inherit capabilities, not identity, documentation, price, routing or membership. */
export function generationCapabilities(value: ModelMetadata | undefined): ModelMetadata {
  const {
    name: _name,
    description: _description,
    officialDocs: _docs,
    group: _group,
    mode: _mode,
    contextWindowMax: _capacity,
    supportsFastMode: _fast,
    ...capabilities
  } = pickModelMetadata(value);
  return capabilities;
}
