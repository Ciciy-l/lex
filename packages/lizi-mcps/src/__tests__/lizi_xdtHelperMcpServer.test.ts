import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import { createXdtHelperMcpServer } from "../lizi_xdtHelperMcpServer.js";

const TARGET_SESSION_ID = "11111111-1111-4111-8111-111111111111";

function parsePayload(result: unknown): Record<string, unknown> {
  const content = (
    result as { content?: Array<{ type: string; text?: string }> }
  ).content;
  const first = content?.[0];
  if (!first || first.type !== "text" || !first.text) {
    throw new Error("tool result has no text content");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

describe("cindy_helper MCP server", () => {
it.each(['default'] as const)('exposes runtime declarations through the same helper tool for %s', async (surface) => {
    const runtimeCapabilities = vi.fn(async () => ({ ok: true, capabilities: [{ server: 'fixture' }] }));
    const server = createXdtHelperMcpServer({ resolveSurface: async () => surface, runtimeCapabilities }, {
      agentKind: 'pi', workingDir: '/repo', sessionId: 'current-task',
    });
    const client = new Client({ name: 'catalog-test', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const result = parsePayload(await client.callTool({ name: 'call_tool', arguments: {
        name: 'get_capabilities', args: { scope: 'runtime', server: 'fixture', category: 'files' },
      } }));
      expect(result).toMatchObject({ ok: true, capabilities: [{ server: 'fixture' }] });
      expect(runtimeCapabilities).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'current-task', agentKind: 'pi' }), { server: 'fixture', category: 'files' });
    } finally { await client.close(); await server.close(); }
  });


  it("dispatches a discovered send_to_session call without dropping nested arguments", async () => {
    const sendToSession = vi.fn(async () => ({
      ok: true as const,
      targetSessionId: TARGET_SESSION_ID,
      agentKind: "codex" as const,
      wakeKind: "resumed" as const,
      targetTitle: "Issue follow-up",
      targetLastUserSendAt: null,
    }));
    const server = createXdtHelperMcpServer(
      { sendToSession },
      {
        agentKind: "codex",
        workingDir: "/repo",
        sessionId: "dispatcher-session",
      },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: "cindy-helper-transport-test",
      version: "0.0.0",
    });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const topLevelTools = await client.listTools();
      expect(topLevelTools.tools.map((tool) => tool.name).sort()).toEqual([
        "call_tool",
        "list_tools",
      ]);

      const discovered = parsePayload(
        await client.callTool({
          name: "list_tools",
          arguments: { category: "handoff" },
        }),
      );
      expect(discovered).toMatchObject({
        ok: true,
        category: "handoff",
      });
      const discoveredTools = discovered.tools as Array<{ name: string }>;
      expect(discoveredTools.map((tool) => tool.name)).toContain(
        "send_to_session",
      );

      const result = await client.callTool({
        name: "call_tool",
        arguments: {
          name: "send_to_session",
          args: {
            target_session_id: TARGET_SESSION_ID,
            message: "Continue the existing task",
          },
        },
      });

      expect(result.isError).not.toBe(true);
      expect(parsePayload(result)).toMatchObject({
        ok: true,
        target_session_id: TARGET_SESSION_ID,
        wake_kind: "resumed",
      });
      expect(sendToSession).toHaveBeenCalledOnce();
      expect(sendToSession).toHaveBeenCalledWith({
        targetSessionId: TARGET_SESSION_ID,
        message: "Continue the existing task",
        dispatcherSessionId: "dispatcher-session",
        title: undefined,
        useWorktree: undefined,
        workingDir: undefined,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });



  it("discovers and calls the arbitrary session queue tool through the entry tools", async () => {
    const listSessionQueue = vi.fn(async () => ({
      ok: true as const,
      messages: [],
    }));
    const server = createXdtHelperMcpServer(
      {
        sessionQueue: {
          listSessionQueue,
          listSessionQueuedCounts: vi.fn(async () => ({ ok: true as const, counts: {} })),
        },
      },
      {
        agentKind: "codex",
        workingDir: "/repo",
        sessionId: "dispatcher-session",
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: "cindy-helper-queue-test",
      version: "0.0.0",
    });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const discovered = parsePayload(
        await client.callTool({
          name: "list_tools",
          arguments: { category: "history" },
        }),
      );
      expect((discovered.tools as Array<{ name: string }>).map((tool) => tool.name)).toContain(
        "list_session_queue",
      );

      const result = await client.callTool({
        name: "call_tool",
        arguments: {
          name: "list_session_queue",
          args: { session_id: "session-1" },
        },
      });

      expect(parsePayload(result)).toMatchObject({
        ok: true,
        session_id: "session-1",
        queued_count: 0,
        queue: [],
      });
      expect(listSessionQueue).toHaveBeenCalledWith("session-1");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("discovers the complete session control surface through the control category", async () => {
    const server = createXdtHelperMcpServer(
      {
        sessionControl: {
          updateQueuedMessage: vi.fn(async ({ queuedMessageId }) => ({
            ok: true as const,
            queuedMessageId,
          })),
          cancelQueuedMessage: vi.fn(async ({ queuedMessageId }) => ({
            ok: true as const,
            queuedMessageId,
          })),
          steerQueuedMessage: vi.fn(async ({ queuedMessageId }) => ({
            ok: true as const,
            queuedMessageId,
            delivery: "steered" as const,
          })),
          moveQueuedMessage: vi.fn(async ({ queuedMessageId, position }) => ({
            ok: true as const,
            queuedMessageId,
            position,
          })),
          steerSession: vi.fn(async () => ({
            ok: true as const,
            queuedMessageId: "steer-1",
          })),
          stopSessionTurn: vi.fn(async () => ({
            ok: true as const,
            status: "requested" as const,
            turnGeneration: 4,
          })),
          getSessionRuntime: vi.fn(async () => ({
            ok: true as const,
            runtime: {
              sessionId: "target",
              phase: "idle" as const,
              recordStatus: "active" as const,
              attention: false,
              workflow: null,
              source: "persisted" as const,
              turnGeneration: null,
              startedAtMs: null,
              lastActivityAtMs: null,
              currentActionSummary: null,
              gracefulStopState: "none" as const,
            },
          })),
          setSessionRuntime: vi.fn(async () => ({
            ok: true as const,
            status: "applied" as const,
            generation: 1,
            effectiveProfile: {
              agentKind: "codex" as const,
              model: "gpt-5.6-sol",
              providerId: "openai",
              effort: "high" as const,
              fastMode: false,
            },
            pendingMutation: null,
          })),
        },
      },
      {
        agentKind: "codex",
        workingDir: "/repo",
        sessionId: "dispatcher-session",
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: "cindy-helper-control-test",
      version: "0.0.0",
    });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const discovered = parsePayload(
        await client.callTool({
          name: "list_tools",
          arguments: { category: "control" },
        }),
      );
      const names = (discovered.tools as Array<{ name: string }>).map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining([
        "update_session_queued_message",
        "cancel_session_queued_message",
        "steer_session_queued_message",
        "move_session_queued_message",
        "steer_session",
        "stop_session_turn",
        "get_session_runtime",
        "set_session_runtime",
      ]));
    } finally {
      await client.close();
      await server.close();
    }
  });
it.each(["default", "restricted", "bot", "bot-main", "error", "unbound"] as const)("hides and blocks all companion commands on %s surface", async (surface) => {
    const callback = vi.fn(async () => ({ ok: false as const, errorCode: "UNEXPECTED", message: "must not run" }));
    const server = createXdtHelperMcpServer({
      resolveSurface: async () => {
        if (surface === "error") throw new Error("classification unavailable");
        return surface === "unbound" ? "bot" : surface;
      },
    }, { agentKind: "codex", workingDir: "/repo", sessionId: surface === "unbound" ? undefined : "normal-session" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "helper-surface-denial", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["call_tool", "list_tools"]);
      const discovery = parsePayload(await client.callTool({ name: "list_tools", arguments: { category: "bots" } }));
      expect(discovery).toMatchObject({ ok: false, errorCode: "CAPABILITY_NOT_AVAILABLE" });
      for (const name of ["start_session_task", "check_session_task", "message_session_task", "stop_session_task", "send_to_agent", "create_teammate"]) {
        const result = parsePayload(await client.callTool({ name: "call_tool", arguments: { name, args: {} } }));
        expect(result).toMatchObject({ ok: false, errorCode: "UNKNOWN_TOOL" });
      }
      expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain("start_session_task");
      expect(callback).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
it("exposes ordinary tools and rechecks the surface before every call", async () => {
    let surface: "restricted" | "default" = "default";
    const sendToSession = vi.fn(async () => ({
      ok: true as const,
      targetSessionId: TARGET_SESSION_ID,
      agentKind: "codex" as const,
      wakeKind: "resumed" as const,
      targetTitle: "Other task",
      targetLastUserSendAt: null,
    }));
    const messageAgent = vi.fn(async () => ({
      ok: true as const,
      targetBotId: "bot-b",
      targetBotName: "Dash Bot",
      targetSessionId: "bot-b-main",
      wakeKind: "queued" as const,
    }));
    const server = createXdtHelperMcpServer(
      {
        resolveSurface: async () => surface,
        sendToSession,
      },
      {
        agentKind: "pi",
        workingDir: "/repo",
        sessionId: "bot-a-main",
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cindy-bot-helper-surface-test", version: "0.0.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const overview = parsePayload(
        await client.callTool({ name: "list_tools", arguments: {} }),
      );
      expect(overview.categories).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'cindy' }),
        expect.objectContaining({ name: 'handoff' }),
      ]));
      // No project/history callbacks are installed in this fixture; they must not be advertised.
      expect(overview.categories).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'control' }), expect.objectContaining({ name: 'history' }),
      ]));
      const handedOff = parsePayload(await client.callTool({ name: 'call_tool', arguments: {
        name: 'send_to_session', args: { target_session_id: TARGET_SESSION_ID, message: 'Do work' },
      } }));
      expect(handedOff).toMatchObject({ ok: true });
      expect(sendToSession).toHaveBeenCalled();

      surface = "restricted";
      const afterReclassification = parsePayload(await client.callTool({
        name: "call_tool", arguments: { name: "send_to_session", args: { target_session_id: TARGET_SESSION_ID, message: "hello" } },
      }));
      expect(afterReclassification).toMatchObject({ ok: false, errorCode: "CAPABILITY_NOT_AVAILABLE" });
      expect(sendToSession).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
