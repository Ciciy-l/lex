import { addOrFocusSingletonTab } from '../store';

export async function openGitGraph(sessionId: string) {
  return addOrFocusSingletonTab(sessionId, 'git-graph', null);
}
