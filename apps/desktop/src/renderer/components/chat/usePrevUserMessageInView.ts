/**
 * usePrevUserMessageInView
 * ---------------------------------------------------------------------------
 * 计算并按用户意图调控"上一条提问 chip"应该显示哪个 user 消息的 clientId。
 *
 * 四态合并(最终 displayId 给 chip):
 *   1. computedId — 几何计算结果:viewport 之上、距离顶端最近的 user 消息
 *      (用 rect.bottom < viewport.top + 8 判定,即"完全滚出视区"才算)
 *   2. suppressedAfterClick — 用户刚点过 chip 跳转后置 true,直到用户再次
 *      产生**主动滚动意图**(wheel / touch / 方向键 / PageUp 等)才解。
 *      这里不能用"下一次 scroll 事件"解,因为 scrollIntoView 的 smooth
 *      动画自身会持续派发若干 scroll 事件,会被误当成"用户上滑"立刻打开
 *      chip(用户刚跳过去就立马提示下一个,体验恶心)。
 *   3. idleHidden — chip 已显示且 IDLE_HIDE_MS 内没有任何 scroll → 自动
 *      隐藏。任何 scroll 事件再次触发就立刻取消隐藏。
 *   4. scrollingDown — 最后一次 scroll 方向是向下(scrollTop 增大) → 隐藏。
 *      用户朝最新消息走的时候不该提示"回看上一条提问",这是反直觉的。
 *      方向状态保持到下次反向 scroll(向上)才翻回 false。1px 噪声阈值。
 *
 *   displayId = (suppressed || idleHidden || scrollingDown) ? null : computedId
 *
 * Chip 隐藏时(任意原因)父组件以 visible=false 渲染,chip 自身已经把
 * pointer-events 收掉,不挡下方真实气泡的点击 — 用户无感。
 *
 * 量测只读取有序消息的外层盒，并二分定位视口边界。历史窗口会随上翻继续
 * 扩大，不能假设 user 消息永远 ≤100，更不能每帧反向测量全部屏幕外子树。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useNavigationKeyListener } from './useNavigationKeyListener';
import { findPreviousUserMessage } from './messageScrollGeometry';

// 触发阈值 — 消息底边必须高出 viewport 顶端至少 TOP_FUDGE_PX 才算"已滚过"。
// 用 bottom 而不是 top:点击 chip 跳转后,scrollIntoView 把目标 top 贴到
// viewport 顶,如果用 top 判会让目标自己仍然算"在上方" → chip 切换到再上一条
// 还是同样问题。改用 bottom 后,跳转完成的瞬间目标的 bottom 在 viewport 内 →
// 不算上方 → 几何上没有"上一条目标"了(或者切到再上一条,但有 suppressedAfterClick
// 兜底所以都不会显示)。
const TOP_FUDGE_PX = 8;

// 空闲自动隐藏 — 用户上滑停下后这么久没动,chip 淡出让位给阅读。再有滑动
// 立即恢复。3000 与 useIssues.ts MIN_INTERVAL_MS / IssueCreateView 同款。
const IDLE_HIDE_MS = 3000;

// scroll 方向判断的死区 — 1px 内的 scrollTop 变化不算方向,避免硬件抖动。
const DIRECTION_DEAD_ZONE_PX = 1;

type ScrollRef = { readonly current: HTMLDivElement | null };

export function usePrevUserMessageInView({
  scrollRef,
  userMessageIds,
  resetKey,
}: {
  scrollRef: ScrollRef;
  userMessageIds: string[];
  resetKey?: string;
}): {
  /** 最终给 chip 的目标 id;null 时 chip 隐藏(三种原因任一都返回 null)。 */
  displayId: string | null;
  /** 父组件在 chip onClick 里调一次,进入 suppressedAfterClick 状态。 */
  suppressAfterClick: () => void;
} {
  const [computedId, setComputedId] = useState<string | null>(null);
  const [suppressed, setSuppressed] = useState(false);
  const [idleHidden, setIdleHidden] = useState(false);
  const [scrollingDown, setScrollingDown] = useState(false);

  const rafRef = useRef<number | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef<number>(0);
  const idsRef = useRef<{ source: string[]; allowed: ReadonlySet<string> } | null>(null);
  if (idsRef.current?.source !== userMessageIds) {
    idsRef.current = { source: userMessageIds, allowed: new Set(userMessageIds) };
  }

  // 切 session 全部 reset,防止旧目标 / 旧抑制 / 旧 idle / 旧方向残留
  useEffect(() => {
    setComputedId(null);
    setSuppressed(false);
    setIdleHidden(false);
    setScrollingDown(false);
    lastScrollTopRef.current = 0;
  }, [resetKey]);

  const compute = useCallback(() => {
    rafRef.current = null;
    const root = scrollRef.current;
    if (!root) return;
    const ids = idsRef.current?.allowed;
    if (!ids?.size) {
      // [mr-16 review #2.1] 之前是过度防御的 `setComputedId(cur => cur===null ? cur : null)`,
      // React setState 设相同值本就短路,直接 setComputedId(null) 等价且更可读。
      setComputedId(null);
      return;
    }
    const containerRect = root.getBoundingClientRect();
    const threshold = containerRect.top + TOP_FUDGE_PX;

    const target = findPreviousUserMessage(root, ids, threshold);
    setComputedId((cur) => (cur === target ? cur : target));
  }, [scrollRef]);

  // 重置空闲计时器 — chip 显示中且过 IDLE_HIDE_MS 没动就自动隐藏。
  // 任何 scroll 都会调一次,自然实现"再有滑动就恢复"。
  const resetIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    setIdleHidden((cur) => (cur ? false : cur));
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      setIdleHidden(true);
    }, IDLE_HIDE_MS);
  }, []);

  const onScroll = useCallback(() => {
    const root = scrollRef.current;
    if (root) {
      // 方向判定 — 比较当前 scrollTop 与上次值,死区内不更新
      const cur = root.scrollTop;
      const delta = cur - lastScrollTopRef.current;
      if (delta > DIRECTION_DEAD_ZONE_PX) {
        setScrollingDown((prev) => (prev ? prev : true));
      } else if (delta < -DIRECTION_DEAD_ZONE_PX) {
        setScrollingDown((prev) => (prev ? false : prev));
      }
      lastScrollTopRef.current = cur;
    }
    // scroll 一律重置 idle(无论 programmatic 还是 user) — smooth 跳转期间
    // 也算"在动",淡出会立即取消是符合直觉的。
    resetIdleTimer();
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(compute);
    }
  }, [compute, resetIdleTimer, scrollRef]);

  // 主动用户输入解抑制 — wheel / touch / 键盘方向类按键,这些 smooth scroll
  // 不会发出,所以能干净地区分"用户主动想看"和"jump 余波"。
  const onUserInput = useCallback(() => {
    setSuppressed((cur) => (cur ? false : cur));
  }, []);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;

    root.addEventListener('scroll', onScroll, { passive: true });
    root.addEventListener('wheel', onUserInput, { passive: true });
    root.addEventListener('touchstart', onUserInput, { passive: true });
    // 翻页/方向键的 keydown 解抑由 useNavigationKeyListener 统一接管(挂 window,
    // 共享 NAVIGATION_KEYS 集合)。

    // [mr-16 review #2.2] 包一层显式 () => onScroll(),让 RO callback 签名清晰
    // (RO 实际传 (entries, observer),依赖 TS 协变隐式忽略不够直观)。
    const ro = new ResizeObserver(() => onScroll());
    ro.observe(root);

    // 初次同步一次,挂载后用户没动滚轮也能算出当前目标
    onScroll();

    return () => {
      root.removeEventListener('scroll', onScroll);
      root.removeEventListener('wheel', onUserInput);
      root.removeEventListener('touchstart', onUserInput);
      ro.disconnect();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
  }, [scrollRef, onScroll, onUserInput]);

  useNavigationKeyListener(onUserInput);

  // userMessageIds 变化(扩窗 / load-more / 新发消息)也要重算
  useEffect(() => {
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(compute);
    }
  }, [userMessageIds, compute]);

  const suppressAfterClick = useCallback(() => {
    setSuppressed(true);
  }, []);

  const displayId = suppressed || idleHidden || scrollingDown ? null : computedId;
  return { displayId, suppressAfterClick };
}
