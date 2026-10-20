/**
 * useSessionTokens — 订阅当前 session 的"终身累计 token"。
 *
 * Codex 订阅模式没有 per-session USD 实报，tooltip 使用 token 累计辅助解释
 * 每条消息的价值估算。先订阅推送，再补拉权威累计，避免 GUI/TUI 切换
 * 重新挂载时漏掉已完成轮次；补拉期间的实时推送优先。
 */

import { useEffect, useState } from 'react';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import { getSessionFor } from '@/lib/makerTransport';

export function useSessionTokens(
  sessionId: string | undefined,
  initialTokens: number | null | undefined,
): number | null {
  const [tokens, setTokens] = useState<number | null>(
    typeof initialTokens === 'number' ? initialTokens : null,
  );

  useEffect(() => {
    setTokens(typeof initialTokens === 'number' ? initialTokens : null);
    // 同一任务后到的旧首屏快照不能覆盖实时累计。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 初值只拥有首屏
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const owner = getDataOwnerGeneration();
    let cancelled = false, receivedCurrentEvent = false;
    const apply = (total: number | null | undefined) => {
      if (!cancelled && isDataOwnerGenerationCurrent(owner)) {
        setTokens(typeof total === 'number' ? total : null);
      }
    };
    const unsubscribe = window.electronAPI.onUsageSessionTokensChanged?.((res, ownerStamp) => {
      if (!isDataOwnerGenerationCurrent(owner) || !isDataOwnerPushCurrent(ownerStamp)) return;
      if (res.sessionId === sessionId) {
        receivedCurrentEvent = true;
        apply(res.totalTokens);
      }
    });
    void getSessionFor(sessionId).then(session => {
      if (!receivedCurrentEvent) apply(session.totalTokenUsage);
    }).catch(() => {
      // 保留初值和实时推送；离线补拉不阻断任务。
    });
    return () => { cancelled = true; unsubscribe?.(); };
  }, [sessionId]);

  return tokens;
}
