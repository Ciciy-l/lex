import type { PermissionModeDescriptor } from '../../types/capabilities.js';
import type { PermissionMode } from '../../types/common.js';

/**
 * OMP 的三档静态 tier 门（上游 `tools.approvalMode` / `--approval-mode`）。
 *
 * 注意两条与安全强相关的事实（PRD §3.3、spike §9.3 真机实证）：
 * - 上游**默认值是 `yolo`**（全放行），所以调用方必须显式传档位，绝不能省略。
 * - `always-ask` **仍然自动放行 read tier**，因此"Lex 的 ask"不等于"每个工具都问"；
 *   UI 文案不得宣称"已受 Lex 保护"。
 */
export type OmpApprovalMode = 'always-ask' | 'write' | 'yolo';

export const OMP_APPROVAL_MODES: readonly OmpApprovalMode[] = [
  'always-ask',
  'write',
  'yolo',
];

/**
 * fail-closed 回落值。任何解析失败、未知档位、缺失档位都落到这里 ——
 * 代码库中**不存在**"解析失败 → yolo"的路径。
 */
export const OMP_FALLBACK_APPROVAL_MODE: OmpApprovalMode = 'always-ask';

/** OMP 只暴露这三档；`default` / `acceptEdits` / `plan` 无对应上游语义，不声明。 */
type MappablePermissionMode = 'ask' | 'auto' | 'bypassPermissions';

const MAPPABLE_PERMISSION_MODES: readonly MappablePermissionMode[] = [
  'ask',
  'auto',
  'bypassPermissions',
];

export const OMP_SUPPORTED_PERMISSION_MODES: readonly PermissionMode[] =
  MAPPABLE_PERMISSION_MODES;

/** 显式表驱动映射（PRD §5.2 唯一权威），禁止按字符串巧合做等价。 */
const PERMISSION_MODE_TO_APPROVAL: Readonly<
  Record<MappablePermissionMode, OmpApprovalMode>
> = Object.freeze({
  ask: 'always-ask',
  auto: 'write',
  bypassPermissions: 'yolo',
});

export interface OmpApprovalTierPolicy {
  /** true = OMP 自动放行该 tier；false = 每次询问。 */
  readonly read: boolean;
  readonly write: boolean;
  readonly exec: boolean;
}

/** 三档 × 三 tier 的真实放行矩阵（PRD §3.3）。read 在任何档位都自动放行。 */
export const OMP_APPROVAL_TIERS: Readonly<
  Record<OmpApprovalMode, OmpApprovalTierPolicy>
> = Object.freeze({
  'always-ask': Object.freeze({ read: true, write: false, exec: false }),
  write: Object.freeze({ read: true, write: true, exec: false }),
  yolo: Object.freeze({ read: true, write: true, exec: true }),
});

const READ_TIER_NOTE = 'Read-only tools are always auto-approved by OMP';

/** 供 `OmpAgent.capabilities.permissionModes` 直接引用（i18n 只做翻译层）。 */
export const OMP_PERMISSION_MODES: readonly PermissionModeDescriptor[] =
  Object.freeze([
    Object.freeze({
      id: 'ask',
      displayName: 'Ask permissions',
      description: `Asks before file edits and commands. ${READ_TIER_NOTE}`,
    }),
    Object.freeze({
      id: 'auto',
      displayName: 'Auto',
      description: `Auto-approves file edits, asks before running commands. ${READ_TIER_NOTE}`,
    }),
    Object.freeze({
      id: 'bypassPermissions',
      displayName: 'Bypass permissions',
      description:
        'Approves edits and commands without asking. Read-only tools are always auto-approved by OMP; explicit deny rules and dangerous-command overrides still apply',
    }),
  ]);

export function isOmpApprovalMode(value: unknown): value is OmpApprovalMode {
  return (
    typeof value === 'string' &&
    (OMP_APPROVAL_MODES as readonly string[]).includes(value)
  );
}

export function isOmpPermissionModeSupported(mode: unknown): boolean {
  return (
    typeof mode === 'string' &&
    (OMP_SUPPORTED_PERMISSION_MODES as readonly string[]).includes(mode)
  );
}

export interface OmpApprovalResolution {
  /** 解析后的 OMP 档位，永不为 undefined。 */
  readonly approvalMode: OmpApprovalMode;
  /** 调用方传入的原始值（用于脱敏日志；非字符串时为 undefined）。 */
  readonly requested: string | undefined;
  /** false = 未命中显式表，已按 fail-closed 回落。 */
  readonly matched: boolean;
}

/**
 * Lex 权限档位 → OMP `--approval-mode`。
 *
 * 详尽 fail-closed：非字符串、未知档位、未暴露档位（`acceptEdits`/`default`/`plan`）
 * 一律回落 `always-ask`。**绝不**回落到 `yolo`。
 */
export function resolveOmpApprovalMode(mode: unknown): OmpApprovalResolution {
  if (!isOmpPermissionModeSupported(mode))
    return Object.freeze({
      approvalMode: OMP_FALLBACK_APPROVAL_MODE,
      requested: typeof mode === 'string' ? mode : undefined,
      matched: false,
    });
  const key = mode as MappablePermissionMode;
  return Object.freeze({
    approvalMode: PERMISSION_MODE_TO_APPROVAL[key],
    requested: key,
    matched: true,
  });
}

/** 便捷包装：只要档位本身。 */
export function toOmpApprovalMode(mode: unknown): OmpApprovalMode {
  return resolveOmpApprovalMode(mode).approvalMode;
}

/** 直接校验一个 OMP 档位字面量；非法值同样 fail-closed 到 `always-ask`。 */
export function normalizeOmpApprovalMode(value: unknown): OmpApprovalMode {
  return isOmpApprovalMode(value) ? value : OMP_FALLBACK_APPROVAL_MODE;
}