it("checks ordinary task control with the host before invoking callbacks", async () => {
    const stopSessionTurn = vi.fn(async () => ({ ok: true as const, status: "requested" as const }));
    const messageAgent = vi.fn(async () => ({
      ok: true as const,
      targetBotId: "bot-b",
      targetBotName: "Dash Bot",
      targetSessionId: "bot-b-main",
      wakeKind: "queued" as const,
    }));
    const authorizeCall = vi.fn(async ({ tool }: { tool: string }) => (tool === "stop_session_turn"
      ? { ok: false as const, errorCode: "TASK_OUT_OF_SCOPE", message: "not yours" }
      : { ok: true as const }));
    const server = createXdtHelperMcpServer(
      {
        resolveSurface: async () => "default",
        authorizeCall,
        sessionControl: {
          updateQueuedMessage: vi.fn(),
          cancelQueuedMessage: vi.fn(),
          steerQueuedMessage: vi.fn(),
          moveQueuedMessage: vi.fn(),
          steerSession: vi.fn(),
          stopSessionTurn,
          getSessionRuntime: vi.fn(),
          setSessionRuntime: vi.fn(),
        },
      },
      { agentKind: "pi", workingDir: "/bot", sessionId: "bot-a-main" },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bot-main-surface", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const overview = parsePayload(await client.callTool({ name: "list_tools", arguments: {} }));
      const categories = (overview.categories as Array<{ name: string }>).map((category) => category.name);
      expect(categories).toEqual(expect.arrayContaining(["control"]));

      expect(parsePayload(await client.callTool({
        name: "call_tool",
        arguments: { name: "stop_session_turn", args: { session_id: TARGET_SESSION_ID } },
      }))).toMatchObject({ ok: false, errorCode: "TASK_OUT_OF_SCOPE" });
      expect(stopSessionTurn).not.toHaveBeenCalled();
      expect(authorizeCall).toHaveBeenCalledWith({
        sessionId: "bot-a-main",
        server: "cindy_helper",
        tool: "stop_session_turn",
        args: { session_id: TARGET_SESSION_ID },
      });

    } finally {
      await client.close();
      await server.close();
    }
  });
