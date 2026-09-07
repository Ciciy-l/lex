import { addOrFocusSingletonTab, patchTabState } from '../store';
import type { ReviewSourceDescriptor } from '../../../../shared/reviewSource';

/** Called in the content owner (embedded/detached use the same tool component). */
export async function openGitReview(sessionId: string, descriptor: ReviewSourceDescriptor, path?: string): Promise<void> {
  const tab = await addOrFocusSingletonTab(sessionId, 'review', null);
  if (!tab) return;
  await patchTabState(sessionId, tab.id, raw => ({ ...(raw as object), descriptor,
    historyCommitOid: descriptor.kind === 'commit' ? descriptor.commitOid : null,
    jumpTarget: path ? { path, diffId: null, nonce: Date.now() } : null,
  }));
}
