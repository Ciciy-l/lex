import { useEffect, type RefObject } from 'react';

export function useSettingsSectionTarget(
  targetId: string | null,
  scrollRef: RefObject<HTMLDivElement | null>,
  navigationKey: string,
  fallbackTargetId?: string,
) {
  useEffect(() => {
    const container = scrollRef.current;
    if (!targetId || !container) return;
    let target: HTMLElement | null = null;
    let timer: number | undefined;
    const frame = window.requestAnimationFrame(() => {
      const direct = document.getElementById(targetId);
      const fallback = fallbackTargetId ? document.getElementById(fallbackTargetId) : null;
      target = direct && container.contains(direct) ? direct : fallback;
      if (!target || !container.contains(target)) return;
      const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      container.scrollTo({ top: Math.max(0, top - 8), behavior: reduceMotion ? 'auto' : 'smooth' });
      target.classList.add('settings-search-target-highlight');
      timer = window.setTimeout(() => target?.classList.remove('settings-search-target-highlight'), 1600);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (timer !== undefined) window.clearTimeout(timer);
      target?.classList.remove('settings-search-target-highlight');
    };
  }, [targetId, fallbackTargetId, navigationKey, scrollRef]);
}
