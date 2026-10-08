// Bot group chat transactions (docs/product-rules/bot-group-chat.md).
// Group rows, memberships and the Bot-owned hidden group lanes change together.

import type Database from 'better-sqlite3';

import type {
  BotGroupsAppendMessageArgs,
  BotGroupsAppendMessageResult,
  BotGroupsArchiveLanesArgs,
  BotGroupsCreateArgs,
  BotGroupsCreatePlanArgs,
  BotGroupsCreatePlanResult,
  BotGroupsDeleteArgs,
  BotGroupsMarkSeenArgs,
  BotGroupsMutateArgs,
  BotGroupsMessageRow,
  BotGroupsRemovePlanStepArgs,
  BotGroupsSetMembersArgs,
  BotGroupsSetMembersResult,
  BotGroupsSettleStepArgs,
  BotGroupsSettleStepResult,
} from '../../client/tx/types.js';

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be a number`);
  return value;
}

function requireIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item, index) => requireString(item, `${field}.${index}`));
}

function assertActiveBots(db: Database.Database, botIds: readonly string[]): void {
  const read = db.prepare('SELECT status FROM bot_profiles WHERE id = ?');
  for (const botId of botIds) {
    const row = read.get(botId) as { status?: string } | undefined;
    if (!row) throw coded(`Bot ${botId} 不存在`, 'MEMBER_UNAVAILABLE');
    if (row.status !== 'active' && row.status !== 'paused') {
      throw coded(`Bot ${botId} 当前不可加入群聊`, 'MEMBER_UNAVAILABLE');
    }
  }
}

function optionalString(value: unknown, field: string): string | null {
  return value === undefined || value === null ? null : requireString(value, field);
}

function assertVisibleBots(db: Database.Database, botIds: readonly string[]): void {
  if (botIds.length === 0) return;
  const placeholders = botIds.map(() => '?').join(',');
  const profiles = db.prepare('SELECT id, status, hidden_at AS hiddenAt FROM bot_profiles WHERE id IN (' + placeholders + ')')
    .all(...botIds) as Array<{ id: string; status: string; hiddenAt: number | null }>;
  if (profiles.length !== botIds.length || profiles.some((profile) => profile.hiddenAt !== null || profile.status === 'archived')) {
    throw coded('群成员已不可见，请刷新后重试', 'PRECONDITION_FAILED');
  }
}

/** Recheck a remote resource snapshot inside the same SQLite transaction as a write. */
function assertGroupSnapshot(
  db: Database.Database,
  groupId: string,
  args: {
    expectedGroupUpdatedAt?: number;
    expectedMemberBotIds?: string[];
    expectedPlanId?: string;
    expectedPlanUpdatedAt?: number;
  },
): void {
  const group = db.prepare('SELECT id, updated_at AS updatedAt FROM bot_groups WHERE id = ?').get(groupId) as
    { id: string; updatedAt: number } | undefined;
  if (!group) throw coded('群聊不存在', 'NOT_FOUND');
  if (args.expectedGroupUpdatedAt !== undefined && group.updatedAt !== args.expectedGroupUpdatedAt) {
    throw coded('群聊已更新，请刷新后重试', 'PRECONDITION_FAILED');
  }
  if (args.expectedMemberBotIds !== undefined) {
    const current = (db.prepare('SELECT bot_id AS botId FROM bot_group_members WHERE group_id = ? ORDER BY position ASC')
      .all(groupId) as Array<{ botId: string }>).map((row) => row.botId);
    if (JSON.stringify(current) !== JSON.stringify(args.expectedMemberBotIds)) {
      throw coded('群成员已更新，请刷新后重试', 'PRECONDITION_FAILED');
    }
    const placeholders = args.expectedMemberBotIds.map(() => '?').join(',');
    if (placeholders) {
      const profiles = db.prepare('SELECT id, status, hidden_at AS hiddenAt FROM bot_profiles WHERE id IN (' + placeholders + ')')
        .all(...args.expectedMemberBotIds) as Array<{ id: string; status: string; hiddenAt: number | null }>;
      if (profiles.length !== args.expectedMemberBotIds.length || profiles.some((profile) => profile.hiddenAt !== null || profile.status === 'archived')) {
        throw coded('群成员已不可见，请刷新后重试', 'PRECONDITION_FAILED');
      }
    }
  }
  if (args.expectedPlanId !== undefined) {
    const plan = db.prepare('SELECT group_id AS groupId, updated_at AS updatedAt FROM bot_group_plans WHERE id = ?')
      .get(args.expectedPlanId) as { groupId: string; updatedAt: number } | undefined;
    if (!plan || plan.groupId !== groupId) throw coded('分工不属于此群', 'PRECONDITION_FAILED');
    if (args.expectedPlanUpdatedAt !== undefined && plan.updatedAt !== args.expectedPlanUpdatedAt) {
      throw coded('分工已更新，请刷新后重试', 'PRECONDITION_FAILED');
    }
  }
}

/** Lanes (`routeKey`) and, with a prefix, the group's 分工 Sessions (`<prefix><planId>`). */
function archiveLanes(
  db: Database.Database,
  routeKey: string,
  botIds: readonly string[] | null,
  at: number,
  planRouteKeyPrefix: string | null = null,
): string[] {
  const rows = db.prepare(`SELECT bot_id AS botId, session_id AS sessionId FROM bot_session_links
    WHERE role = 'group' AND archived_at IS NULL
      AND (route_key = ? OR (? IS NOT NULL AND substr(route_key, 1, length(?)) = ?))`)
    .all(routeKey, planRouteKeyPrefix, planRouteKeyPrefix, planRouteKeyPrefix) as Array<{
    botId: string;
    sessionId: string;
  }>;
  const targets = botIds ? rows.filter((row) => botIds.includes(row.botId)) : rows;
  const archiveLink = db.prepare('UPDATE bot_session_links SET archived_at = ? WHERE session_id = ?');
  const archiveSession = db.prepare(`UPDATE sessions SET status = 'archived', updated_at = ?
    WHERE id = ? AND status = 'active'`);
  for (const row of targets) {
    archiveLink.run(at, row.sessionId);
    archiveSession.run(at, row.sessionId);
  }
  return targets.map((row) => row.sessionId);
}

export function botGroupsCreate(db: Database.Database, args: BotGroupsCreateArgs): void {
  const groupId = requireString(args.groupId, 'groupId');
  const name = requireString(args.name, 'name');
  const botIds = requireIds(args.botIds, 'botIds');
  const now = requireNumber(args.now, 'now');
  db.transaction(() => {
    assertActiveBots(db, botIds);
    if (args.expectedMemberBotIds !== undefined && JSON.stringify(botIds) !== JSON.stringify(args.expectedMemberBotIds)) {
      throw coded('群成员已更新，请刷新后重试', 'PRECONDITION_FAILED');
    }
    if (args.expectedMemberBotIds !== undefined) {
      const placeholders = args.expectedMemberBotIds.map(() => '?').join(',');
      const profiles = db.prepare('SELECT hidden_at AS hiddenAt, status FROM bot_profiles WHERE id IN (' + placeholders + ')')
        .all(...args.expectedMemberBotIds) as Array<{ hiddenAt: number | null; status: string }>;
      if (profiles.length !== args.expectedMemberBotIds.length || profiles.some((profile) => profile.hiddenAt !== null || profile.status === 'archived')) {
        throw coded('群成员已不可见，请刷新后重试', 'PRECONDITION_FAILED');
      }
    }
    db.prepare(`INSERT INTO bot_groups (id, name, reply_mode, created_at, updated_at)
      VALUES (?, ?, 'all', ?, ?)`).run(groupId, name, now, now);
    const insert = db.prepare(`INSERT INTO bot_group_members
      (group_id, bot_id, position, last_seen_sequence, joined_at) VALUES (?, ?, ?, 0, ?)`);
    botIds.forEach((botId, position) => insert.run(groupId, botId, position, now));
  })();
}

export function botGroupsSetMembers(
  db: Database.Database,
  args: BotGroupsSetMembersArgs,
): BotGroupsSetMembersResult {
  const groupId = requireString(args.groupId, 'groupId');
  const botIds = requireIds(args.botIds, 'botIds');
  const routeKey = requireString(args.routeKey, 'routeKey');
  const planPrefix = optionalString(args.planRouteKeyPrefix, 'planRouteKeyPrefix');
  const now = requireNumber(args.now, 'now');
  return db.transaction(() => {
    const group = db.prepare('SELECT id FROM bot_groups WHERE id = ?').get(groupId);
    if (!group) throw coded('群聊不存在', 'NOT_FOUND');
    assertGroupSnapshot(db, groupId, args);
    const current = (db.prepare('SELECT bot_id AS botId FROM bot_group_members WHERE group_id = ?')
      .all(groupId) as Array<{ botId: string }>).map((row) => row.botId);
    const added = botIds.filter((botId) => !current.includes(botId));
    const removed = current.filter((botId) => !botIds.includes(botId));
    assertActiveBots(db, added);
    if (args.expectedMemberBotIds !== undefined) assertVisibleBots(db, added);
    const latest = db.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM bot_group_messages WHERE group_id = ?')
      .get(groupId) as { sequence: number };
    const remove = db.prepare('DELETE FROM bot_group_members WHERE group_id = ? AND bot_id = ?');
    for (const botId of removed) remove.run(groupId, botId);
    // New members start from the current tail: joining does not replay older history.
    const insert = db.prepare(`INSERT INTO bot_group_members
      (group_id, bot_id, position, last_seen_sequence, joined_at) VALUES (?, ?, ?, ?, ?)`);
    const reorder = db.prepare('UPDATE bot_group_members SET position = ? WHERE group_id = ? AND bot_id = ?');
    botIds.forEach((botId, position) => {
      if (added.includes(botId)) insert.run(groupId, botId, position, latest.sequence, now);
      else reorder.run(position, groupId, botId);
    });
    db.prepare('UPDATE bot_groups SET updated_at = ? WHERE id = ?').run(now, groupId);
    return { archivedSessionIds: archiveLanes(db, routeKey, removed, now, planPrefix) };
  })();
}

export function botGroupsDelete(db: Database.Database, args: BotGroupsDeleteArgs): { archivedSessionIds: string[] } {
  const groupId = requireString(args.groupId, 'groupId');
  const routeKey = requireString(args.routeKey, 'routeKey');
  const planPrefix = optionalString(args.planRouteKeyPrefix, 'planRouteKeyPrefix');
  const now = requireNumber(args.now, 'now');
  return db.transaction(() => {
    assertGroupSnapshot(db, groupId, args);
    const deleted = db.prepare('DELETE FROM bot_groups WHERE id = ?').run(groupId);
    if (deleted.changes !== 1) throw coded('群聊不存在', 'NOT_FOUND');
    const hasMediaRefs = Boolean(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_refs'",
    ).get());
    // The group and its attachment references are one deletion unit; members' own
    // Sessions keep theirs (bot-group-chat.md §3.1).
    if (hasMediaRefs) {
      db.prepare("DELETE FROM media_refs WHERE ref_kind = 'bot-group-attachment' AND ref_id = ?").run(groupId);
    }
    return { archivedSessionIds: archiveLanes(db, routeKey, null, now, planPrefix) };
  })();
}

export function botGroupsArchiveLanes(
  db: Database.Database,
  args: BotGroupsArchiveLanesArgs,
): { archivedSessionIds: string[] } {
  const routeKey = requireString(args.routeKey, 'routeKey');
  const botIds = args.botIds === null ? null : requireIds(args.botIds, 'botIds');
  const now = requireNumber(args.now, 'now');
  return db.transaction(() => ({ archivedSessionIds: archiveLanes(db, routeKey, botIds, now) }))();
}

/** Inside a transaction: idempotent per clientId, sequence = max + 1. */
function insertMessage(db: Database.Database, m: BotGroupsMessageRow): BotGroupsAppendMessageResult {
  const groupId = requireString(m.groupId, 'message.groupId');
  const group = db.prepare('SELECT id FROM bot_groups WHERE id = ?').get(groupId);
  if (!group) throw coded('群聊不存在', 'NOT_FOUND');
  if (m.clientId) {
    const existing = db.prepare(`SELECT id, sequence FROM bot_group_messages
      WHERE group_id = ? AND client_id = ?`).get(groupId, m.clientId) as
      { id: string; sequence: number } | undefined;
    if (existing) return { id: existing.id, sequence: existing.sequence, created: false };
  }
  const latest = db.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM bot_group_messages WHERE group_id = ?')
    .get(groupId) as { sequence: number };
  const sequence = latest.sequence + 1;
  const createdAt = requireNumber(m.createdAt, 'message.createdAt');
  db.prepare(`INSERT INTO bot_group_messages
    (id, group_id, sequence, kind, author_kind, author_bot_id, author_name, content,
     mentions_json, notice_code, client_id, plan_id, files_json, attachments_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(requireString(m.id, 'message.id'), groupId, sequence, m.kind, m.authorKind,
      m.authorBotId ?? null, m.authorName, m.content, m.mentionsJson, m.noticeCode ?? null,
      m.clientId ?? null, m.planId ?? null, m.filesJson ?? '[]', m.attachmentsJson ?? '[]', createdAt);
  db.prepare('UPDATE bot_groups SET updated_at = ? WHERE id = ?').run(createdAt, groupId);
  return { id: m.id, sequence, created: true };
}

