import { useEffect } from 'react';
import { Outlet, useOutletContext } from 'react-router-dom';

import { useOwnTopNavScrollableRows } from '../feature-context';
import { useRemoteBotSync } from './useRemoteBots';
import { BotsSidebar } from './BotsSidebar';
import { BotSettingsDrawer } from './BotSettingsDrawer';
import { BotGroupSettingsDrawer } from './BotGroupSettingsDrawer';
import { startBotGroupSync } from './botGroupStore';
import { refreshBotProfiles } from './botStore';

export function BotsFeatureLayout() {
  useOwnTopNavScrollableRows(false);
  useRemoteBotSync();
  useEffect(() => {
    refreshBotProfiles();
    const unsubscribeProfile = window.electronAPI.maker.onBotProfileChanged(() =>
      refreshBotProfiles(),
    );
    const unsubscribeLifecycle = window.electronAPI.maker.onBotLifecycleChanged(() =>
      refreshBotProfiles(),
    );
    return () => {
      unsubscribeProfile();
      unsubscribeLifecycle();
    };
  }, []);
  // 群聊列表(侧栏分组与群设置共用)跟随 main 的 onBotGroupChanged 推送刷新。
  useEffect(() => startBotGroupSync(), []);
  const shellContext = useOutletContext<{
    sidebarWidth?: number;
    rightSidebarCollapsed?: boolean;
    onToggleRightSidebar?: () => void;
    rightSidebarSide?: 'left' | 'right';
    setRightSidebarAvailable?: (available: boolean) => void;
    setRightSidebarSessionId?: (
      sessionId: string | null,
      opts?: { initialCollapsed?: boolean; writeInitialCollapsedRecord?: boolean },
    ) => void;
    setRightSidebarWorkdir?: (
      workdir: string,
      remoteHostId?: string | null,
      deviceLinkDeviceId?: string | null,
    ) => void;
  } | null>();
  return (
    <>
      <BotsSidebar />
      <Outlet context={shellContext} />
      <BotSettingsDrawer />
      <BotGroupSettingsDrawer />
    </>
  );
}
