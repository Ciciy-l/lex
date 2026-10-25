/**
 * OrcaWorkerPanel —— 右侧栏「协同」tab 内的 worker-only 面板。
 *
 * 只承载 Worker 侧能力:worker 列表 / focus 切换 / 新建 / 归档 / 当前 focused worker
 * 会话流。Lead 主会话仍由普通 CCAgentSessionView 渲染,这里不复用 OrcaSplitView 的
 * 双栏布局与独立 resize/maximize。
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { isAgentIslandSupported } from '@/hooks/useAgentIslandSettings';
import { toast } from '@/lib/toast';
import { isSidebarWindow } from '@/lib/sidebarWindow';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { CCAgentSessionView } from './CCAgentSessionView';
import { CreateWorkerPopover } from './CreateWorkerPopover';
import { WorkerListToolbar } from './RolePillDropdown';
import { useOrcaWorkerSelection } from './hooks/useOrcaWorkerSelection';
import { subscribeNewWorkerShortcut } from './lib/newWorkerShortcut';
import type { ConversationSearchJump } from '../../../shared/conversationSearchJump';
import { isActiveWorkerStatus } from '../../../shared/orca-worker-status';

export interface OrcaWorkerPanelProps {
  leadSessionId: string;
  /**
   * device-link 受控设备：string = 被控设备(远程)，null = 已确认本机，undefined = 归属尚未解析。
   * 本地设置跳转只在归属解析为 null(本机)时启用，未解析时 fail closed，
   * 避免冷启动 / relay 重连竞态把远端上限误当成本机可调。
   */
  deviceId?: string | null;
  remoteHostId?: string | null;
  /** SSH 远程 Lead:worker 创建面板的模型清单按 SSH 口径过滤(见 CreateWorkerPopover.sshRemote)。 */
  sshRemote?: boolean;
  /** tab active && RSB 未折叠 && 窗口可见。挂载但不可见时不能清红点 / ack 消息。 */
  viewVisible: boolean;
  /** 重型聊天 snapshot 是否实时刷新；隐藏 keep-alive worker pane 会冻结 messages。 */
  chatRealtime?: boolean;
  focusWorkerSessionId?: string | null;
  focusWorkerHintRevision?: number;
  searchJump?: ConversationSearchJump | null;
  onFocusWorkerSessionIdConsumed?: (revision: number) => void;
  onSelectionIntentCleared?: (revision: number) => void;
  onSearchJumpConsumed?: () => void;
}