it("fails closed when the host authorizer throws", async () => {
    const sendToSession = vi.fn();
    const server = createXdtHelperMcpServer(
      {
        resolveSurface: async () => "default",
        authorizeCall: async () => { throw new Error("db gone"); },
        sendToSession,
      },
      { agentKind: "pi", workingDir: "/bot", sessionId: "bot-a-main" },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bot-main-authorizer-throws", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      expect(parsePayload(await client.callTool({
        name: "call_tool",
        arguments: { name: "send_to_session", args: { target_session_id: TARGET_SESSION_ID, message: "hello" } },
      }))).toMatchObject({ ok: false, errorCode: "CAPABILITY_NOT_AVAILABLE" });
      expect(sendToSession).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
it("rejects legacy companion classifications even with ordinary callbacks installed", async () => {
    const authorizeCall = vi.fn(async () => ({ ok: true as const }));
    const createProject = vi.fn(async () => ({ ok: true as const, workingDir: "/repo" }));
    for (const context of [
      { agentKind: "codex" as const, workingDir: "/repo", sessionId: "bot-remote", remoteHostId: "ssh-host" },
      { agentKind: "pi" as const, workingDir: "/repo", sessionId: "bot-lane" },
    ]) {
      const server = createXdtHelperMcpServer(
        { resolveSurface: async () => (context.remoteHostId ? "bot-main" : "bot"), authorizeCall, createProject },
        context,
      );
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "bot-narrow-surface", version: "0.0.0" });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const overview = parsePayload(await client.callTool({ name: "list_tools", arguments: {} }));
        const categories = (overview.categories as Array<{ name: string }>).map((category) => category.name);
        expect(categories).toEqual([]);
        expect(parsePayload(await client.callTool({ name: "call_tool", arguments: { name: "create_project", args: { working_dir: "/repo" } } }))).toMatchObject({ ok: false, errorCode: "CAPABILITY_NOT_AVAILABLE" });
      } finally {
        await client.close();
        await server.close();
      }
    }
    expect(authorizeCall).not.toHaveBeenCalled();
    expect(createProject).not.toHaveBeenCalled();
  });
