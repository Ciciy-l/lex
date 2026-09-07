import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { FileBodyView, type FileBodyHandle } from '@/features/cc-agent/workdir-browse/FileBodyView';
import { useFileContent } from '@/features/cc-agent/workdir-browse/hooks/useFileContent';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { toast } from '@/lib/toast';
import type { TabKindHostContext } from '../../types';
import { fileContentIdentity, type FileContentTabState } from './state';
import { keepFileContentTab, protectFilePreview } from '../../lib/openFileContentTab';
import '../file-browser/FileBrowserBody.css';

interface Props {
  state: FileContentTabState;
  ctx: TabKindHostContext;
  active?: boolean;
  shellVisible?: boolean;
}

export function FileContentTabBody(props: Props) {
  if (!props.state.workdir || !props.state.path) return null;
  const deviceId = props.state.external
    ? null
    : props.ctx.deviceLinkDeviceId === undefined
      ? props.state.deviceId
      : props.ctx.deviceLinkDeviceId;
  // A known file source survives temporary host hydration; do not unmount drafts.
  if (deviceId === undefined) return null;
  const remoteHostId =
    props.state.external || deviceId
      ? null
      : props.ctx.remoteHostId || props.state.remoteHostId || null;
  return (
    <FileContentView
      key={fileContentIdentity({ ...props.state, deviceId, remoteHostId })}
      {...props}
      deviceId={deviceId}
      remoteHostId={remoteHostId}
    />
  );
}

function FileContentView({
  state,
  ctx,
  active,
  shellVisible,
  deviceId,
  remoteHostId,
}: Props & { deviceId: string | null; remoteHostId: string | null }) {
  const { t } = useTranslation();
  const { confirmThree } = useConfirmDialog();
  const handle = useRef<FileBodyHandle>(null);
  const releaseProtection = useRef<(() => void) | null>(null);
  useEffect(() => () => releaseProtection.current?.(), []);
  const onUserEdit = () => {
    if (!releaseProtection.current)
      releaseProtection.current = protectFilePreview(ctx.sessionId, ctx.tabId);
    if (state.preview)
      void keepFileContentTab(ctx.sessionId, ctx.tabId).catch(() =>
        toast.error(t('rightSidebar.workbench.loadFailed')),
      );
  };
  const { content, setLocal, refresh } = useFileContent(
    state.workdir,
    state.path,
    remoteHostId,
    deviceId,
  );
  useEffect(
    () =>
      ctx.setCloseInterceptor(async () => {
        if (!handle.current?.isDirty()) return true;
        const choice = await confirmThree({
          title: t('ccAgent.workdirBrowse.confirmSwitchAway.title'),
          description: t('ccAgent.workdirBrowse.confirmSwitchAway.descriptionCloseTab', {
            path: state.path,
          }),
          confirmText: t('ccAgent.workdirBrowse.confirmSwitchAway.save'),
          tertiaryText: t('ccAgent.workdirBrowse.confirmSwitchAway.tertiary'),
          cancelText: t('ccAgent.workdirBrowse.confirmSwitchAway.cancel'),
        });
        if (choice === 'cancel') return false;
        if (choice === 'tertiary') return true;
        const saved = await handle.current?.save();
        return saved === true && handle.current !== null && !handle.current.isDirty();
      }),
    [ctx, confirmThree, t, state.path],
  );
  useEffect(() => {
    if (!active || !shellVisible || (!deviceId && !remoteHostId)) return;
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [active, shellVisible, deviceId, remoteHostId, refresh]);
  return (
    <div className="rsb-fbody-compact flex min-h-0 flex-1 flex-col overflow-hidden">
      <FileBodyView
        ref={handle}
        onUserEdit={onUserEdit}
        revealTarget={state.reveal}
        onRevealConsumed={() => ctx.patchState({ reveal: null })}
        active={!!active && !!shellVisible}
        workdir={state.workdir}
        remoteHostId={remoteHostId}
        deviceId={deviceId}
        sessionId={state.external ? undefined : ctx.sessionId}
        relPath={state.path}
        content={content}
        allowEdit={!state.external}
        onSaved={state.external ? undefined : setLocal}
      />
    </div>
  );
}
