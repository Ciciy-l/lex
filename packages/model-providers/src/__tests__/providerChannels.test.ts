import { describe, expect, it } from "vitest";
import { BUNDLED_CATALOG } from "../builtin.js";
import type { AgentKind } from "../types.js";
import {
  planLegacyProviderChannels,
  projectChannelRuntimes,
  resolveChannelModel,
  sameModelProtocolPreference,
  type ProviderChannel,
} from "../providerChannels.js";

const channel: ProviderChannel = {
  id: "channel-a",
  name: "A",
  protocols: {
    "openai-responses": {
      baseUrl: "https://a.example/responses",
      models: [{ id: "model", name: "Model", contextWindow: 1000 }],
    },
    "google-generative-ai": {
      baseUrl: "https://a.example/google",
      models: [
        {
          id: "model",
          name: "Model",
          api: "google-generative-ai",
          contextWindow: 2000,
        },
      ],
    },
  },
};

describe("protocol channels", () => {
  it("selects native APIs without merging route capabilities", () => {
    expect(resolveChannelModel(channel, "model", "codex")).toMatchObject({
      protocol: "openai-responses",
      native: true,
      model: { contextWindow: 1000 },
    });
    expect(resolveChannelModel(channel, "model", "omp")).toMatchObject({
      protocol: "google-generative-ai",
      native: true,
      model: { contextWindow: 2000 },
    });
    expect(resolveChannelModel(channel, "model", "claude-code")).toMatchObject({
      native: false,
    });
  });
  it("never substitutes a protocol or model for an unavailable fixed selection", () => {
    expect(
      resolveChannelModel(channel, "model", "codex", {
        mode: "fixed",
        protocol: "anthropic-messages",
      }),
    ).toBeNull();
    expect(resolveChannelModel(channel, "missing", "omp")).toBeNull();
    expect(
      resolveChannelModel(channel, "model", "codex", {
        mode: "fixed",
        protocol: "google-generative-ai",
      }),
    ).toMatchObject({
      channelId: "channel-a",
      protocol: "google-generative-ai",
      native: false,
    });
  });
  it("materializes four usable engines while retaining protocol-specific metadata", () => {
    const runtimes = projectChannelRuntimes(channel);
    expect(Object.keys(runtimes)).toEqual([
      "claude-code",
      "codex",
      "pi",
      "omp",
    ]);
    expect(runtimes.codex?.models[0].contextWindow).toBe(1000);
    expect(runtimes.omp?.models[0].contextWindow).toBe(2000);
  });
  it("does not reinterpret specialized SDK transports as generic engine bridges", () => {
    const specialized: ProviderChannel = {
      id: "vertex",
      name: "Vertex",
      protocols: {
        "google-generative-ai": {
          baseUrl: "https://vertex.example",
          models: [{ id: "m", name: "M", api: "google-vertex" }],
        },
      },
    };
    expect(resolveChannelModel(specialized, "m", "pi")).toBeNull();
    expect(resolveChannelModel(specialized, "m", "codex")).toBeNull();
    expect(resolveChannelModel(specialized, "m", "omp")).toBeNull();
  });
  it("preserves differing credentials as channels and keeps explicit old bindings", () => {
    const runtime = {
      baseUrl: "https://same.example",
      wireProtocol: "openai-responses" as const,
      models: [{ id: "m", name: "M", defaultEnabled: false }],
    };
    const config = {
      id: "supplier",
      name: "Supplier",
      runtimes: { codex: runtime, pi: runtime },
    };
    const distinct = planLegacyProviderChannels(config, {
      codex: "credential-a",
      pi: "credential-b",
    })!;
    expect(distinct.configuration.channels).toHaveLength(2);
    expect(distinct.configuration.legacyBindings?.codex).not.toBe(
      distinct.configuration.legacyBindings?.pi,
    );
    expect(
      distinct.configuration.channels[0].protocols["openai-responses"]
        ?.models[0].defaultEnabled,
    ).toBe(false);
    const same = planLegacyProviderChannels(config, {
      codex: "same",
      pi: "same",
    })!;
    expect(same.configuration.channels).toHaveLength(1);
    expect(same.configuration.legacyBindings?.codex).toBe(
      same.configuration.legacyBindings?.pi,
    );
    expect(JSON.stringify(same)).not.toContain("credential-");
    expect(
      planLegacyProviderChannels(
        { ...config, channels: same.configuration },
        {},
      ),
    ).toBeNull();
  });
  it("treats fixed protocol changes as configuration changes", () => {
    expect(sameModelProtocolPreference(undefined, { mode: "auto" })).toBe(true);
    expect(
      sameModelProtocolPreference(
        { mode: "fixed", protocol: "openai-responses" },
        { mode: "fixed", protocol: "google-generative-ai" },
      ),
    ).toBe(false);
  });
  it("migrates an implicit Pi Chat endpoint without turning it into Messages", () => {
    const plan = planLegacyProviderChannels(
      {
        id: "old",
        name: "Old",
        runtimes: {
          pi: {
            baseUrl: "https://old.example/v1",
            models: [{ id: "custom", name: "Custom" }],
          },
        },
      },
      { pi: "opaque" },
    )!;
    expect(
      plan.configuration.channels[0].protocols["openai-chat"]?.models[0].id,
    ).toBe("custom");
    expect(
      plan.configuration.channels[0].protocols["anthropic-messages"],
    ).toBeUndefined();
  });
  it("preserves eligible bundled presets, explicit off flags and specialized setup exclusions", () => {
    for (const preset of BUNDLED_CATALOG.presets ?? []) {
      const config = {
        id: "preset",
        name: preset.name,
        runtimes: preset.runtimes,
      };
      const planned = planLegacyProviderChannels(config, {});
      if (!planned) {
        expect(
          Object.values(preset.runtimes).some((runtime) =>
            runtime?.models.some(
              (model) =>
                (model.api || model.piApi) &&
                ![
                  "anthropic-messages",
                  "openai-responses",
                  "openai-completions",
                  "google-generative-ai",
                ].includes(model.api ?? model.piApi!),
            ),
          ),
        ).toBe(true);
        continue;
      }
      for (const [agent, runtime] of Object.entries(preset.runtimes)) {
        if (!runtime) continue;
        const id = planned.configuration.legacyBindings?.[agent as AgentKind];
        const channel = planned.configuration.channels.find(
          (item) => item.id === id,
        )!;
        const models = Object.values(channel.protocols).flatMap(
          (connection) => connection?.models ?? [],
        );
        for (const model of runtime.models)
          expect(models.find((candidate) => candidate.id === model.id)).toEqual(
            model,
          );
        expect(
          Object.values(channel.protocols).every(
            (connection) => connection?.baseUrl === runtime.baseUrl,
          ),
        ).toBe(true);
      }
    }
  });
});
