import { addTab, ensureHydrated, getBucket, patchTabState, setActiveTab } from '../store';
import {
  fileContentIdentity,
  hydrateFileContentTab,
  type FileContentTabState,
} from '../plugins/file-content/state';
import { routeSidebarCommand } from './detachedSidebarRouting';
import { requestRightSidebarVisibility } from './sidebarCommands';

import { isFilePreviewProtected } from './filePreviewProtection';
export { protectFilePreview } from './filePreviewProtection';
export function keepFileContentTab(sessionId: string, tabId: string): Promise<void> {
  return patchTabState(sessionId, tabId, (raw) => ({
    ...hydrateFileContentTab(raw),
    preview: false,
  }));
}

const pending = new Map<string, Promise<string>>();
/** Serialized per Lead: distinct files cannot race to create/replace the preview. */
export function openFileContentTab(sessionId: string, file: FileContentTabState): Promise<string> {
  const request = (pending.get(sessionId) ?? Promise.resolve(''))
    .catch(() => '')
    .then(async () => {
      await ensureHydrated(sessionId);
      const state = hydrateFileContentTab(file);
      const tabs = getBucket(sessionId).tabs;
      const existing = tabs.find(
        (tab) =>
          tab.kind === 'file-content' &&
          fileContentIdentity(hydrateFileContentTab(tab.state)) === fileContentIdentity(state),
      );
      if (existing) {
        await patchTabState(sessionId, existing.id, (raw) => {
          const current = hydrateFileContentTab(raw);
          return {
            ...current,
            preview: current.preview === true && state.preview === true,
            ...(state.reveal ? { reveal: state.reveal } : {}),
          };
        });
        await setActiveTab(sessionId, existing.id);
        return existing.id;
      }
      const preview =
        state.preview &&
        tabs.find(
          (tab) =>
            tab.kind === 'file-content' &&
            hydrateFileContentTab(tab.state).preview &&
            !isFilePreviewProtected(sessionId, tab.id),
        );
      if (preview) {
        await patchTabState(sessionId, preview.id, () => state);
        await setActiveTab(sessionId, preview.id);
        return preview.id;
      }
      return (await addTab(sessionId, 'file-content', state)).id;
    });
  pending.set(sessionId, request);
  void request
    .finally(() => {
      if (pending.get(sessionId) === request) pending.delete(sessionId);
    })
    .catch(() => undefined);
  return request;
}

/** Route user navigation to the current content owner; remote tab IDs are not fabricated. */
export async function openFileContentInSidebar(
  sessionId: string,
  file: FileContentTabState,
): Promise<void> {
  const route = await routeSidebarCommand({ type: 'open-file-content', sessionId, file });
  if (route === 'attached') await openFileContentTab(sessionId, file);
  if (route === 'attached' || route === 'routed')
    requestRightSidebarVisibility('open', { sessionId });
}
