export type RemoteBotSessionAccess = 'ordinary' | 'visible' | 'hidden' | 'missing';
type Lookup = (sessionId: string, kind?: 'session' | 'bot') => Promise<RemoteBotSessionAccess>;
export type RemoteBotSessionBatchLookup = (ids: readonly string[], kind: 'session' | 'bot') => Promise<ReadonlyMap<string, RemoteBotSessionAccess>>;
let lookup: Lookup | null = null;
let batchLookup: RemoteBotSessionBatchLookup | null = null;

/** Legacy names are retained for dispatch consumers; no companion runtime is loaded. */
export function setRemoteBotSessionLookup(value: Lookup | null, batch: RemoteBotSessionBatchLookup | null = null): void {
  lookup = value;
  batchLookup = value ? batch : null;
}

// Only these handlers take a task ID in their first positional argument.
// Agent kinds, project paths, plugin IDs and schedule IDs are not task identities.
const POSITIONAL_SESSION_CHANNELS = new Set([
  "binding:resolve-session",
  "binding:revoke",
  "ghosts:card:list-by-session",
  "git-context:get-for-session",
  "git-context:pr-refs:list",
  "image-cache:cleanup-session",
  "local-db:messages:around",
  "local-db:messages:around-client-id",
  "local-db:messages:create",
  "local-db:messages:dismiss-error",
  "local-db:messages:estimatedSessionValue",
  "local-db:messages:list",
  "local-db:messages:updateAgentMeta",
  "local-db:messages:updateContent",
  "local-db:messages:view",
  "local-db:messages:view-intent",
  "local-db:messages:work-details",
  "local-db:orca-workflows:get-by-lead",
  "local-db:orca-workflows:get-by-worker-session",
  "local-db:orca-workflows:list-workers-by-lead",
  "local-db:orca-workflows:list-workers-by-leads",
  "local-db:sessions:ack-interrupted",
  "local-db:sessions:get",
  "local-db:sessions:get-many",
  "local-db:sessions:patch-meta",
  "maker:abort-session",
  "maker:agent-task:stop",
  "maker:claude-session-route:get",
  "maker:close-session",
  "maker:compact-session",
  "maker:export-session-html",
  "maker:fork",
  "maker:fork-strip-encrypted",
  "maker:get-context-usage",
  "maker:get-pending-interactions",
  "maker:get-session-agent-switch-intent",
  "maker:get-session-tree",
  "maker:get-workflow-progress",
  "maker:goal:clear",
  "maker:goal:get-status",
  "maker:goal:pause",
  "maker:goal:resume",
  "maker:input:clear-error",
  "maker:input:clear-session",
  "maker:input:compact",
  "maker:input:enqueue",
  "maker:input:get-projection",
  "maker:input:move",
  "maker:input:remove",
  "maker:input:resume",
  "maker:input:retry-last-error",
  "maker:input:set-edit-lock",
  "maker:input:set-expanded",
  "maker:input:set-interaction-lock",
  "maker:input:steer",
  "maker:input:stop",
  "maker:input:update-content",
  "maker:input:update-text",
  "maker:mark-orca-role",
  "maker:message:delete",
  "maker:navigate-session-tree",
  "maker:open-session-in-new-window",
  "maker:open-session-in-new-window-if-dropped-outside",
  "maker:persist-turn-error-deferred",
  "maker:rewind:commit",
  "maker:rewind:preview",
  "maker:send",
  "maker:session-background-activity",
  "maker:session-background-tasks:list",
  "maker:session-background-tasks:stop",
  "maker:session-in-turn",
  "maker:session:disable-orca",
  "maker:session:enable-orca",
  "maker:session:turn-active",
  "maker:set-effort",
  "maker:set-extra-dirs",
  "maker:set-fast-mode",
  "maker:set-model",
  "maker:set-permission-mode",
  "maker:set-plan-mode",
  "maker:set-session-model-pref",
  "maker:set-thinking-enabled",
  "maker:set-writable-dirs",
  "maker:steer",
  "maker:switch-session-agent",
  "maker:team:end",
  "maker:turn-change-set:apply",
  "maker:turn-change-sets:get",
  "maker:turn-change-sets:list",
  "maker:worker:dispatch-ui-assignment",
  "maker:worker:list",
  "notification:clear-session-attention",
  "notification:mark-session-attention",
  "worktree:get-for-session",
  "worktree:removal-preview",
  "worktree:restore-for-session",
  "worktree:restore-status"
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sessionIds(value: unknown): string[] {
  const row = record(value);
  if (!row) return [];
  return [
    ...(Array.isArray(row.sessionIds) ? row.sessionIds : []),
    row.sessionId, row.parentSessionId, row.sourceSessionId, row.targetSessionId, record(row.session)?.id, record(row.message)?.sessionId,
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function retiredResource(value: unknown): boolean {
  const row = record(value);
  if (!row) return false;
  return ['bot', 'bot-group'].includes(String(row.kind))
    || ['bot', 'bot-group'].includes(String(row.resourceKind)) || row.source === 'bot'
    || ['teammates', 'bot-groups', 'routines'].includes(String(row.collectionId));
}
function retiredChannel(channel: string): boolean {
  return channel.startsWith('local-db:bots:') || channel.startsWith('maker:bot-')
    || channel.startsWith('maker:routines:') || channel.startsWith('routines:');
}
function unavailable(): never { throw new Error('[NOT_FOUND] Resource does not exist'); }

async function readAccess(ids: readonly string[], single: Lookup, batch: RemoteBotSessionBatchLookup | null) {
  if (batch) return batch(ids, 'session');
  const access = new Map<string, RemoteBotSessionAccess>();
  // Single adapters may make a DB RPC per ID; keep that fallback bounded.
  for (const id of ids) access.set(id, await single(id, 'session'));
  return access;
}

async function assertSessionIdsAllowed(ids: Iterable<string>): Promise<void> {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const activeLookup = lookup;
  const activeBatchLookup = batchLookup;
  if (!activeLookup) unavailable();
  const access = await readAccess(unique, activeLookup, activeBatchLookup);
  if (lookup !== activeLookup || batchLookup !== activeBatchLookup) unavailable();
  for (const id of unique) if ((access.get(id) ?? 'hidden') === 'hidden') unavailable();
}

/** Runs before execution and again before cached/queued reply delivery. */
export async function assertRemoteBotInvocationAllowed(args: unknown[], channel = ''): Promise<void> {
  if (retiredChannel(channel)) unavailable();
  for (const arg of args) {
    const row = record(arg);
    if (retiredResource(row) || retiredResource(row?.ref) || retiredResource(row?.resourceRef)) unavailable();
  }
  if (channel === 'maker:review:start') {
    const id = record(args[0])?.sourceSessionId;
    if (typeof id !== 'string' || !id.trim() || id.length > 512) {
      throw new Error('[INVALID_PARAMS] Invalid review source session ID');
    }
    await assertSessionIdsAllowed([id.trim()]);
    return;
  }
  if (channel === 'git-review:remote-op') {
    const id = record(record(args[0])?.payload)?.sessionId;
    if (typeof id !== 'string' || !id.trim() || id.length > 256) {
      throw new Error('[INVALID_PARAMS] Invalid review session ID');
    }
    await assertSessionIdsAllowed([id]);
    return;
  }
  if (channel === 'local-db:task-tags:execute') {
    const request = record(args[0]);
    const targets = request?.sessionIds;
    if (!request || args.length !== 1 || (
      targets !== undefined && (
        !Array.isArray(targets) || !targets.length || targets.length > 100 ||
        targets.some((id) => typeof id !== 'string' || !id.trim() || id.trim().length > 128)
      )
    ) || (['get', 'attach', 'detach'].includes(String(request.action)) && targets === undefined)) {
      throw new Error('[INVALID_PARAMS] Invalid task tag session IDs');
    }
    if (Array.isArray(targets)) await assertSessionIdsAllowed(targets.map((id: string) => id.trim()));
    return;
  }
  await assertSessionIdsAllowed(args.flatMap((arg, index) => [
    ...(index === 0 && POSITIONAL_SESSION_CHANNELS.has(channel)
      ? typeof arg === 'string' ? [arg] : Array.isArray(arg) ? arg.filter((id): id is string => typeof id === 'string') : []
      : []), ...sessionIds(arg),
  ]));
}

export async function projectRemoteSessionResult(channel: string, value: unknown): Promise<unknown> {
  if (retiredChannel(channel)) unavailable();
  if (![
    'local-db:task-tags:execute', 'local-db:sessions:get', 'local-db:sessions:get-many',
    'local-db:sessions:list', 'maker:list-active', 'local-db:sessions:interrupted-pending',
    'maker:remote-resources:get', 'maker:remote-resources:list', 'maker:remote-resources:manifest',
  ].includes(channel)) return value;
  const row = record(value);
  if (channel === 'local-db:task-tags:execute') {
    return row ? { ...row, sessions: await projectRemoteSessionResult('local-db:sessions:list', row.sessions) } : value;
  }
  if (channel === 'maker:remote-resources:manifest') {
    return row && Array.isArray(row.collections) ? { ...row, collections: row.collections.filter((item) => {
      const collection = record(item);
      return !retiredResource({ ...collection, collectionId: collection?.id });
    }) } : value;
  }
  const isResource = channel.startsWith('maker:remote-resources:');
  const hidden = (item: unknown) => retiredResource(item) || retiredResource(record(item)?.ref);
  const identity = (item: unknown): string | null => {
    const row = record(item);
    if (isResource) return null;
    const id = row?.id ?? row?.sessionId;
    return typeof id === 'string' ? id : null;
  };
  const projectItems = async (items: unknown[]): Promise<unknown[]> => {
    const activeLookup = lookup;
    const activeBatchLookup = batchLookup;
    const candidates = items.filter((item) => item !== null && !hidden(item));
    const ids = [...new Set(candidates.map(identity).filter((id): id is string => id !== null))];
    if (!ids.length) return candidates;
    if (!activeLookup) return candidates.filter((item) => identity(item) === null);
    const access = await readAccess(ids, activeLookup, activeBatchLookup);
    if (lookup !== activeLookup || batchLookup !== activeBatchLookup) unavailable();
    return candidates.filter((item) => {
      const id = identity(item);
      return id === null || (access.get(id) ?? 'hidden') !== 'hidden';
    });
  };
  if (Array.isArray(value)) return projectItems(value);
  if (row && !row.id && Array.isArray(row.sessions)) {
    return { ...row, sessions: await projectItems(row.sessions) };
  }
  if (row && Array.isArray(row.items)) {
    const items = await projectItems(row.items);
    return { ...row, items, ...(items.length !== row.items.length ? { revision: items.map((item) => record(item)?.revision ?? '').join('|') } : {}) };
  }
  const [projected] = await projectItems([value]);
  if (projected === undefined && channel.endsWith(':get')) unavailable();
  return projected ?? null;
}

/** Called at delivery, including buffered batches and offline replay. */
export async function projectRemoteBotPush(value: unknown, channel = ''): Promise<unknown | null> {
  const row = record(value);
  if (retiredChannel(channel) || retiredResource(row) || retiredResource(row?.ref) || retiredResource(row?.session)) return null;
  const ids = sessionIds(value);
  if (channel === 'local-db:sessions:created' && typeof row?.id === 'string') ids.push(row.id);
  try { await assertSessionIdsAllowed(ids); } catch { return null; }
  return value;
}

export function hasRemoteBotSessionLookup(): boolean { return lookup !== null; }
