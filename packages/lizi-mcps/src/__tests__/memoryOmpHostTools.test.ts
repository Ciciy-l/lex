import { describe, expect, it, vi } from "vitest";
import { createMemoryOmpHostTools } from "../memory/omp-host-tools.js";
import type { MemoryMcpDeps } from "../types.js";

function fixture() {
  let owner = "a";
  const list = vi.fn(async () => []);
  const getStore = vi.fn(async () => ({ list }));
  const context = {
    agentKind: "omp" as const,
    sessionId: "task",
    sessionInstanceId: "instance",
    workingDir: "/work",
    memoryScopeKey: "/canonical-work",
    memoryEnabled: true,
  };
  const deps = {
    workdir: "/wrong-fallback",
    getSessionContext: () => context,
    getManager: () => ({
      isEnabled: () => true,
      currentOwnerScopeKey: () => owner,
      getStore,
    }),
  } as unknown as MemoryMcpDeps;
  const tools = createMemoryOmpHostTools(deps);
  const call = (args: Record<string, unknown>) =>
    tools
      .find((tool) => tool.name.endsWith("call_tool"))!
      .execute(args, { signal: new AbortController().signal });
  return {
    call,
    getStore,
    list,
    context,
    switchOwner: () => {
      owner = "b";
    },
  };
}
describe("OMP unified memory tools", () => {
  it("uses the captured task scope and the existing registry validation", async () => {
    const f = fixture();
    expect((await f.call({ name: "memory_list", args: {} })).isError).not.toBe(
      true,
    );
    expect(f.getStore).toHaveBeenCalledWith("/canonical-work");
    f.getStore.mockClear();
    expect(
      (await f.call({ name: "memory_list", args: { workdir: "/other" } }))
        .isError,
    ).toBe(true);
    expect(f.getStore).not.toHaveBeenCalled();
  });
  it("denies stale account and instance contexts before storage access", async () => {
    const f = fixture();
    f.switchOwner();
    expect((await f.call({ name: "memory_list" })).isError).toBe(true);
    expect(f.getStore).not.toHaveBeenCalled();
    const g = fixture();
    g.context.memoryEnabled = false;
    expect((await g.call({ name: "memory_list" })).isError).toBe(true);
    expect(g.getStore).not.toHaveBeenCalled();
  });
  it("discards a result if the owner changes across an asynchronous read", async () => {
    const f = fixture();
    f.list.mockImplementationOnce(async () => {
      f.switchOwner();
      return [];
    });
    expect((await f.call({ name: "memory_list" })).isError).toBe(true);
  });
  it.each([
    "sessionId",
    "sessionInstanceId",
    "memoryScopeKey",
    "workingDir",
  ] as const)(
    "rejects in-place changes to %s before storage access",
    async (key) => {
      const f = fixture();
      f.context[key] = "another-context";
      expect((await f.call({ name: "memory_list" })).isError).toBe(true);
      expect(f.getStore).not.toHaveBeenCalled();
    },
  );
});