function sameVisibleSessionPayload(
  a: string | string[] | null,
  b: string | string[] | null,
): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function OrcaWorkerPanel({
  leadSessionId,
  deviceId,
  remoteHostId,
  sshRemote,
  viewVisible,
  chatRealtime = true,
  focusWorkerSessionId,
  focusWorkerHintRevision,
  searchJump,
  onFocusWorkerSessionIdConsumed,
  onSelectionIntentCleared,
  onSearchJumpConsumed,
}: OrcaWorkerPanelProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    workers,
    focusedWorker,
    activeWorkerCount,
    softLimit,
    hardLimit,
    refreshCreationState,
    selectedWorkerRecord,
    selectedWorkerId,
    workerSessionId,
    createOpen,
    setCreateOpen,
    handleCreateWorker,
    handleSwitchFocus,
    handleArchiveWorker,
  } = useOrcaWorkerSelection({
    leadSessionId,
    deviceId,
    viewVisible,
    focusWorkerSessionId,
    focusWorkerHintRevision,
    searchJump,
    onFocusWorkerSessionIdConsumed,
    onSelectionIntentCleared,
  });
  const lastAgentIslandPayloadRef = useRef<string | string[] | null>(null);
  const openEpoch = useRef(0);
  const openPending = useRef<number | null>(null);
  const pendingOwner = useRef(getDataOwnerGeneration());
  const scope = JSON.stringify([leadSessionId, deviceId, remoteHostId, viewVisible]);
  const currentScope = useRef(scope); currentScope.current = scope;
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    openEpoch.current++;
    openPending.current = null;
    return () => { mounted.current = false; openEpoch.current++; openPending.current = null; };
  }, [leadSessionId, deviceId, remoteHostId, viewVisible]);

  const handleOpenCreate = useCallback(async () => {
    if (createOpen || !mounted.current || !viewVisible || deviceId === undefined || currentScope.current !== scope) return;
    if (openPending.current !== null && !isDataOwnerGenerationCurrent(pendingOwner.current)) {
      openEpoch.current++; openPending.current = null;
    }
    if (openPending.current !== null) return;
    const epoch = openEpoch.current, owner = getDataOwnerGeneration();
    pendingOwner.current = owner;
    openPending.current = epoch;
    const current = () => mounted.current && epoch === openEpoch.current && isDataOwnerGenerationCurrent(owner);
    try {
      const result = await refreshCreationState();
      if (!current()) return;
      if (result.status !== 'applied') {
        toast.error(t('newChat.collaboration.createWorkerRefreshFailed'));
        return;
      }
      const activeCount = result.workers.filter((worker) => isActiveWorkerStatus(worker.status)).length;
      if (result.hardLimit !== null && activeCount >= result.hardLimit) return;
      setCreateOpen(true);
    } catch {
      if (current()) toast.error(t('newChat.collaboration.createWorkerRefreshFailed'));
    } finally {
      if (openPending.current === epoch) openPending.current = null;
    }
  }, [createOpen, deviceId, refreshCreationState, setCreateOpen, t, viewVisible, scope]);

  // 硬上限时 + 按钮不再只是 disabled no-op，而是跳转到协同设置去调高上限（codex P1 逃生口）。
  // 但两类面板不接线跳转（onOpenSettings 传 undefined，+ 按钮回退为 disabled）：
  // 1) 分离侧栏窗口固定在 /sidebar-window 壳路由，本地 navigate 会把辅助窗口整壳替换成主设置
  //    路由，与 CreateWorkerPopover 的 onNavigateToProviders 同口径；
  // 2) device-link 受控 Lead（deviceId 面板）：其 worker 上限走 device-link Orca 路径，
  //    本地 /settings?section=collaboration 读写的是本机 localDb.orcaWorkflows，改不动远程上限。
  const handleOpenSettings = useCallback(() => {
    navigate('/settings?section=collaboration');
  }, [navigate]);

  useEffect(() => {
    if (!viewVisible || deviceId === undefined) return;
    return subscribeNewWorkerShortcut(async () => {
      // Refresh both worker status and authoritative collaboration settings so the shortcut
      // cannot bypass a newly reached or newly lowered hard limit.
      await handleOpenCreate();
      return true;
    });
  }, [deviceId, handleOpenCreate, viewVisible]);

  useEffect(() => {
    if (!isAgentIslandSupported()) return;
    // 可见性归属契约:协同 tab 真正可见时由 worker panel 上报 [lead, worker]；
    // 隐藏、切 tab 或折叠 RSB 时回落为 lead,避免和主 Lead 视图靠 effect 时序抢归属。
    const visibleSessionIds =
      viewVisible && workerSessionId && workerSessionId !== leadSessionId
        ? [leadSessionId, workerSessionId]
        : leadSessionId;
    if (!sameVisibleSessionPayload(lastAgentIslandPayloadRef.current, visibleSessionIds)) {
      lastAgentIslandPayloadRef.current = visibleSessionIds;
      void window.electronAPI.agentIsland?.setVisibleSession?.(visibleSessionIds);
    }
  }, [leadSessionId, viewVisible, workerSessionId]);

  useEffect(() => {
    return () => {
      if (!isAgentIslandSupported()) return;
      if (lastAgentIslandPayloadRef.current !== leadSessionId) {
        lastAgentIslandPayloadRef.current = leadSessionId;
        void window.electronAPI.agentIsland?.setVisibleSession?.(leadSessionId);
      }
    };
  }, [leadSessionId]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-content-area">
      <div className="flex h-8 shrink-0 items-center border-b border-border/40 px-3 text-11 font-medium leading-none text-muted-foreground">
        <WorkerListToolbar
          worker={selectedWorkerRecord ?? focusedWorker}
          workers={workers}
          selectedWorkerId={selectedWorkerId}
          activeWorkerCount={activeWorkerCount}
          softLimit={softLimit}
          hardLimit={hardLimit}
          onSwitchFocus={handleSwitchFocus}
          onOpenCreate={() => void handleOpenCreate()}
          onOpenSettings={isSidebarWindow() || deviceId !== null ? undefined : handleOpenSettings}
          onArchiveWorker={handleArchiveWorker}
          clearAttentionWhenVisible={viewVisible}
        />
      </div>
      <div className="chat-rail-compact min-h-0 flex-1">
        {workerSessionId ? (
          <CCAgentSessionView
            key={workerSessionId}
            sessionIdProp={workerSessionId}
            compact
            orcaMode
            compactToolbar
            viewVisible={viewVisible}
            chatRealtime={chatRealtime}
            searchJumpProp={searchJump}
            onSearchJumpConsumed={onSearchJumpConsumed}
            navigationMode="sidebar-embedded"
            sidebarTargetSessionId={leadSessionId}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {t('orca.split.waitingForWorker')}
          </div>
        )}
      </div>
      <CreateWorkerPopover
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={handleCreateWorker}
        deviceId={deviceId ?? undefined}
        sshRemote={sshRemote}
        remoteHostId={remoteHostId}
      />
    </div>
  );
}
