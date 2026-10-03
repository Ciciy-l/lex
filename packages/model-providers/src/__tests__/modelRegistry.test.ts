import { describe, expect, it } from "vitest";

import { BUNDLED_CATALOG } from "../builtin.js";
import { expandedRegistryEntries, resolveModelMetadata } from "../modelMetadataLayers.js";
import {
  compareModelRegistryRevisions,
  findModelRegistryRoute,
  resolveBaseModelReferencePrice,
  resolveModelReferencePrice,
} from "../modelRegistry.js";

const registry = BUNDLED_CATALOG.modelRegistry!;

describe("model registry", () => {
  it.each([
    { variant: "standard" as const, inputPerMtok: 10, cacheWritePerMtok: 12.5 },
    { variant: "fast" as const, inputPerMtok: 20, cacheWritePerMtok: 25 },
  ])(
    "Astra $variant prices are available on the verified UTC day",
    ({ variant, inputPerMtok, cacheWritePerMtok }) => {
      // The observation starts at UTC midnight, regardless of the local calendar day.
      const options = {
        at: new Date("2026-09-04T00:00:00Z"),
        variant,
        inputTokens: 272_000,
      };
      expect(
        resolveModelReferencePrice(registry, "openai", "gpt-6-astra", {
          ...options,
          at: new Date("2026-09-03T23:59:59Z"),
        }),
      ).toBeUndefined();
      expect(
        resolveModelReferencePrice(registry, "openai", "gpt-6-astra", options)
          ?.price,
      ).toMatchObject({ inputPerMtok, cacheWritePerMtok });
      expect(
        resolveModelReferencePrice(registry, "openai", "gpt-6-astra", {
          ...options,
          inputTokens: 272_001,
        }),
      ).toBeUndefined();
    },
  );

  it("compares revision instants with normalized timestamps before checking content", () => {
    if (!registry) throw new Error("missing bundled registry");
    const current = { ...registry, updatedAt: "2026-08-02T02:00:00.000Z" };
    const equivalent = {
      ...registry,
      updatedAt: "2026-08-02T10:00:00.000+08:00",
    };

    expect(compareModelRegistryRevisions(equivalent, current)).toBe("same");
    expect(
      compareModelRegistryRevisions(
        { ...equivalent, models: equivalent.models.slice(1) },
        current,
      ),
    ).toBe("conflict");
    expect(
      compareModelRegistryRevisions(
        { ...registry, updatedAt: "2026-08-02T01:59:59.999Z" },
        current,
      ),
    ).toBe("older");
    expect(
      compareModelRegistryRevisions(
        { ...registry, updatedAt: "2026-08-02T02:00:00.001Z" },
        current,
      ),
    ).toBe("newer");
    expect(
      compareModelRegistryRevisions(
        { ...registry, updatedAt: "invalid" },
        current,
      ),
    ).toBe("invalid-incoming");
  });

  it("resolves exact provider/runtime routes without claiming availability", () => {
    expect(
      findModelRegistryRoute(
        registry,
        "anthropic",
        "claude-opus-5",
        "claude-code",
      ),
    ).toMatchObject({
      entry: { id: "anthropic/claude-opus-5", contextWindow: 1_000_000 },
      route: { providerId: "anthropic", modelId: "claude-opus-5" },
    });
    expect(
      findModelRegistryRoute(
        registry,
        "  anthropic  ",
        "  claude-opus-5  ",
        "claude-code",
      ),
    ).toMatchObject({
      route: { providerId: "anthropic", modelId: "claude-opus-5" },
    });
    expect(
      findModelRegistryRoute(
        registry,
        "other-provider",
        "claude-opus-5",
        "claude-code",
      ),
    ).toBeUndefined();
  });

  it("keeps XD split identities compatible with saved routes, aliases, selection labels, and user overrides", () => {
    const splitRoutes = [
      ["claude-fable-5", "xd/claude-fable-5", "claude-code"],
      ["claude-opus-5", "xd/claude-opus-5", "claude-code"],
      ["claude-opus-4-8", "xd/claude-opus-4-8", "claude-code"],
      ["claude-opus-4-7", "xd/claude-opus-4-7", "claude-code"],
      ["claude-opus-4-6", "xd/claude-opus-4-6", "claude-code"],
      ["claude-opus-4-5", "xd/claude-opus-4-5", "claude-code"],
      ["claude-sonnet-5", "xd/claude-sonnet-5", "claude-code"],
      ["claude-sonnet-4-6", "xd/claude-sonnet-4-6", "claude-code"],
      ["claude-sonnet-4-5", "xd/claude-sonnet-4-5", "claude-code"],
      ["claude-haiku-4-5", "xd/claude-haiku-4-5", "claude-code"],
      ["deepseek/deepseek-v4-pro", "xd/deepseek-deepseek-v4-pro", "codex"],
      ["deepseek/deepseek-v4-flash", "xd/deepseek-deepseek-v4-flash", "codex"],
      ["gpt-5.4-nano", "xd/gpt-5.4-nano", "codex"],
    ] as const;
    for (const [oldRouteId, newEntryId, agent] of splitRoutes) {
      const resolved = findModelRegistryRoute(registry, "xd", oldRouteId, agent);
      expect(resolved, oldRouteId).toMatchObject({
        entry: { id: newEntryId },
        route: { providerId: "xd", modelId: oldRouteId },
      });
      // The row label is still the entry name; changing the registry identity must not
      // replace a saved selection with an opaque xd/* label.
      expect(resolved?.entry.name).not.toMatch(/^xd\//);
    }

    const kimiAlias = registry.baseModels?.find(
      (model) => model.id === "xd/moonshotai-kimi-k3",
    );
    expect(kimiAlias?.aliases).toContain("moonshot/kimi-k3");
    expect(
      resolveModelMetadata(registry, "xd", "moonshot/kimi-k3", undefined, {
        name: "Saved Kimi label",
        contextWindow: 12_345,
      }),
    ).toMatchObject({ name: "Saved Kimi label", contextWindow: 12_345 });
    expect(
      resolveModelMetadata(registry, "xd", "claude-opus-5", undefined, {
        contextWindow: 12_346,
        efforts: ["low"],
        defaultEffort: "low",
      }),
    ).toMatchObject({
      contextWindow: 12_346,
      efforts: ["low"],
      defaultEffort: "low",
    });
  });

  it("keeps every XD split route mapped to its independent entry and upstream reference", () => {
    const splitRoutes = registry.models.flatMap((entry) =>
      entry.id.startsWith("xd/")
        ? entry.routes
            .filter((route) => route.providerId === "xd")
            .map((route) => ({ entry, route }))
        : [],
    );
    expect(splitRoutes.length).toBeGreaterThan(0);
    for (const { entry, route } of splitRoutes) {
      const resolved = findModelRegistryRoute(
        registry,
        route.providerId,
        route.modelId,
        route.agents[0],
      );
      expect(resolved, `${route.providerId}/${route.modelId}`).toMatchObject({
        entry: {
          id: entry.id,
          modelRef: entry.modelRef,
          name: entry.name,
        },
        route: {
          providerId: route.providerId,
          modelId: route.modelId,
        },
      });
      expect(resolved?.entry.name).not.toMatch(/^xd\//);
    }
  });

  it("normalizes the ChatGPT bridge id and selects OpenAI long-context bands", () => {
    // Subscription and gateway windows belong to distinct server-owned routes.
    expect(
      findModelRegistryRoute(registry, "openai", "gpt-5.6-sol", "codex"),
    ).toMatchObject({
      entry: {
        contextWindow: 1_050_000,
        perAgent: {
          codex: { contextWindow: 272_000 },
          "claude-code": { contextWindow: 272_000 },
        },
        maxOutputTokens: 128_000,
      },
    });
    expect(
      findModelRegistryRoute(registry, "xd", "gpt-5.6-sol", "codex"),
    ).toMatchObject({
      entry: {
        id: "xd/gpt-5.6-sol",
        contextWindow: 1_050_000,
        perAgent: { codex: { contextWindow: 272_000 } },
      },
    });
    expect(
      resolveModelReferencePrice(registry, "openai", "chatgpt/gpt-5.6-sol", {
        agent: "claude-code",
        inputTokens: 272_000,
      })?.price,
    ).toMatchObject({ inputPerMtok: 4, outputPerMtok: 20 });
    expect(
      resolveModelReferencePrice(
        registry,
        "openai",
        "chatgpt/gpt-5.6-sol[1m]",
        {
          agent: "claude-code",
          inputTokens: 272_001,
        },
      )?.price,
    ).toMatchObject({ inputPerMtok: 8, outputPerMtok: 30 });
    expect(
      resolveModelReferencePrice(registry, "openai", "gpt-5.6-sol", {
        agent: "codex",
        inputTokens: 272_001,
      })?.price,
    ).toMatchObject({ inputPerMtok: 8, outputPerMtok: 30 });
    expect(
      resolveModelReferencePrice(registry, "openai", "gpt-5.4-nano", {
        agent: "codex",
      })?.price,
    ).toMatchObject({ inputPerMtok: 0.2, outputPerMtok: 1.25 });
  });

  it("selects xAI token bands and time-effective Anthropic prices", () => {
    expect(
      resolveModelReferencePrice(registry, "xai", "xai/grok-4.6", {
        inputTokens: 199_999,
      })?.price,
    ).toMatchObject({
      inputPerMtok: 2,
      outputPerMtok: 6,
      cacheReadPerMtok: 0.5,
    });
    expect(
      resolveModelReferencePrice(registry, "xai", "xai/grok-4.6", {
        inputTokens: 200_000,
      })?.price,
    ).toMatchObject({
      inputPerMtok: 4,
      outputPerMtok: 12,
      cacheReadPerMtok: 1,
    });
    expect(
      resolveModelReferencePrice(registry, "xai", "xai/grok-4.5", {
        inputTokens: 199_999,
      })?.price,
    ).toMatchObject({ inputPerMtok: 2, outputPerMtok: 6 });
    expect(
      resolveModelReferencePrice(registry, "xai", "xai/grok-4.5", {
        inputTokens: 200_000,
      })?.price,
    ).toMatchObject({ inputPerMtok: 4, outputPerMtok: 12 });
    expect(
      resolveModelReferencePrice(registry, "xai", "xai/grok-build-0.1", {
        inputTokens: 200_000,
      })?.price,
    ).toMatchObject({ inputPerMtok: 2, outputPerMtok: 4 });
    expect(
      [
        "xai/grok-4.20-multi-agent-0309",
        "xai/grok-4.20-0309-reasoning",
        "xai/grok-4.20-0309-non-reasoning",
      ].every((modelId) =>
        Boolean(findModelRegistryRoute(registry, "xai", modelId, "codex")),
      ),
    ).toBe(true);
    expect(
      resolveModelReferencePrice(registry, "anthropic", "claude-sonnet-5", {
        at: "2026-08-31",
      })?.price,
    ).toMatchObject({ inputPerMtok: 2, outputPerMtok: 10 });
    expect(
      resolveModelReferencePrice(registry, "anthropic", "claude-sonnet-5", {
        at: "2026-09-01",
      })?.price,
    ).toMatchObject({ inputPerMtok: 2, outputPerMtok: 10 });
  });

  it("documents xAI 200k boundaries and keeps Fast pricing unknown without an effective date", () => {
    expect(
      resolveModelReferencePrice(registry, "xai", "xai/grok-4.7", {
        inputTokens: 199_999,
      }),
    ).toMatchObject({ price: { inputPerMtok: 2, outputPerMtok: 6 } });
    for (const inputTokens of [200_000, 200_001]) {
      expect(
        resolveModelReferencePrice(registry, "xai", "xai/grok-4.7", {
          inputTokens,
        }),
        `Grok 4.7 input boundary ${inputTokens}`,
      ).toMatchObject({ price: { inputPerMtok: 4, outputPerMtok: 12 } });
    }
    // xAI publishes Fast's numeric table but not a historical effective date. The
    // resolver contract requires effectiveFrom, so no date-free or tag-date tariff
    // is exposed at either boundary.
    expect(
      resolveModelReferencePrice(registry, "xai", "xai/grok-4.7-build-fast", {
        inputTokens: 200_000,
      }),
    ).toBeUndefined();
    expect(
      resolveModelReferencePrice(registry, "xai", "xai/grok-4.7-build-fast", {
        inputTokens: 200_001,
      }),
    ).toBeUndefined();
    expect(
      registry.baseModels?.find((model) => model.id === "xai/grok-4.7-build-fast"),
    ).not.toHaveProperty("referencePriceGroups");
    expect(
      registry.models.find((model) => model.id === "xai/grok-4.7-build-fast")?.routes,
    ).not.toEqual(expect.arrayContaining([expect.objectContaining({ referencePriceGroup: "global" })]));
  });

  it("applies the documented Gemini 3.8 Flash Standard cutover at 2027-01-01", () => {
    expect(
      resolveBaseModelReferencePrice(registry, "google/gemini-3.8-flash", {
        priceGroup: "global",
        at: "2026-12-31",
      }),
    ).toBeUndefined();
    expect(
      resolveBaseModelReferencePrice(registry, "gemini-3.8-flash", {
        priceGroup: "global",
        at: "2027-01-01",
      }),
    ).toMatchObject({
      price: {
        inputPerMtok: 1.5,
        outputPerMtok: 7.5,
        cacheReadPerMtok: 0.15,
      },
    });
  });

  it("resolves DeepSeek BYOK cache-hit pricing for both runtimes", () => {
    for (const [modelId, expected] of [
      [
        "deepseek-v4-pro",
        {
          inputPerMtok: 0.435,
          outputPerMtok: 0.87,
          cacheReadPerMtok: 0.003625,
        },
      ],
      [
        "deepseek-v4-flash",
        { inputPerMtok: 0.14, outputPerMtok: 0.28, cacheReadPerMtok: 0.0028 },
      ],
    ] as const) {
      expect(
        resolveModelReferencePrice(registry, "deepseek", modelId, {
          agent: "claude-code",
          at: "2026-08-05",
        })?.price,
      ).toMatchObject(expected);
      expect(
        resolveModelReferencePrice(registry, "deepseek", modelId, {
          agent: "codex",
          at: "2026-08-05",
        })?.price,
      ).toMatchObject(expected);
    }
  });

  it.each([
    ["deepseek-v4-pro", 0.435, 1.32, 3.96, 0.044],
    ["deepseek-v4-flash", 0.14, 0.44, 1.32, 0.014],
  ] as const)(
    "preserves %s direct historical prices at the peak-reference transition",
    (modelId, oldInput, inputPerMtok, outputPerMtok, cacheReadPerMtok) => {
      for (const agent of ["claude-code", "codex"] as const) {
        expect(
          resolveModelReferencePrice(registry, "deepseek", modelId, {
            agent,
            at: "2026-08-15",
          })?.price.inputPerMtok,
        ).toBe(oldInput);
        expect(
          resolveModelReferencePrice(registry, "deepseek", modelId, {
            agent,
            at: "2026-08-16",
          })?.price,
        ).toMatchObject({ inputPerMtok, outputPerMtok, cacheReadPerMtok });
      }
    },
  );

  it.each(["claude-opus-5", "claude-opus-4-8"])(
    "includes %s Fast cache prices independently of standard prices",
    (modelId) => {
      expect(
        resolveModelReferencePrice(registry, "anthropic", modelId, {
          at: "2026-09-05",
          variant: "fast",
        })?.price,
      ).toMatchObject({
        inputPerMtok: 10,
        outputPerMtok: 50,
        cacheReadPerMtok: 1,
        cacheWritePerMtok: 12.5,
        cacheWrite1hPerMtok: 20,
      });
    },
  );

  it("keeps Sol historical prices when selecting the later reduced reference rate", () => {
    for (const [at, inputPerMtok, outputPerMtok] of [
      ["2026-08-20", 5, 30],
      ["2026-08-21", 4, 20],
    ] as const) {
      expect(
        resolveModelReferencePrice(registry, "openai", "gpt-5.6-sol", {
          at,
          inputTokens: 272_000,
        })?.price,
      ).toMatchObject({ inputPerMtok, outputPerMtok });
    }
  });

  it("normalizes historical Claude aliases before resolving date-effective prices", () => {
    expect(
      resolveModelReferencePrice(registry, "anthropic", "sonnet", {
        agent: "claude-code",
        at: "2026-03-01",
      }),
    ).toMatchObject({
      route: { modelId: "claude-sonnet-4-6" },
      price: { inputPerMtok: 3, outputPerMtok: 15 },
    });
    expect(
      resolveModelReferencePrice(
        registry,
        "anthropic",
        "claude-sonnet-4-6-20260701",
        { agent: "claude-code", at: "2026-08-01" },
      ),
    ).toMatchObject({
      route: { modelId: "claude-sonnet-4-6" },
      price: { inputPerMtok: 3, outputPerMtok: 15 },
    });
  });
});

it.each([
  { variant: "standard" as const, input: 20, output: 75, read: 2, write: 25 },
  { variant: "fast" as const, input: 40, output: 150, read: 4, write: 50 },
])(
  "uses verified Astra $variant long-input rates from September 7",
  ({ variant, input, output, read, write }) => {
    const options = { variant, at: new Date("2026-09-07T00:00:00Z") };
    expect(
      resolveModelReferencePrice(registry, "openai", "gpt-6-astra", {
        ...options,
        inputTokens: 272_000,
      })?.price,
    ).toMatchObject({ inputPerMtok: input / 2, outputPerMtok: output / 1.5 });
    expect(
      resolveModelReferencePrice(registry, "openai", "gpt-6-astra", {
        ...options,
        inputTokens: 272_001,
      })?.price,
    ).toMatchObject({
      inputPerMtok: input,
      outputPerMtok: output,
      cacheReadPerMtok: read,
      cacheWritePerMtok: write,
    });
  },
);

it("records the GA DeepSeek V4 Pro tiers without changing its daily default", () => {
  expect(
    expandedRegistryEntries(registry!).find(
      (m) => m.id === "deepseek/deepseek-v4-pro",
    ),
  ).toMatchObject({ efforts: ["low", "high", "max"], defaultEffort: "high" });
});
