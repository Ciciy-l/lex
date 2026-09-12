/**
 * useExperimentalFeatures — 实验功能开关，统一入口。
 *
 * 设计：
 * - 每个 feature 一个 boolean，默认全 off（实验功能必须显式 opt-in）
 * - localStorage key = 'experimental.<feature>'
 * - 同窗口组件实例走自定义事件同步；其它窗口走 storage 事件
 *
 * 新增 experimental feature 只需要：
 * 1. 在 EXPERIMENTAL_FEATURES 加一项
 * 2. 在 ExperimentalSection 里加一行 UI
 */

import { useCallback, useEffect, useState } from 'react';

export interface ExperimentalFeatureMeta {
  /** localStorage key 后缀，最终 key = 'experimental.<key>' */
  key: string;
  /** UI 显示的标题 */
  title: string;
  /** UI 显示的副标题/描述 */
  description: string;
  /** 启用后的"打开"按钮配置（可选 —— 不是所有 feature 都有独立入口） */
  openAction?: {
    label: string;
    /** hash 路由路径，例 '/maker-experimental' */
    routePath: string;
  };
}

/**
 * 实验功能注册表。新 feature 在这里追加一项即可。
 */
export const EXPERIMENTAL_FEATURES: ReadonlyArray<ExperimentalFeatureMeta> = [
  {
    key: 'teammates',
    title: 'Teammates',
    description: 'Show the Teammates workspace and related settings.',
  },
];

const KEY_PREFIX = 'experimental.';
const CHANGE_EVENT = 'experimental-feature-change';
const volatileFlags = new Map<string, boolean>();

function storageKey(featureKey: string): string {
  return `${KEY_PREFIX}${featureKey}`;
}

/** 同步读：给非 hook 路径用（例如条件渲染 sidebar 入口）。坏数据当默认值 false。 */
export function getExperimentalFlag(featureKey: string): boolean {
  try {
    const raw = localStorage.getItem(storageKey(featureKey));
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return false;
  } catch {
    return volatileFlags.get(featureKey) ?? false;
  }
}

function publishExperimentalFlagChange(featureKey: string): void {
  window.dispatchEvent(new CustomEvent<string>(CHANGE_EVENT, { detail: featureKey }));
}

/** 单 feature hook —— 返回 [enabled, setEnabled] 元组风格 */
export function useExperimentalFlag(featureKey: string): {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
} {
  const [enabled, setEnabledState] = useState<boolean>(() => getExperimentalFlag(featureKey));

  const setEnabled = useCallback(
    (next: boolean) => {
      setEnabledState(next);
      try {
        localStorage.setItem(storageKey(featureKey), String(next));
        volatileFlags.delete(featureKey);
      } catch {
        // localStorage 不可用时，当前窗口仍保留本次明确的用户选择。
        volatileFlags.set(featureKey, next);
      }
      publishExperimentalFlagChange(featureKey);
    },
    [featureKey],
  );

  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== storageKey(featureKey)) return;
      setEnabledState(getExperimentalFlag(featureKey));
    };
    window.addEventListener('storage', handler);
    const localHandler = (event: Event) => {
      const changedFeatureKey = event instanceof CustomEvent ? event.detail : null;
      if (changedFeatureKey !== featureKey) return;
      setEnabledState(getExperimentalFlag(featureKey));
    };
    window.addEventListener(CHANGE_EVENT, localHandler);
    return () => {
      window.removeEventListener('storage', handler);
      window.removeEventListener(CHANGE_EVENT, localHandler);
    };
  }, [featureKey]);

  return { enabled, setEnabled };
}
