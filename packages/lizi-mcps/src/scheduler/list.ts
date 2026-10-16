/**
 * scheduler/list.ts — schedule_list tool
 *
 * 透传 Scheduler.list(filter?) 返回值，与 maker.schedule.list() IPC 同形（plan
 * §C.6 硬规则：禁止 snake/camel 二次转换或裁字段，MCP / GUI 必须看到同一份数据）。
 */

import { z } from 'zod';
import type { Schedule } from '@cindy/maker-scheduler';

import { SCHEDULE_STATUS } from './_enums.js';
import { withScheduler } from './_shared.js';
import type { SchedulerMcpDeps } from '../types.js';
import type { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';

/** Keep complete local schedule records while matching user-recognizable fields. */
function filterSchedulesByText(rows: Schedule[], query: string | undefined): Schedule[] {
  const needle = query?.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((schedule) => [
    schedule.id, schedule.name, schedule.prompt, schedule.targetSessionId,
    schedule.workingDir, schedule.preRunHook?.command, schedule.scriptConfig?.command,
  ].some((value) => typeof value === 'string' && value.toLowerCase().includes(needle)));
}

export function registerScheduleListTool(
  registry: SchedulerToolRegistry,
  deps: SchedulerMcpDeps,
): void {
  registry.register({
    name: 'schedule_list',
    category: 'scheduler',
    description:
      '仅列出本机的定时任务（与本机 GUI 列表同源同形），不能据此判断其它电脑是否有定时任务。可按 status（active / paused / expired）和 query（名称、id、提示词、绑定任务 id、工作目录或脚本命令）筛选。返回 Schedule[] 完整字段（含 cron 表达式 / nextFireAt / lastFiredAt / notify 嵌套对象等）。',
    inputShape: {
      status: z
        .enum(SCHEDULE_STATUS)
        .optional()
        .describe('过滤指定状态；不传 = 返回全部'),
      query: z.string().max(512).optional()
        .describe('文本筛选（不区分大小写的子串匹配）；空白或不传 = 不按文本过滤。'),
    },
    handler: async ({ status, query }) =>
      withScheduler(deps, async (scheduler) =>
        filterSchedulesByText(await scheduler.list(status ? { status } : undefined), query),
      ),
  });
}
