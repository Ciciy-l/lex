/**
 * userPromptStore — 用户级 system prompt 的本地持久化层（纯 TS，0 React 依赖）。
 * ---------------------------------------------------------------------------
 * 设计取舍：
 *   - 不上服务器（隐私 + server 端没有 push 同步能力）。
 *   - 用 localStorage 落 `userData/Local Storage/`，重启不丢；跟 useTheme/
 *     useNotificationSettings 同源存储位置。
 *   - **不绑 React** —— 任何 renderer 路径都可以 `getUserPrompt()` 同步取值
 *     （例如 ChatInput 启 session 时透传），不需要 hook context。
 *   - hook (`useUserPrompt`) 是上层薄包装，订阅本 store 的变化。
 *
 * 跨进程：localStorage 仅 renderer 可达，main 进程的 maker-host 拿不到。
 * Agent 注入走「renderer 启 session 时透传 userPrompt 到 IPC」 ——
 * 跟 model/effort 完全同模式，main 不需要知道 storage 实现。
 */

import { USER_PROMPT_MAX_LENGTH } from './userPrompt.constants';

export const PROMPT_ENGINES = ['claude-code', 'codex', 'pi', 'omp'] as const;
export type PromptEngine = (typeof PROMPT_ENGINES)[number];
export type PromptScope = 'common' | PromptEngine;
const STORAGE_KEY_PREFIX = 'userPrompt.value';
const LEGACY_STORAGE_KEY = STORAGE_KEY_PREFIX;
let activeOwnerId: string | null = null;
export function getUserPromptOwner(): string | null {
  return activeOwnerId;
}

function storageKey(scope: PromptScope = 'common'): string {
  const base = `${STORAGE_KEY_PREFIX}.${activeOwnerId ?? 'signed-out'}`;
  return scope === 'common' ? base : `${base}.engine.${scope}`;
}

function migrateLegacyPrompt(ownerId: string): void {
  try {
    const scopedKey = `${STORAGE_KEY_PREFIX}.${ownerId}`;
    if (localStorage.getItem(scopedKey) !== null) return;
    const legacyValue = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyValue === null) return;
    localStorage.setItem(scopedKey, legacyValue);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // localStorage 不可用时保留现有的空值回退语义。
  }
}

/** Select the owner namespace used by this renderer's personal prompt cache. */
export function setUserPromptOwner(ownerId: string | null): void {
  if (activeOwnerId === ownerId) return;
  activeOwnerId = ownerId;
  if (ownerId) migrateLegacyPrompt(ownerId);
  const value = getUserPrompt();
  subscribers.forEach((cb) => cb(value));
}

type Subscriber = (value: string) => void;
const subscribers = new Set<Subscriber>();

/** 同步读 —— 给 hook 之外路径用（ChatInput 启 session 时透传等）。坏数据兜底空串。 */
export function getUserPrompt(scope: PromptScope = 'common'): string {
  try {
    const raw = localStorage.getItem(storageKey(scope));
    return typeof raw === 'string' ? raw : '';
  } catch {
    return '';
  }
}

/** 同步写 —— 落盘 + 通知本 tab 内所有 subscriber（storage 事件本身不会触发当前 tab）。 */
export function getEffectiveUserPrompt(engine: string): string {
  const extra = PROMPT_ENGINES.includes(engine as PromptEngine)
    ? getUserPrompt(engine as PromptEngine)
    : '';
  return [getUserPrompt(), extra].filter(Boolean).join('\n\n');
}

/** Validate the composed prompt, including every engine when editing the common part. */
export function userPromptFits(scope: PromptScope, next: string): boolean {
  return PROMPT_ENGINES.every((engine) => {
    const common = scope === 'common' ? next : getUserPrompt();
    const extra = scope === engine ? next : getUserPrompt(engine);
    return [common, extra].filter(Boolean).join('\n\n').length <= USER_PROMPT_MAX_LENGTH;
  });
}

export function setUserPrompt(
  next: string,
  scope: PromptScope = 'common',
  expectedOwner = activeOwnerId,
): void {
  if (expectedOwner !== activeOwnerId) throw new Error('USER_PROMPT_OWNER_CHANGED');
  if (!userPromptFits(scope, next)) throw new Error('USER_PROMPT_TOO_LONG');
  // Surface storage failures to the editor; never announce a save that did not persist.
  if (next) localStorage.setItem(storageKey(scope), next);
  else localStorage.removeItem(storageKey(scope));
  subscribers.forEach((cb) => cb(getUserPrompt()));
}

/** 订阅变化 —— hook 用，也可以给非 React 路径用。返回 unsubscribe。 */
export function subscribeUserPrompt(cb: Subscriber): () => void {
  subscribers.add(cb);

  // 监听跨实例 storage 事件（多窗口兜底；Electron 单窗口下几乎不触发）。
  const storageHandler = (e: StorageEvent) => {
    if (
      e.key !== null &&
      e.key !== storageKey() &&
      !PROMPT_ENGINES.some((engine) => e.key === storageKey(engine))
    )
      return;
    cb(getUserPrompt());
  };
  window.addEventListener('storage', storageHandler);

  return () => {
    subscribers.delete(cb);
    window.removeEventListener('storage', storageHandler);
  };
}
