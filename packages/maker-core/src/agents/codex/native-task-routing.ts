import type { CodexFrontendCall, CodexFrontendNotification } from './native-frontend.js';
import type { CodexNativeSessionHandle } from './native-input.js';
import type { TurnStartParams, TurnStartResponse } from './app-server/protocol.js';

type Scope = 'task' | 'descendant' | 'title';
export interface CodexNativeTaskRoutingOptions {
  handle: Pick<CodexNativeSessionHandle, 'id' | 'acceptNativeTurn'>;
  cwd: string;
  isCurrent(): boolean;
  /** Known lineage comes from the owning Agent, never frontend-supplied ids. */
  ownsDescendant(threadId: string): boolean;
  /** Current native route, with MCP names frozen from the owning task. */
  titleContext(): { model: string; modelProvider?: string; mcpServers: readonly string[] }
    | Promise<{ model: string; modelProvider?: string; mcpServers: readonly string[] }>;
  /** Catalog/config projection remains with the same task/provider owner. */
  catalog(call: CodexFrontendCall): Promise<unknown>;
  /** Mutations go through product controls, not an arbitrary native forward. */
  control(call: CodexFrontendCall, scope: Scope | undefined): Promise<unknown>;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const taskReads = new Set(['thread/read', 'thread/turns/list', 'thread/items/list', 'thread/goal/get', 'thread/tokenUsage/read']);
const scopedLists = new Set(['hooks/list', 'skills/list', 'plugin/list']);
const safeReads = new Set(['initialize', 'account/read', 'account/rateLimits/read', 'configRequirements/read', 'collaborationMode/list']);
const catalogReads = new Set(['model/list', 'config/read', 'mcpServerStatus/list']);
const globalEvents = new Set(['account/rateLimits/updated', 'account/updated']);

/** One original frontend can inspect its task and children, not another task's history. */
export function createCodexNativeTaskRouting(options: CodexNativeTaskRoutingOptions) {
  const threadId = options.handle.id;
  const titles = new Map<string, string>();
  let titleStarting = false;
  const current = () => options.isCurrent() && options.handle.id === threadId;
  const check = (signal?: AbortSignal) => {
    if (!current() || signal?.aborted) throw new Error('Native Codex task owner changed');
  };
  const scope = (id: unknown): Scope | undefined => typeof id !== 'string' ? undefined
    : id === threadId ? 'task' : titles.has(id) ? 'title' : options.ownsDescendant(id) ? 'descendant' : undefined;
  const requireScope = (params: Record<string, unknown>) => {
    const result = scope(params.threadId);
    if (!result) throw new Error('Native Codex request does not belong to this task');
    return result;
  };
  const result = async (call: CodexFrontendCall, run: () => Promise<unknown>) => {
    check(call.signal); const value = await run(); check(call.signal); return value;
  };
  async function request(call: CodexFrontendCall): Promise<unknown> {
    check(call.signal);
    const { method } = call.request;
    const params = call.request.params == null ? {} : call.request.params;
    if (!record(params)) throw new Error('Native Codex request parameters must be an object');
    if (safeReads.has(method)) {
      if (method === 'account/read' && params.refreshToken === true) return result(call, () => options.control(call, undefined));
      return result(call, () => call.forward());
    }
    if (catalogReads.has(method)) {
      if (params.threadId != null) requireScope(params);
      if (params.cwd != null && params.cwd !== options.cwd) throw new Error('Native catalog has another working directory');
      return result(call, () => options.catalog(call));
    }
    if (scopedLists.has(method)) {
      if (!Array.isArray(params.cwds) || params.cwds.length !== 1 || params.cwds[0] !== options.cwd) {
        throw new Error('Native capability list has another working directory');
      }
      return result(call, () => call.forward());
    }
    if (method === 'thread/list' || method === 'thread/loaded/list') {
      const page = await result(call, () => call.forward());
      if (!record(page) || !Array.isArray(page.data)) throw new Error('Native task list is invalid');
      // Do not expose cursors that encode unrelated thread identities. The
      // current task is already attached; this is only the native switcher view.
      return { ...page, data: page.data.filter(row => scope(typeof row === 'string' ? row : record(row) ? row.id : undefined)), nextCursor: null };
    }
    if (taskReads.has(method)) {
      requireScope(params); return result(call, () => call.forward());
    }
    if (method === 'thread/resume') {
      requireScope(params);
      const readFields = new Set(['threadId', 'excludeTurns', 'initialTurnsPage']);
      if (Object.entries(params).some(([key, value]) => value != null && !readFields.has(key))) {
        throw new Error('Native task attach cannot replace settings or history');
      }
      return result(call, () => call.forward());
    }
    if (method === 'thread/start' && params.threadSource === 'thread_title') {
      const context = await options.titleContext();
      check(call.signal);
      if (titleStarting || titles.size >= 4 || params.ephemeral !== true || params.sandbox !== 'read-only'
        || params.cwd !== options.cwd || params.baseInstructions != null || params.developerInstructions != null
        || params.model !== context.model || params.modelProvider !== context.modelProvider
        || params.permissions != null || !record(params.config)
        || Object.entries(params.config).some(([key, value]) => {
          if (key === 'mcp_servers') return !record(value) || Object.values(value).some(entry => !record(entry)
            || Object.keys(entry).length !== 1 || entry.enabled !== false);
          if (key === 'default_permissions') return value !== ':read-only';
          if (key === 'web_search') return value !== 'disabled';
          return !/^(features\.|tools\.|skills\.|cloud\.skills\.)/.test(key) || value !== false;
        }) || ['runtimeWorkspaceRoots', 'dynamicTools', 'selectedCapabilityRoots', 'environments'].some(key =>
          params[key] != null && (!Array.isArray(params[key]) || (params[key] as unknown[]).length !== 0))) {
        throw new Error('Native title thread must be isolated and read-only');
      }
      const config = params.config as Record<string, unknown>;
      for (const feature of ['shell_tool', 'unified_exec', 'hooks', 'plugins', 'apps', 'multi_agent', 'multi_agent_v2', 'image_generation', 'request_permissions_tool']) {
        if (config['features.' + feature] !== false) throw new Error('Native title thread cannot inherit execution tools');
      }
      const mcpServers = config.mcp_servers;
      if ((mcpServers != null && !record(mcpServers))
        || config.web_search !== 'disabled' || config.default_permissions !== ':read-only') {
        throw new Error('Native title thread cannot inherit task capabilities');
      }
      titleStarting = true;
      try {
        // The frontend intentionally cannot read service MCP transport/auth
        // config. Complete its requested all-tools-disabled title context from
        // the owning service, without granting the title any task authority.
        const disabledServers = Object.fromEntries(context.mcpServers.map(name => [name, { enabled: false }]));
        const value = await result(call, () => call.forward({ ...params, config: { ...config,
          mcp_servers: { ...(record(mcpServers) ? mcpServers : {}), ...disabledServers } } }));
        if (!record(value) || !record(value.thread) || typeof value.thread.id !== 'string'
          || value.thread.id === threadId || options.ownsDescendant(value.thread.id)) throw new Error('Native title identity is invalid');
        titles.set(value.thread.id, context.model); return value;
      } finally { titleStarting = false; }
    }
    if (method === 'turn/start') {
      const owner = requireScope(params);
      if (owner === 'task') return result(call, () => options.handle.acceptNativeTurn({ params: params as unknown as TurnStartParams,
        signal: call.signal, dispatch: prepared => call.forward(prepared) as Promise<TurnStartResponse> }));
      if (owner === 'title') {
        const fields = new Set(['threadId', 'input', 'model', 'effort', 'outputSchema']);
        if (Object.entries(params).some(([key, value]) => value != null && !fields.has(key))
          || (params.model != null && params.model !== titles.get(params.threadId as string))) {
          throw new Error('Native title turn cannot change its read-only capabilities');
        }
        return result(call, () => call.forward());
      }
      return result(call, () => options.control(call, owner));
    }
    if (method === 'thread/unsubscribe') {
      const owner = requireScope(params);
      const value = await result(call, () => call.forward());
      if (owner === 'title') titles.delete(params.threadId as string);
      return value;
    }
    const owner = params.threadId == null ? undefined : requireScope(params);
    return result(call, () => options.control(call, owner));
  }
  function notification(event: CodexFrontendNotification): CodexFrontendNotification | null {
    if (!current()) return null;
    if (globalEvents.has(event.method)) return event;
    const p = event.params;
    if (!record(p)) return null;
    const id = p.threadId ?? (record(p.thread) ? p.thread.id : undefined);
    return scope(id) ? event : null;
  }
  return { request, notification };
}
