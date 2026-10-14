import { describe, expect, it } from "vitest";
import { buildUserProviderChannels } from "../channel-provider.js";
import {
  groupProviderChannelEntries,
  providerChannelChoices,
} from "../channelSelection.js";
import {
  channelProtocolProviderId,
  legacyChannelModelPreferenceId,
  planLegacyProviderChannels,
  projectLegacyChannelRuntimes,
} from "../providerChannels.js";
import { unifiedModelEntries } from "../unifiedSelection.js";
import type { CustomProviderConfig } from "../types.js";

function supplier(): CustomProviderConfig {
  return {
    id: "supplier",
    name: "Supplier",
    runtimes: {},
    channels: {
      version: 1,
      channels: [
        {
          id: "route-a",
          name: "A",
          protocols: {
            "openai-responses": {
              baseUrl: "https://a.example",
              models: [{ id: "same", name: "Same", contextWindow: 1000 }],
            },
            "google-generative-ai": {
              baseUrl: "https://google.example",
              models: [{ id: "same", name: "Same", contextWindow: 2000 }],
            },
          },
        },
        {
          id: "route-b",
          name: "B",
          protocols: {
            "google-generative-ai": {
              baseUrl: "https://b.example",
              models: [{ id: "same", name: "Same", contextWindow: 3000 }],
            },
          },
        },
      ],
    },
  };
}

describe("supplier model rows and stable selections", () => {
  it("inherits old preferences only for the original engine, channel, model and protocol", () => {
    const old: CustomProviderConfig = {
      id: "old",
      name: "Old",
      runtimes: {
        codex: {
          baseUrl: "https://old.example",
          wireProtocol: "openai-chat",
          models: [{ id: "same", name: "Same" }],
        },
      },
    };
    const config = {
      ...old,
      channels: planLegacyProviderChannels(old, {})!.configuration,
    };
    const channel = config.channels.channels[0];
    let provider = buildUserProviderChannels(config)[0];
    expect(legacyChannelModelPreferenceId(provider, "codex", "same")).toBe(
      "old",
    );
    expect(
      legacyChannelModelPreferenceId(provider, "pi", "same"),
    ).toBeUndefined();
    expect(
      legacyChannelModelPreferenceId(provider, "codex", "missing"),
    ).toBeUndefined();
    channel.protocols["openai-responses"] = {
      baseUrl: "https://native.example",
      models: [{ id: "same", name: "Same" }],
    };
    const providers = buildUserProviderChannels(config);
    provider = providers[0];
    expect(
      legacyChannelModelPreferenceId(provider, "codex", "same"),
    ).toBeUndefined();
    const fixed = providers.find(
      (entry) => entry.channel?.protocol === "openai-chat",
    )!;
    expect(legacyChannelModelPreferenceId(fixed, "codex", "same")).toBe("old");
    const unrelated = {
      ...fixed,
      channel: { ...fixed.channel!, id: "different-channel" },
    };
    expect(
      legacyChannelModelPreferenceId(unrelated, "codex", "same"),
    ).toBeUndefined();
  });
  it("groups normal rows but retains all channel and fixed protocol identities", () => {
    const providers = buildUserProviderChannels(supplier()).map((provider) => ({
      ...provider,
      connected: true,
    }));
    const entries = unifiedModelEntries({ providers, isVisible: () => true });
    expect(entries).toHaveLength(5);
    const rows = groupProviderChannelEntries(entries, providers);
    expect(rows).toHaveLength(1);
    expect(rows[0].providerId).toBe("route-a");
    expect(providerChannelChoices(rows[0], entries, providers)).toHaveLength(5);
    const fixedId = channelProtocolProviderId(
      "route-b",
      "google-generative-ai",
    );
    const selected = groupProviderChannelEntries(entries, providers, {
      providerId: fixedId,
      modelId: "same",
    });
    expect(selected[0].providerId).toBe(fixedId);
    expect(
      providers.find((provider) => provider.id === fixedId)?.models.codex?.[0]
        .contextWindow,
    ).toBe(3000);
    expect(
      providers.find((provider) => provider.id === "route-a")?.models.codex?.[0]
        .contextWindow,
    ).toBe(1000);
  });
  it("does not merge equal model names across suppliers", () => {
    const other = supplier();
    other.id = "other";
    other.channels!.channels = other.channels!.channels.map((channel) => ({
      ...channel,
      id: channel.id + "-other",
    }));
    const providers = [
      ...buildUserProviderChannels(supplier()),
      ...buildUserProviderChannels(other),
    ].map((provider) => ({ ...provider, connected: true }));
    expect(
      groupProviderChannelEntries(
        unifiedModelEntries({ providers, isVisible: () => true }),
        providers,
      ),
    ).toHaveLength(2);
  });
  it("keeps historical tasks on their old protocol and honors later channel edits", () => {
    const old: CustomProviderConfig = {
      id: "old",
      name: "Old",
      runtimes: {
        codex: {
          baseUrl: "https://old.example",
          wireProtocol: "openai-chat",
          models: [{ id: "same", name: "Same", defaultEnabled: false }],
        },
      },
    };
    const plan = planLegacyProviderChannels(old, { codex: "opaque" })!;
    const migrated = { ...old, channels: plan.configuration };
    const channel = migrated.channels.channels[0];
    channel.protocols["openai-chat"]!.baseUrl = "https://edited.example";
    channel.protocols["openai-responses"] = {
      baseUrl: "https://new.example",
      models: [{ id: "same", name: "Same" }],
    };
    const legacy = projectLegacyChannelRuntimes(migrated);
    expect(legacy.codex?.models[0]).toMatchObject({
      defaultEnabled: false,
      route: { wireProtocol: "openai-chat", baseUrl: "https://edited.example" },
    });
    delete channel.protocols["openai-chat"];
    expect(projectLegacyChannelRuntimes(migrated).codex).toBeUndefined();
  });
  it("keeps damaged canonical settings visible for repair without reviving old routes", () => {
    const config = supplier();
    config.channels!.channels = [];
    config.runtimes.codex = {
      baseUrl: "https://obsolete.example",
      models: [{ id: "old", name: "Old" }],
    };
    const [provider] = buildUserProviderChannels(config);
    expect(provider.id).toBe("supplier");
    expect(provider.agents).toEqual([]);
    expect(provider.customConfig?.channels).toEqual({
      version: 1,
      channels: [],
    });
  });
});
