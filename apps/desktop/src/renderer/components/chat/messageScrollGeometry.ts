/**
 * Message items are non-overlapping siblings in a vertical flex column. Read
 * their outer boxes, not descendants of offscreen content-visibility items:
 * measuring a skipped descendant can synchronously lay out its whole subtree.
 */
export function findViewportItem(
  children: ArrayLike<Element>,
  viewportTop: number,
): { index: number; element: HTMLElement; rect: DOMRect } | null {
  let low = 0;
  let high = children.length - 1;
  let found: { index: number; element: HTMLElement; rect: DOMRect } | null = null;
  while (low <= high) {
    const index = low + Math.floor((high - low) / 2);
    const element = children[index] as HTMLElement;
    const rect = element.getBoundingClientRect();
    if (rect.bottom > viewportTop) {
      found = { index, element, rect };
      high = index - 1;
    } else {
      low = index + 1;
    }
  }
  return found;
}

/**
 * Return the last mounted user message whose actual bottom is strictly above
 * the threshold. Each user message is a separate render item. Find its outer
 * item with logarithmic layout reads, then inspect only the boundary message
 * (its wrapper can extend below the message because of actions/padding).
 *
 * One scoped DOM query also handles missing/unmounted IDs and DOM replacement.
 * Do not cache pixel positions: streaming, fonts, expanded cards and viewport
 * resizing can change heights without changing the message ID list.
 */
export function findPreviousUserMessage(
  root: HTMLElement,
  allowedIds: ReadonlySet<string>,
  thresholdTop: number,
): string | null {
  const messages = Array.from(root.querySelectorAll<HTMLElement>('[data-user-msg-id]')).filter(
    (element) => allowedIds.has(element.dataset.userMsgId ?? ''),
  );
  let low = 0;
  let high = messages.length - 1;
  while (low <= high) {
    const index = low + Math.floor((high - low) / 2);
    const message = messages[index];
    const item = message.closest<HTMLElement>('.msg-stream-items > *') ?? message;
    if (item.getBoundingClientRect().bottom < thresholdTop) {
      low = index + 1;
    } else {
      high = index - 1;
    }
  }
  const boundary = messages[low];
  if (boundary && boundary.getBoundingClientRect().bottom < thresholdTop) {
    return boundary.dataset.userMsgId ?? null;
  }
  return messages[low - 1]?.dataset.userMsgId ?? null;
}
