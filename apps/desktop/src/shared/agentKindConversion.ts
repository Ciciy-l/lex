/**
 * agentKindConversion —— DB/renderer 形态('cc' | 'codex' | 'pi' | 'omp')与 maker-core
 * 形态('claude-code' | 'codex' | 'pi' | 'omp')的唯一双向映射。
 *
 * 背景:sessions.agent_kind 历史上存 renderer 形态('cc' 起家,default 'cc'),
 * maker-core 用 'claude-code'。三值化前全仓散落 `x === 'cc' ? 'claude-code' :
 * 'codex'` 这类二元 ternary —— pi 进来后每一处都会把 pi 误判成另一家。
 * 一律改走本模块;新增 agent 只改这里。
 */

/** DB(sessions.agent_kind)与 renderer 侧的 agent 形态。 */
export type DbAgentKind = 'cc' | 'codex' | 'pi' | 'omp';
/** maker-core / IPC 契约侧的 agent 形态。 */
export type MakerAgentKindWire = 'claude-code' | 'codex' | 'pi' | 'omp';

/** Runtime allow-list for untrusted IPC payloads that carry a Maker agent kind. */
const MAKER_AGENT_KINDS: readonly MakerAgentKindWire[] = ['claude-code', 'codex', 'pi', 'omp'];

export function isMakerAgentKind(value: unknown): value is MakerAgentKindWire {
  return typeof value === 'string' && (MAKER_AGENT_KINDS as readonly string[]).includes(value);
}

export function dbToMakerAgentKind(db: string | null | undefined): MakerAgentKindWire {
  if (db === 'codex') return 'codex';
  if (db === 'pi') return 'pi';
  if (db === 'omp') return 'omp';
  return 'claude-code'; // 'cc' 与历史缺省
}

export function makerToDbAgentKind(maker: string | null | undefined): DbAgentKind {
  if (maker === 'codex') return 'codex';
  if (maker === 'pi') return 'pi';
  if (maker === 'omp') return 'omp';
  return 'cc'; // 'claude-code' 与历史缺省
}

/** 宽输入归一成 DbAgentKind;非法值回落 'cc'(与 sessions 表 default 同语义)。 */
export function normalizeDbAgentKind(value: string | null | undefined): DbAgentKind {
  return value === 'codex' || value === 'pi' || value === 'omp' ? value : 'cc';
}

/**
 * Neutral human-readable name for an engine identity. This accepts both the
 * persisted DB spelling (`cc`) and the Maker wire spelling (`claude-code`),
 * plus historical/untrusted values so display-only callers do not need to
 * duplicate a three-branch fallback. Unknown legacy values retain the old
 * Claude Code presentation rather than inventing a new persisted identity.
 */
export function agentKindDisplayLabel(value: unknown): string {
  if (value === 'codex') return 'Codex';
  if (value === 'pi') return 'Pi';
  if (value === 'omp') return 'OMP';
  return 'Claude Code';
}
