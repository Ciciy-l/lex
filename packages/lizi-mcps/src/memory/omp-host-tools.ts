import { z } from "zod";
import type {
  OmpHostToolDefinition,
  OmpHostToolResult,
} from "@cindy/maker-core";
import type { MemoryMcpDeps } from "../types.js";
import { createMemoryToolRegistry } from "../cindy_memoryMcpServer.js";
import { withAccountDataAccess } from "../account-data-access.js";

const listSchema = z.strictObject({
  category: z.enum(["read", "write", "maintain", "search"]).optional(),
});
const callSchema = z.strictObject({
  name: z.string().min(1).max(128),
  args: z.record(z.string(), z.unknown()).optional(),
});
const failure = (): OmpHostToolResult => ({
  isError: true,
  content: [
    { type: "text", text: "Memory is unavailable for this Agent session." },
  ],
});

/** Reuse the existing registry and account/write guards; only adapt the transport. */
export function createMemoryOmpHostTools(
  deps: MemoryMcpDeps,
): readonly OmpHostToolDefinition[] {
  const owner = deps.getManager().currentOwnerScopeKey?.();
  const initialContext = deps.getSessionContext?.();
  if (!initialContext) return [];
  const ctx = { ...initialContext };
  const registry = createMemoryToolRegistry({
    ...deps,
    getSessionContext: () => ctx,
  });
  const isCurrent = () => {
    const current = deps.getSessionContext?.();
    return (
      owner != null &&
      deps.getManager().currentOwnerScopeKey?.() === owner &&
      deps.getManager().isEnabled() &&
      ctx?.memoryEnabled === true &&
      current?.memoryEnabled === true &&
      ctx.sessionId !== undefined &&
      current?.sessionId === ctx.sessionId &&
      current?.sessionInstanceId === ctx.sessionInstanceId &&
      current?.memoryScopeKey === ctx.memoryScopeKey &&
      current?.workingDir === ctx.workingDir
    );
  };
  return (
    [
      ["list_tools", listSchema],
      ["call_tool", callSchema],
    ] as const
  ).map(([name, schema]) => ({
    name: "mcp__cindy_memory__" + name,
    description:
      name === "list_tools"
        ? "Discover the shared Lex memory tools. Optionally choose a category."
        : "Call a shared Lex memory tool discovered with list_tools. Memory belongs to this account and project.",
    parameters: z.toJSONSchema(schema) as Record<string, unknown>,
    execute: async (args, { signal }) => {
      if (signal.aborted || !isCurrent()) return failure();
      const result = await withAccountDataAccess(
        deps.withAccountDataAccess,
        ctx?.sessionId,
        async (assertCurrent) => {
          await assertCurrent();
          if (!isCurrent() || signal.aborted) return failure();
          if (name === "list_tools") {
            const parsed = listSchema.safeParse(args);
            if (!parsed.success)
              return {
                isError: true,
                content: [{ type: "text" as const, text: "INVALID_ARGS" }],
              };
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    tools: registry.list(parsed.data.category),
                  }),
                },
              ],
            };
          }
          const parsed = callSchema.safeParse(args);
          if (!parsed.success)
            return {
              isError: true,
              content: [{ type: "text" as const, text: "INVALID_ARGS" }],
            };
          const response = await registry.call(
            parsed.data.name,
            parsed.data.args ?? {},
          );
          await assertCurrent();
          return {
            ...response,
            content: response.content.filter(
              (part): part is { type: "text"; text: string } =>
                part.type === "text",
            ),
          };
        },
      );
      return signal.aborted || !isCurrent() ? failure() : result;
    },
  }));
}
