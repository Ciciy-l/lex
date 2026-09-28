import { describe, expect, it } from "vitest";
import { BUNDLED_CATALOG, parseCatalog } from "../catalog.js";

const registry = BUNDLED_CATALOG.modelRegistry!;
const baseModels = registry.baseModels ?? [];

function parseRegistryPayload(payload: unknown): unknown {
  return parseCatalog(JSON.stringify({ ...BUNDLED_CATALOG, modelRegistry: payload }));
}

function withEntry(entry: Record<string, unknown>): unknown {
  return { ...registry, models: [{ ...registry.models[0], ...entry }] };
}

/** Adds media defaults to the base model the first access entry actually references. */
function withBaseModelMedia(media: Record<string, unknown>): unknown {
  const modelRef = registry.models[0].modelRef;
  return {
    ...registry,
    baseModels: baseModels.map((base) =>
      base.id === modelRef ? { ...base, defaults: { ...base.defaults, ...media } } : base,
    ),
  };
}

describe("strict media-capability parsing for the registryMedia=1 negotiation", () => {
  it("accepts the media shapes a media-capable external snapshot actually publishes", () => {
    // registryMedia=1 asks the external service for media-capable entries, so Lex must
    // parse that response shape. This is the only media-capable field the upstream
    // snapshot uses on access entries; an unknown one would fail the whole catalog.
    expect(() => parseRegistryPayload(withEntry({ mode: "image" }))).not.toThrow();
  });

  it("carries the media fields the upstream snapshot publishes on base model defaults", () => {
    // Upstream baseModels.defaults carries supportsImageInput / mode / modalities. They are
    // merged into the effective entry rather than validated per field, so assert the real
    // referenced base model still parses once those defaults are present.
    expect(() =>
      parseRegistryPayload(
        withBaseModelMedia({
          supportsImageInput: true,
          mode: "chat",
          modalities: { input: ["text", "image"], output: ["text"] },
        }),
      ),
    ).not.toThrow();
  });

  it("still fails closed on an access-entry media field Lex does not model", () => {
    // Unknown capability fields must not be silently dropped, otherwise a newly published
    // media flag would read as "unsupported model" instead of an explicit parse failure.
    expect(() => parseRegistryPayload(withEntry({ supportsVideoInput: true }))).toThrow(
      /not allowed by this schema version/,
    );
  });

  it("parses the bundled media-capable registry end to end", () => {
    expect(() => parseRegistryPayload(registry)).not.toThrow();
  });
});