it("does not offer local project tools to an ordinary remote Claude/Codex task", async () => {
    const createProject = vi.fn(async () => ({ ok: true as const, workingDir: "/repo" }));
    const server = createXdtHelperMcpServer(
      { resolveSurface: async () => "default", createProject },
      {
        agentKind: "codex",
        workingDir: "/repo",
        sessionId: "bot-remote",
        remoteHostId: "ssh-host",
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "remote-bot-projects", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const overview = parsePayload(await client.callTool({ name: "list_tools", arguments: {} }));
      expect(overview.categories).toEqual([{ name: "cindy", tool_count: 2 }]);
      expect(
        parsePayload(await client.callTool({
          name: "call_tool",
          arguments: { name: "create_project", args: { working_dir: "/repo" } },
        })),
      ).toMatchObject({ ok: false, errorCode: "CAPABILITY_NOT_AVAILABLE" });
      expect(createProject).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("fails closed when the host cannot classify the Session surface", async () => {
    const sendToSession = vi.fn(async () => ({
      ok: true as const,
      targetSessionId: TARGET_SESSION_ID,
      agentKind: "codex" as const,
      wakeKind: "resumed" as const,
      targetTitle: "Other task",
      targetLastUserSendAt: null,
    }));
    const server = createXdtHelperMcpServer(
      {
        resolveSurface: async () => { throw new Error("db unavailable"); },
        sendToSession,
      },
      { agentKind: "pi", workingDir: "/repo", sessionId: "unknown-session" },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cindy-helper-restricted-test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const overview = parsePayload(
        await client.callTool({ name: "list_tools", arguments: {} }),
      );
      expect(overview.categories).toEqual([]);
      const forbiddenCall = parsePayload(
        await client.callTool({
          name: "call_tool",
          arguments: {
            name: "send_to_session",
            args: { target_session_id: TARGET_SESSION_ID, message: "Do work" },
          },
        }),
      );
      expect(forbiddenCall).toMatchObject({
        ok: false,
        errorCode: "CAPABILITY_NOT_AVAILABLE",
      });
      expect(sendToSession).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
