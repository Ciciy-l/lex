import { openRoutinesTab } from './openRoutinesTab';
/** 执行 main 已裁决并推给当前 renderer host 的 RSB command。 */

import type { RsbWindowCommand } from '../../../../shared/rightSidebarWindow';
import {
  addOrFocusSingletonTab,
  closeTab,
  ensureHydrated,
  getBucket,
  patchTabState,
} from '../store';
import {
  closeOrcaWorkersTabAfterTeamEnd,
  ensureOrcaWorkersTab,
} from '../plugins/orca-workers/actions';
import {
  openDirInSidebarFileBrowser,
  openExternalFileInSidebarFileBrowser,
  openFileInSidebarFileBrowser,
} from './openInSidebarFileBrowser';
import { openBackgroundTasksTab } from './openBackgroundTasksTab';
import { openSubagentsTab } from './openSubagentsTab';
import { openTurnReview } from './openTurnReview';
import { openFileContentTab } from './openFileContentTab';
import { openUrlInSidebarBrowser } from './openInSidebarBrowser';
import { resolveGitWorkspaceView } from './gitWorkspaceView';

/** 在 main 已选定的当前 renderer host 中执行命令，不自行选择宿主。 */
export async function executeSidebarCommand(command: RsbWindowCommand): Promise<void> {
  if (command.type === 'open-file-content') {
    await openFileContentTab(command.sessionId, command.file);
    return;
  }
  if (command.type === 'open-routines-tab') {
    await openRoutinesTab(command.sessionId, command.botId);
    return;
  }
  if (command.type === 'open-web-browser') {
    await openUrlInSidebarBrowser(command.sessionId, command.url);
    return;
  }
  if (command.type === 'open-file-browser') {
    if (command.targetKind === 'external-file') {
      await openExternalFileInSidebarFileBrowser(command.sessionId, command.absPath);
    } else if (command.targetKind === 'directory') {
      await openDirInSidebarFileBrowser(command.sessionId, command.relPath);
    } else {
      await openFileInSidebarFileBrowser(command.sessionId, command.relPath);
    }
    return;
  }
  if (command.type === 'ensure-orca-workers-tab') {
    await ensureOrcaWorkersTab(command.sessionId, {
      focusWorkerSessionId: command.focusWorkerSessionId,
      searchJump: command.searchJump,
      focusTab: command.focusTab === true,
    });
    return;
  }
  if (command.type === 'close-orca-workers-tab') {
    await closeOrcaWorkersTabAfterTeamEnd(command.sessionId);
    return;
  }
  if (command.type === 'open-background-tasks-tab') {
    // 被路由端再调 openBackgroundTasksTab:其内部 routeSidebarCommand 在子窗口
    // 直接裁决 'attached',落本地 store(与 open-file-browser 的复用同构)。
    await openBackgroundTasksTab(command.sessionId, {
      ...(command.focusTaskId ? { focusTaskId: command.focusTaskId } : {}),
    });
    return;
  }
  if (command.type === 'open-subagents-tab') {
    await openSubagentsTab(command.sessionId, {
      ...(command.focusRunId && command.focusProvider
        ? { focusRunId: command.focusRunId, focusProvider: command.focusProvider }
        : {}),
      focusTab: command.focusTab !== false,
      revealSidebar: command.revealSidebar !== false,
      userInitiated: false,
    });
    return;
  }
  if (command.type === 'open-turn-review') {
    await openTurnReview(command.sessionId, command.changeSetIds, {
      selectedDiffId: command.selectedDiffId ?? null,
      selectedPath: command.selectedPath ?? null,
      requestNonce: command.requestNonce,
      hostSessionId: command.hostSessionId ?? null,
    });
    return;
  }
  if (command.type === 'toggle-review-tab') {
    await ensureHydrated(command.sessionId);
    const bucket = getBucket(command.sessionId);
    const reviewTab = bucket.tabs.find((tab) => tab.kind === 'review');
    const hostAlreadyVisible =
      typeof document === 'undefined' || document.visibilityState === 'visible';
    // The command is a Review shortcut. From Graph it should reveal Review;
    // only an already-visible Review surface toggles the unified Git tab shut.
    const activeView = resolveGitWorkspaceView(reviewTab?.state);
    const reviewIsShowing = activeView !== 'graph';
    if (
      reviewTab &&
      bucket.activeContentTabId === reviewTab.id &&
      hostAlreadyVisible &&
      reviewIsShowing
    ) {
      await closeTab(command.sessionId, reviewTab.id);
      return;
    }
    const tab = await addOrFocusSingletonTab(command.sessionId, 'review', null);
    if (!tab) return;
    await patchTabState(command.sessionId, tab.id, (current) => ({
      ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}),
      activeView: 'review',
    }));
    return;
  }
  await ensureHydrated(command.sessionId);
  await addOrFocusSingletonTab(command.sessionId, 'terminal');
}
