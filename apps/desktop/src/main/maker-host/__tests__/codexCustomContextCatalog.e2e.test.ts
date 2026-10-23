import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { AppServerHost } from "../../../../../../packages/maker-core/src/agents/codex/app-server/host.js";
import { Method, type CodexModelListResponse, type ThreadStartResponse } from "../../../../../../packages/maker-core/src/agents/codex/app-server/protocol.js";
import { createStdioTransport } from "../../../../../../packages/maker-core/src/agents/codex/app-server/stdioTransport.js";
import type { Logger } from "../../../../../../packages/maker-core/src/interfaces/logger.js";
import { extractBundledCodexModelCatalog, findCodexCatalogModel, prepareCodexCustomContextCatalog } from "../codex-custom-context-catalog.js";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../../..");
const binaryPath = process.env.CODEX_E2E_BINARY ?? path.join(repoRoot, "apps", "codex-package-bin", `${process.platform}-${process.arch}`, "bin", process.platform === "win32" ? "codex.exe" : "codex");

// Explicit Desktop E2E tier: reads only the managed runtime and a disposable home.
// It never uses a developer Codex configuration, authorization or provider.
it("prepares an unknown model with the pinned runtime native fallback descriptor", async () => {
  const { stdout } = await promisify(execFile)(binaryPath, ["--version"], { timeout: 5000, windowsHide: true });
  expect(stdout.trim()).toBe("codex-cli 0.162.1");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cindy-codex-fallback-native-"));
  let host: AppServerHost | undefined;
  try {
    const nativeCatalog = await extractBundledCodexModelCatalog(binaryPath);
    expect(findCodexCatalogModel(nativeCatalog, "gpt-5.4-mini")).toBeUndefined();
    const prepared = await prepareCodexCustomContextCatalog({ binaryPath, codexHome: root, modelId: "gpt-5.4-mini", contextWindow: 400_000 });
    const catalog = JSON.parse(await fs.readFile(prepared.catalogPath, "utf8"));
    const selected = catalog.models.find((model: { slug: string }) => model.slug === "gpt-5.4-mini");
    expect(selected).toMatchObject({
      slug: "gpt-5.4-mini", display_name: "gpt-5.4-mini", used_fallback_model_metadata: true,
      context_window: 272_000, max_context_window: 400_000, effective_context_window_percent: 95,
      shell_type: "unified_exec", web_search_tool_type: "text", input_modalities: ["text", "image"],
      supports_search_tool: false, supports_experimental_context: false, supports_reasoning_effort_updates: false,
      model_messages: { instructions_template: expect.any(String) },
    });
    expect(selected).not.toHaveProperty("base_instructions");
    expect(selected.model_messages.instructions_template).toContain("If the codebase has tests or the ability to build or run, consider using them to verify that your work is complete. ");

    // Deserialization + lazy thread creation use the actual app-server. No turn
    // is sent, and this disposable provider has no authorization or external URL.
    await fs.writeFile(path.join(root, "config.toml"), [
      'model_provider = "fixture"',
      '[model_providers.fixture]',
      'name = "Disposable fallback compatibility fixture"',
      'base_url = "http://127.0.0.1:9/v1"',
      'wire_api = "responses"',
    ].join("\n"));
    const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
    host = new AppServerHost({
      createTransport: () => createStdioTransport({ binaryPath, cwd: root, extraArgs: prepared.extraArgs, env: { ...process.env, CODEX_HOME: root, OPENAI_API_KEY: "invalid-test-fixture" } }),
      logger, clientInfo: { name: "lex-native-fallback-e2e", version: "0.0.0" },
    });
    const listed = await host.request<CodexModelListResponse>(Method.ModelList, { includeHidden: true }, { timeoutMs: 5000 });
    expect(listed.data.some(model => model.model === "gpt-5.4-mini")).toBe(true);
    const created = await host.request<ThreadStartResponse>(Method.ThreadStart, { model: "gpt-5.4-mini", modelProvider: "fixture", cwd: root, approvalPolicy: "never", sandbox: "read-only" }, { timeoutMs: 5000 });
    expect(created.thread.id).toBeTruthy();
    expect(created.model).toBe("gpt-5.4-mini");
  } finally {
    await host?.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});