export function botGroupsAppendMessage(
  db: Database.Database,
  args: BotGroupsAppendMessageArgs,
): BotGroupsAppendMessageResult {
  return db.transaction(() => {
    assertGroupSnapshot(db, args.message.groupId, args);
    return insertMessage(db, args.message);
  })();
}

/** Advance a member's delivery cursor only after the corresponding turn was accepted.
 * The cursor is a group-owned write, so remote callers must use the same transaction
 * snapshot/dispatch guard as other group mutations.
 */
export function botGroupsMarkSeen(db: Database.Database, args: BotGroupsMarkSeenArgs): void {
  const groupId = requireString(args.groupId, 'groupId');
  const botId = requireString(args.botId, 'botId');
  const deliveredThrough = requireNumber(args.deliveredThrough, 'deliveredThrough');
  db.transaction(() => {
    assertGroupSnapshot(db, groupId, args);
    db.prepare(`UPDATE bot_group_members
      SET last_seen_sequence = ?
      WHERE group_id = ? AND bot_id = ? AND last_seen_sequence < ?`)
      .run(deliveredThrough, groupId, botId, deliveredThrough);
  })();
}

/** Small guarded mutations that cannot be expressed through a plain drizzle write. */
export function botGroupsMutate(db: Database.Database, args: BotGroupsMutateArgs): { updated: boolean } {
  const groupId = requireString(args.groupId, 'groupId');
  const now = requireNumber(args.now, 'now');
  return db.transaction(() => {
    assertGroupSnapshot(db, groupId, args);
    if (args.kind === 'update-group') {
      const patch = args.patch ?? {};
      const assignments: string[] = [];
      const values: unknown[] = [];
      if (patch.name !== undefined) { assignments.push('name = ?'); values.push(requireString(patch.name, 'patch.name')); }
      if (patch.replyMode !== undefined) { assignments.push('reply_mode = ?'); values.push(patch.replyMode); }
      if (patch.speakingMode !== undefined) { assignments.push('speaking_mode = ?'); values.push(patch.speakingMode); }
      if (patch.organizerBotId !== undefined) { assignments.push('organizer_bot_id = ?'); values.push(patch.organizerBotId); }
      if (patch.projectDir !== undefined) { assignments.push('project_dir = ?'); values.push(patch.projectDir); }
      if (assignments.length === 0) throw coded('没有可保存的群设置', 'INVALID_PARAMS');
      assignments.push('updated_at = ?'); values.push(now, groupId);
      const result = db.prepare(`UPDATE bot_groups SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
      return { updated: result.changes === 1 };
    }
    const planId = requireString(args.planId, 'planId');
    if (args.kind === 'update-plan-workdir') {
      const workDir = requireString(args.workDir, 'workDir');
      const branch = args.branch ?? null;
      const changed = db.prepare('UPDATE bot_group_plans SET work_dir = ?, branch = ?, updated_at = ? WHERE id = ? AND group_id = ?')
        .run(workDir, branch, now, planId, groupId);
      return { updated: changed.changes === 1 };
    }
    const plan = db.prepare('SELECT group_id AS groupId, status, current_step AS currentStep FROM bot_group_plans WHERE id = ?')
      .get(planId) as { groupId: string; status: string; currentStep: number | null } | undefined;
    if (!plan || plan.groupId !== groupId) throw coded('分工不属于此群', 'PRECONDITION_FAILED');
    if (args.kind === 'begin-step') {
      const position = requireNumber(args.position, 'position');
      if (args.expectedPlanStatus !== undefined && plan.status !== args.expectedPlanStatus) return { updated: false };
      const step = db.prepare('SELECT status FROM bot_group_plan_steps WHERE plan_id = ? AND position = ?').get(planId, position) as { status: string } | undefined;
      const allowedStepStatuses = plan.status === 'waiting' ? ['pending', 'failed', 'done'] : ['pending', 'failed'];
      if (!step || !allowedStepStatuses.includes(step.status)) return { updated: false };
      db.prepare("UPDATE bot_group_plans SET status = 'running', current_step = ?, updated_at = ? WHERE id = ?")
        .run(position, now, planId);
      db.prepare("UPDATE bot_group_plan_steps SET status = 'running', started_at = ?, finished_at = NULL WHERE plan_id = ? AND position = ?")
        .run(now, planId, position);
      return { updated: true };
    }
    if (args.kind === 'dismiss-plan') {
      const changed = db.prepare("UPDATE bot_group_plans SET status = 'dismissed', updated_at = ? WHERE id = ? AND status = 'proposed'")
        .run(now, planId);
      return { updated: changed.changes === 1 };
    }
    if (args.kind === 'stop-plan') {
      db.prepare("UPDATE bot_group_plan_steps SET status = 'pending', finished_at = NULL WHERE plan_id = ? AND status = 'running'")
        .run(planId);
      const changed = db.prepare("UPDATE bot_group_plans SET status = 'stopped', updated_at = ? WHERE id = ? AND status IN ('running', 'waiting')")
        .run(now, planId);
      return { updated: changed.changes === 1 };
    }
    if (args.kind === 'reassign-step') {
      const position = requireNumber(args.position, 'position');
      const botId = requireString(args.botId, 'botId');
      const botName = requireString(args.botName, 'botName');
      assertActiveBots(db, [botId]);
      const statuses = plan.status === 'proposed' ? ['pending'] : ['pending', 'failed'];
      const marks = statuses.map(() => '?').join(',');
      const changed = db.prepare(`UPDATE bot_group_plan_steps SET bot_id = ?, bot_name = ? WHERE plan_id = ? AND position = ? AND status IN (${marks})`)
        .run(botId, botName, planId, position, ...statuses);
      return { updated: changed.changes === 1 };
    }
    throw coded('未知群聊变更', 'INVALID_PARAMS');
  })();
}

export function botGroupsCreatePlan(
  db: Database.Database,
  args: BotGroupsCreatePlanArgs,
): BotGroupsCreatePlanResult {
  const planId = requireString(args.plan.id, 'plan.id');
  const groupId = requireString(args.plan.groupId, 'plan.groupId');
  const now = requireNumber(args.now, 'now');
  if (!Array.isArray(args.steps) || args.steps.length === 0) throw new Error('steps must not be empty');
  if (args.message.groupId !== groupId || args.message.planId !== planId) throw new Error('message must belong to the plan');
  return db.transaction(() => {
    assertGroupSnapshot(db, groupId, args);
    const superseded = (db.prepare(`SELECT id FROM bot_group_plans WHERE group_id = ? AND status = 'proposed'`)
      .all(groupId) as Array<{ id: string }>).map((row) => row.id);
    // A running or waiting plan must end first; the service never proposes over one.
    const open = db.prepare(`SELECT 1 FROM bot_group_plans
      WHERE group_id = ? AND status IN ('running', 'waiting')`).get(groupId);
    if (open) throw coded('群里还有没结束的分工', 'PLAN_OPEN');
    db.prepare(`UPDATE bot_group_plans SET status = 'superseded', updated_at = ?
      WHERE group_id = ? AND status = 'proposed'`).run(now, groupId);
    db.prepare(`INSERT INTO bot_group_plans
      (id, group_id, status, request_text, attachments_json, organizer_bot_id, organizer_name, current_step,
       work_dir, branch, created_at, updated_at)
      VALUES (?, ?, 'proposed', ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`)
      .run(planId, groupId, requireString(args.plan.requestText, 'plan.requestText'),
        args.plan.attachmentsJson ?? '[]',
        requireString(args.plan.organizerBotId, 'plan.organizerBotId'),
        requireString(args.plan.organizerName, 'plan.organizerName'), now, now);
    const insertStep = db.prepare(`INSERT INTO bot_group_plan_steps
      (plan_id, position, bot_id, bot_name, task, status, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL)`);
    args.steps.forEach((step, position) => insertStep.run(planId, position,
      requireString(step.botId, `steps.${position}.botId`),
      requireString(step.botName, `steps.${position}.botName`),
      requireString(step.task, `steps.${position}.task`)));
    const appended = insertMessage(db, args.message);
    return { messageId: appended.id, sequence: appended.sequence, supersededPlanIds: superseded };
  })();
}

export function botGroupsSettleStep(
  db: Database.Database,
  args: BotGroupsSettleStepArgs,
): BotGroupsSettleStepResult {
  const planId = requireString(args.planId, 'planId');
  const position = requireNumber(args.position, 'position');
  const now = requireNumber(args.now, 'now');
  return db.transaction(() => {
    const plan = db.prepare('SELECT status, current_step AS currentStep FROM bot_group_plans WHERE id = ?')
      .get(planId) as { status: string; currentStep: number | null } | undefined;
    if (!plan || plan.status !== args.expectedPlanStatus || plan.currentStep !== position) return { settled: false };
    const planGroup = db.prepare('SELECT group_id AS groupId FROM bot_group_plans WHERE id = ?').get(planId) as { groupId: string } | undefined;
    if (!planGroup) return { settled: false };
    assertGroupSnapshot(db, planGroup.groupId, { ...args, expectedPlanId: planId });
    const posted = args.message ? insertMessage(db, args.message) : null;
    // A finished step's hand-off is what later steps read; a failure keeps the previous one.
    db.prepare(`UPDATE bot_group_plan_steps
      SET status = ?, finished_at = ?,
          result_message_id = CASE WHEN ? = 'done' AND ? IS NOT NULL THEN ? ELSE result_message_id END
      WHERE plan_id = ? AND position = ?`)
      .run(args.stepStatus, now, args.stepStatus, posted?.id ?? null, posted?.id ?? null, planId, position);
    db.prepare('UPDATE bot_group_plans SET status = ?, updated_at = ? WHERE id = ?')
      .run(args.planStatus, now, planId);
    if (args.endMessage) insertMessage(db, args.endMessage);
    return { settled: true };
  })();
}

/** Proposed plans only; renumbers the following steps and keeps at least one. */
export function botGroupsRemovePlanStep(
  db: Database.Database,
  args: BotGroupsRemovePlanStepArgs,
): { removed: boolean } {
  const planId = requireString(args.planId, 'planId');
  const position = requireNumber(args.position, 'position');
  const now = requireNumber(args.now, 'now');
  return db.transaction(() => {
    const plan = db.prepare('SELECT group_id AS groupId, status, updated_at AS updatedAt FROM bot_group_plans WHERE id = ?').get(planId) as { groupId: string; status: string; updatedAt: number } | undefined;
    if (!plan || plan.status !== 'proposed') return { removed: false };
    assertGroupSnapshot(db, plan.groupId, { ...args, expectedPlanId: planId, expectedPlanUpdatedAt: args.expectedPlanUpdatedAt });
    const count = db.prepare('SELECT COUNT(*) AS n FROM bot_group_plan_steps WHERE plan_id = ?').get(planId) as { n: number };
    if (count.n <= 1) return { removed: false };
    const deleted = db.prepare('DELETE FROM bot_group_plan_steps WHERE plan_id = ? AND position = ?').run(planId, position);
    if (deleted.changes !== 1) return { removed: false };
    // Two passes keep the (plan_id, position) key unique while shifting.
    db.prepare(`UPDATE bot_group_plan_steps SET position = -position WHERE plan_id = ? AND position > ?`).run(planId, position);
    db.prepare(`UPDATE bot_group_plan_steps SET position = -position - 1 WHERE plan_id = ? AND position < 0`).run(planId);
    db.prepare('UPDATE bot_group_plans SET updated_at = ? WHERE id = ?').run(now, planId);
    return { removed: true };
  })();
}
