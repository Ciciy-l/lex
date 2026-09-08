const MAX_HELD_CHARS = 256 * 1024;
const FRAME_TIMEOUT_MS = 100;
const RESTORE_WAIT_MS = 32;
const CURSOR_RESTORE_TIMEOUT_MS = 100;
const BATCH_TIMEOUT_MS = 250;

/** Coalesce ConPTY redraws without changing terminal bytes or input cursor modes. */
export function createSynchronizedOutputWriter(write: (data: string) => void) {
  let active = false;
  let chunks: string[] = [];
  let size = 0;
  let disposed = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let release: ReturnType<typeof setTimeout> | undefined;
  let batchDeadline: ReturnType<typeof setTimeout> | undefined;
  let queryState: 'text' | 'escape' | 'csi' | 'osc' | 'oscEscape' = 'text';
  let oscQuery = false;
  let csi = '';
  let cursorHidden = false;
  let positionedWhileHidden = false;
  let shownAfterPosition = false;
  let afterEnd = false;
  let awaitingRestore = false;

  // Observe complete CSI commands across chunk boundaries. A hide/place/show
  // after END is the ConPTY restoration observed in Codex; until it arrives,
  // a shown cursor inside the frame may still be at the transient output cell.
  const scan = (data: string) => {
    let query = oscQuery;
    let started = false;
    let ended = false;
    let restored = false;
    for (const character of data) {
      if (queryState === 'osc') {
        if (character === '?') query = oscQuery = true;
        if (character === String.fromCharCode(7)) {
          queryState = 'text';
          oscQuery = false;
        } else if (character === String.fromCharCode(27)) queryState = 'oscEscape';
      } else if (queryState === 'oscEscape') {
        if (character === String.fromCharCode(92)) {
          queryState = 'text';
          oscQuery = false;
        } else queryState = 'osc';
      } else if (character === String.fromCharCode(27)) {
        queryState = 'escape';
      } else if (queryState === 'escape') {
        queryState = character === '[' ? 'csi' : character === ']' ? 'osc' : 'text';
        csi = '';
      } else if (queryState === 'csi' && character >= '@' && character <= '~') {
        if ('ncp'.includes(character)) query = true;
        const command = csi + character;
        if (command === '?2026h') {
          active = started = true;
          restored = false;
          afterEnd = awaitingRestore = shownAfterPosition = positionedWhileHidden = false;
        } else if (command === '?2026l') {
          active = false;
          restored = false;
          ended = afterEnd = true;
          awaitingRestore = shownAfterPosition;
          positionedWhileHidden = false;
        } else if (command === '?25l') {
          cursorHidden = true;
          shownAfterPosition = positionedWhileHidden = false;
        } else if (command === '?25h') {
          if (cursorHidden && positionedWhileHidden) {
            shownAfterPosition = true;
            if (afterEnd) {
              awaitingRestore = false;
              restored = true;
            }
          }
          cursorHidden = false;
        } else if (/^[0-9;]*[GHf]$/.test(command)) {
          if (cursorHidden) positionedWhileHidden = true;
          else shownAfterPosition = false;
        }
        queryState = 'text';
      } else if (queryState === 'csi') {
        // This is only a scheduling hint, not a second terminal parser. Bound
        // retained CSI parameters even for malformed/untrusted output.
        if (csi.length < 64) csi += character;
      }
    }
    return { query, started, ended, restored };
  };

  const flush = () => {
    clearTimeout(deadline);
    clearTimeout(release);
    clearTimeout(batchDeadline);
    deadline = undefined;
    release = undefined;
    batchDeadline = undefined;
    const data = chunks.join('');
    chunks = [];
    size = 0;
    afterEnd = awaitingRestore = false;
    if (data && !disposed) write(data);
  };

  return {
    push(data: string): void {
      if (disposed || !data) return;
      const wasActive = active;
      const { query, started, ended, restored } = scan(data);
      if (!chunks.length && !wasActive && !started && !ended) {
        write(data);
        return;
      }
      chunks.push(data);
      size += data.length;
      if (size >= MAX_HELD_CHARS || query) {
        flush();
        return;
      }
      // Frame and post-frame timers must not race: a late END deserves its
      // own grace, and a reopened frame must cancel the previous END timer.
      // The independent batch cap prevents endless alternating frames from
      // postponing output forever, without truncating ordinary restorations.
      batchDeadline ??= setTimeout(flush, BATCH_TIMEOUT_MS);
      if (active) {
        clearTimeout(release);
        release = undefined;
        if (ended) {
          clearTimeout(deadline);
          deadline = undefined;
        }
        deadline ??= setTimeout(flush, FRAME_TIMEOUT_MS);
      } else {
        clearTimeout(deadline);
        deadline = undefined;
        if (restored && !awaitingRestore) {
          flush();
        } else if (ended || release === undefined) {
          clearTimeout(release);
          // Usually a restoration arrives in ~18ms and releases immediately.
          // Only suspicious show-before-END frames need the longer fallback;
          // ordinary/hidden frames retain their short release window.
          release = setTimeout(flush, awaitingRestore ? CURSOR_RESTORE_TIMEOUT_MS : RESTORE_WAIT_MS);
        }
      }
    },
    dispose(): void {
      disposed = true;
      flush();
      csi = '';
    },
  };
}
