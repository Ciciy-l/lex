import { addOrFocusSingletonTab, patchTabState } from '../store';

/**
 * Focus the one canonical Git workspace and switch only its visible surface.
 *
 * This deliberately does not touch the Review descriptor or jump target: the
 * compact switch in the Git navigator is navigation within one workspace, not
 * a request to replace the review the user was looking at.
 */
export async function openGitWorkspaceView(sessionId: string, activeView: 'graph' | 'review') {
  const tab = await addOrFocusSingletonTab(sessionId, 'review', null);
  await patchTabState(sessionId, tab.id, (current) => ({
    ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}),
    activeView,
  }));
  return tab;
}

export async function openGitGraph(sessionId: string) {
  return openGitWorkspaceView(sessionId, 'graph');
}
