import { AddRemoteProjectDialog } from '@/components/new-chat/AddRemoteProjectDialog';
import { TaskMoveSubmenu, moveRemoteTaskProject, type TaskMoveDestination } from './TaskMoveSubmenu';
import { TaskMigrationDialog } from './TaskMigrationDialog';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isSharedTaskPeer } from '@cindy/device-link';
import type { Session } from '@/lib/ccAgent.types';
import { SharedTaskButton } from '@/features/device-link/SharedTaskButton';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { isEmptyDraftSession } from '../lib/sessionDisplayTitle';
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS, MENU_SEPARATOR_CLASS } from './menuStyles';

type MenuDialog = 'shared' | { kind: 'migration'; destination?: TaskMoveDestination } | { kind: 'browse-project' };

interface Props {
  session: Session;
  open: boolean;
  writeBlocked: boolean;
  sideOffset?: number;
  returnFocus: () => void;
  onRename: () => void;
  onPin: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
  onOpenInNewWindow: () => void;
  move: ReactNode;
  tags: ReactNode;
  copy: ReactNode;
  exportShare: ReactNode;
}

/** One menu order for the header, text rows and cards. Keep row-specific action handlers. */
export function SessionTaskMenu(props: Props) {
  const [dialog, setDialog] = useState<MenuDialog | null>(null);
  // Do not mount sharing controls for every idle sidebar row.
  if (!props.open && !dialog) return null;
  return <ActiveSessionTaskMenu {...props} dialog={dialog} setDialog={setDialog} />;
}

function ActiveSessionTaskMenu({
  session,
  writeBlocked,
  sideOffset = 4,
  returnFocus,
  onRename,
  onPin,
  onArchive,
  onUnarchive,
  onDelete,
  onOpenInNewWindow,
  move,
  tags,
  copy,
  exportShare,
  dialog,
  setDialog,
}: Props & {
  dialog: MenuDialog | null;
  setDialog: (dialog: MenuDialog | null) => void;
}) {
  const { t } = useTranslation();
  const guest = isSharedTaskPeer(session.deviceLinkDeviceId ?? '');
  const archived = session.status === 'archived';
  const empty = isEmptyDraftSession(session);
  const item = (key: string, action: () => void, disabled = false) => (
    <DropdownMenuItem className={MENU_ITEM_CLASS} disabled={disabled} onSelect={action}>
      {t(`ccAgent.sidebar.sessionMenu.${key}`)}
    </DropdownMenuItem>
  );
  const separator = <DropdownMenuSeparator />;
  return (
    <div
      className="contents"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <DropdownMenuContent
        align="start"
        sideOffset={sideOffset}
        className="min-w-32 overflow-hidden"
        onClick={(event) => event.stopPropagation()}
        onCloseAutoFocus={(event) => {
          if (dialog) event.preventDefault();
        }}
      >
        {!guest && (
          <>
            {!archived &&
              !empty &&
              item(session.pinnedAt != null ? 'unpin' : 'pin', onPin, writeBlocked)}
            {item('rename', onRename, writeBlocked)}
            {!archived && !empty && !session.remoteHostId && <TaskMoveSubmenu session={session} disabled={writeBlocked}
              localProjects={move} onMigration={destination => setDialog({ kind: 'migration', destination })}
              onBrowseRemote={() => setDialog({ kind: 'browse-project' })} />}
            {tags}
            {separator}
            {copy}
          </>
        )}
        {session.status === 'active' && !session.orcaRole && !empty && (
          <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => setDialog('shared')}>
            {t('sharedTask.title')}
          </DropdownMenuItem>
        )}
        {!guest && (
          <>
            {exportShare}
            {!archived && !empty && (
              <>
                {separator}
                {item('openInNewWindow', onOpenInNewWindow, writeBlocked)}
              </>
            )}
            {separator}
            {archived
              ? item('unarchive', onUnarchive, writeBlocked)
              : !empty && item('archived', onArchive, writeBlocked)}
            {item('delete', onDelete, writeBlocked)}
          </>
        )}
      </DropdownMenuContent>
      {typeof dialog === 'object' && dialog?.kind === 'migration' && <TaskMigrationDialog
        session={session} destination={dialog.destination} onDismiss={() => { setDialog(null); requestAnimationFrame(returnFocus); }} />}
      {typeof dialog === 'object' && dialog?.kind === 'browse-project' && session.deviceLinkDeviceId && <AddRemoteProjectDialog
        open onOpenChange={open => { if (!open) setDialog(null); }} initialDeviceId={session.deviceLinkDeviceId} fixedDeviceId={session.deviceLinkDeviceId}
        title={t('ccAgent.sidebar.sessionMenu.moveToProject')} confirmText={t('ccAgent.sidebar.sessionMenu.moveToProject')} errorText={t('taskMove.failed')}
        onProjectAdded={async target => {
          if (target.kind !== 'device-link' || target.deviceId !== session.deviceLinkDeviceId) throw new Error('MIGRATION_ACCESS_REVOKED');
          await moveRemoteTaskProject(session, target.path);
        }} />}
      {dialog === 'shared' && (
        <SharedTaskButton
          session={session}
          dialogControl={{
            onDismiss: () => setDialog(null),
            returnFocus,
          }}
        />
      )}
    </div>
  );
}
