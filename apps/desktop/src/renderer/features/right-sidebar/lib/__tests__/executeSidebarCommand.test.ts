// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../store', () => ({
  ensureHydrated: vi.fn(async () => undefined),
  addOrFocusSingletonTab: vi.fn(async () => ({ id: 'review-1', kind: 'review', state: {} })),
  closeTab: vi.fn(async () => undefined),
  patchTabState: vi.fn(async () => undefined),
  getBucket: vi.fn(() => ({
    // An object without activeView represents a persisted pre-unification
    // Review record; null is covered separately as a new Graph-first tab.
    tabs: [{ id: 'review-1', kind: 'review', state: {} }],
    activeTabId: 'review-1',
    activeContentTabId: 'review-1',
    activeToolId: null,
  })),
}));
vi.mock('../openInSidebarBrowser', () => ({
  openUrlInSidebarBrowser: vi.fn(async () => undefined),
}));
vi.mock('../openInSidebarFileBrowser', () => ({
  openDirInSidebarFileBrowser: vi.fn(async () => undefined),
  openExternalFileInSidebarFileBrowser: vi.fn(async () => undefined),
  openFileInSidebarFileBrowser: vi.fn(async () => undefined),
}));
vi.mock('../openSubagentsTab', () => ({
  openSubagentsTab: vi.fn(async () => undefined),
}));
vi.mock('../../plugins/orca-workers/actions', () => ({
  ensureOrcaWorkersTab: vi.fn(async () => undefined),
  closeOrcaWorkersTabAfterTeamEnd: vi.fn(async () => undefined),
}));

import {
  addOrFocusSingletonTab,
  closeTab,
  ensureHydrated,
  getBucket,
  patchTabState,
} from '../../store';
import {
  closeOrcaWorkersTabAfterTeamEnd,
  ensureOrcaWorkersTab,
} from '../../plugins/orca-workers/actions';
import { executeSidebarCommand } from '../executeSidebarCommand';
import {
  openDirInSidebarFileBrowser,
  openExternalFileInSidebarFileBrowser,
  openFileInSidebarFileBrowser,
} from '../openInSidebarFileBrowser';
import { openUrlInSidebarBrowser } from '../openInSidebarBrowser';
import { openSubagentsTab } from '../openSubagentsTab';

describe('executeSidebarCommand', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dispatches every command kind to the current renderer host implementation', async () => {
    const searchJump = {
      kind: 'conversation-search' as const,
      sessionId: 'worker-1',
      messageId: 'message-1',
      messageClientId: 'message-1',
    };
    await executeSidebarCommand({ type: 'open-terminal', sessionId: 's1' });
    await executeSidebarCommand({
      type: 'open-web-browser',
      sessionId: 's1',
      url: 'https://example.com/',
    });
    await executeSidebarCommand({
      type: 'open-file-browser',
      sessionId: 's1',
      relPath: 'src',
      targetKind: 'directory',
    });
    await executeSidebarCommand({
      type: 'open-file-browser',
      sessionId: 's1',
      relPath: 'src/App.tsx',
      targetKind: 'file',
    });
    await executeSidebarCommand({
      type: 'open-file-browser',
      sessionId: 's1',
      absPath: 'C:\\tmp\\note.md',
      targetKind: 'external-file',
    });
    await executeSidebarCommand({
      type: 'ensure-orca-workers-tab',
      sessionId: 's1',
      focusWorkerSessionId: 'worker-1',
      searchJump,
      focusTab: false,
    });
    await executeSidebarCommand({ type: 'close-orca-workers-tab', sessionId: 's1' });
    await executeSidebarCommand({
      type: 'open-subagents-tab',
      sessionId: 's1',
      focusRunId: 'shared-native-id',
      focusProvider: 'codex',
      focusTab: true,
      revealSidebar: true,
    });

    expect(ensureHydrated).toHaveBeenCalledWith('s1');
    expect(addOrFocusSingletonTab).toHaveBeenCalledWith('s1', 'terminal');
    expect(openUrlInSidebarBrowser).toHaveBeenCalledWith('s1', 'https://example.com/');
    expect(openDirInSidebarFileBrowser).toHaveBeenCalledWith('s1', 'src');
    expect(openFileInSidebarFileBrowser).toHaveBeenCalledWith('s1', 'src/App.tsx');
    expect(openExternalFileInSidebarFileBrowser).toHaveBeenCalledWith('s1', 'C:\\tmp\\note.md');
    expect(ensureOrcaWorkersTab).toHaveBeenCalledWith('s1', {
      focusWorkerSessionId: 'worker-1',
      searchJump,
      focusTab: false,
    });
    expect(closeOrcaWorkersTabAfterTeamEnd).toHaveBeenCalledWith('s1');
    expect(openSubagentsTab).toHaveBeenCalledWith('s1', {
      focusRunId: 'shared-native-id',
      focusProvider: 'codex',
      focusTab: true,
      revealSidebar: true,
      userInitiated: false,
    });
  });

  it('keeps Review when the detached host is still hidden', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await executeSidebarCommand({ type: 'toggle-review-tab', sessionId: 's1' });
    expect(getBucket).toHaveBeenCalledWith('s1');
    expect(closeTab).not.toHaveBeenCalled();
    expect(addOrFocusSingletonTab).toHaveBeenCalledWith('s1', 'review', null);
    expect(patchTabState).toHaveBeenCalled();
  });

  it('hides Review only after the detached host is already visible', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await executeSidebarCommand({ type: 'toggle-review-tab', sessionId: 's1' });
    expect(closeTab).toHaveBeenCalledWith('s1', 'review-1');
    expect(addOrFocusSingletonTab).not.toHaveBeenCalled();
  });

  it('switches an active Graph workspace to Review instead of closing it', async () => {
    vi.mocked(getBucket).mockReturnValueOnce({
      tabs: [{ id: 'review-1', kind: 'review', state: { activeView: 'graph' } }],
      activeTabId: 'review-1',
      activeContentTabId: 'review-1',
      activeToolId: null,
    } as never);
    vi.mocked(addOrFocusSingletonTab).mockResolvedValueOnce({
      id: 'review-1',
      kind: 'review',
      state: { activeView: 'graph' },
    } as never);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });

    await executeSidebarCommand({ type: 'toggle-review-tab', sessionId: 's1' });

    expect(closeTab).not.toHaveBeenCalled();
    expect(addOrFocusSingletonTab).toHaveBeenCalledWith('s1', 'review', null);
    const update = vi.mocked(patchTabState).mock.calls[0]?.[2] as (current: unknown) => unknown;
    expect(update({ activeView: 'graph' })).toMatchObject({ activeView: 'review' });
  });

  it('treats a newly-created null Git state as Graph instead of closing the tab', async () => {
    vi.mocked(getBucket).mockReturnValueOnce({
      tabs: [{ id: 'review-1', kind: 'review', state: null }],
      activeTabId: 'review-1',
      activeContentTabId: 'review-1',
      activeToolId: null,
    } as never);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });

    await executeSidebarCommand({ type: 'toggle-review-tab', sessionId: 's1' });

    expect(closeTab).not.toHaveBeenCalled();
    expect(addOrFocusSingletonTab).toHaveBeenCalledWith('s1', 'review', null);
    expect(patchTabState).toHaveBeenCalled();
  });
});
