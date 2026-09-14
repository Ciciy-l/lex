/**
 * agentVendors —— 「用户可选的 Agent 引擎(harness)」列表,纯数据。
 *
 * 放在 lib 而不是组件层:state(newMakerDraft 的 localStorage 校验)也要用它,
 * 而 state 不能反向依赖组件。展示元数据(名称 / 品牌 mark)在
 * `components/new-chat/agentOptions.ts`,由本表派生并用类型强制补齐。
 *
 * 顺序即展示顺序。**新增引擎只改这一行**:选择器会自动多出条目,
 * localStorage 校验也会自动放行(否则用户选中新引擎、重启后会被静默重置)。
 *
 * 注意 MakerVendor 还含 'orca',但它不是用户可选的引擎(已被 ChatInput 底部的
 * 协同 toggle 取代),故不在此表内。
 */

import type { MakerVendor } from './ccAgent.types';

// 注意:本表不含 'omp'——T01 阶段 OMP 不进入用户可选的引擎下拉(见规则:
// 不要把手 agent 加进任何用户可见的选项数组,AGENT_OPTIONS / 新建会话 picker 等 UI
// 本阶段不暴露 OMP;其产品默认 tuple 也尚未就绪)。'orca' 同理(已被协同 toggle 取代)。
export const SELECTABLE_VENDORS = ['cc', 'codex', 'pi'] as const satisfies readonly MakerVendor[];

export type SelectableVendor = (typeof SELECTABLE_VENDORS)[number];

/** localStorage / IPC 等外部输入的引擎值校验(不认识的一律交给调用方回退默认)。 */
export function isSelectableVendor(value: unknown): value is SelectableVendor {
  return typeof value === 'string' && (SELECTABLE_VENDORS as readonly string[]).includes(value);
}
