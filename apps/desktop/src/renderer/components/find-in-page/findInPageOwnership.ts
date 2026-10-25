/**
 * findInPageOwnership — Ctrl/Cmd+F 接管令牌。
 *
 * 默认情况下,App 根上挂了一个 FindInPageBar,它在 window 上 capture 阶段截
 * Ctrl+F,驱动 Chromium 原生的 webContents.findInPage。但有些场景需要把搜
 * 索改成自己的 in-doc 搜索(例如 doc 模式的 FileBodyView),不希望全局那个
 * 搜索条同时弹出。
 *
 * 简单做"我也注册一个 capture 监听 + stopImmediatePropagation"是错的:同
 * 一 target 同 phase 的监听按注册顺序触发,App 根的 bar 先注册,先跑,
 * 后挂的接管者来不及拦。
 *
 * 每个接管者持有独立令牌,卸载时 release。FindInPageBar 的 handler 检查
 * 当前有效令牌,让位给接管者,与监听注册顺序无关。焦点作用域可提供即时
 * 校验:被聚焦节点移除时浏览器不一定发 blur/focusout,旧令牌不能阻挡全局
 * 查找。只在查询时检查少量持有者,不观察 DOM 变更或扫描终端输出。
 */

const claims = new Set<{ isCurrent?: () => boolean }>();

export function acquireFindInPage(isCurrent?: () => boolean): () => void {
  const claim = { isCurrent };
  claims.add(claim);
  return () => { claims.delete(claim); };
}

export function isFindInPageClaimed(): boolean {
  for (const claim of claims) {
    if (!claim.isCurrent || claim.isCurrent()) return true;
  }
  return false;
}
