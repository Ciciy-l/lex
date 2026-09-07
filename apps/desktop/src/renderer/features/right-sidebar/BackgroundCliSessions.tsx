import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Square, Trash2, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { toast } from '@/lib/toast';
import type { TerminalRuntimeRecord } from '../../../shared/terminal-bridge';
import { openOrFocusTerminal, forgetTerminal } from './lib/terminalNavigation';
import { getBucket, subscribe } from './store';
import { cliSessionGroups } from './lib/cliSessionItems';

/** CLI processes are listed separately from Maker's background calls. */
export function BackgroundCliSessions({
  sessionId,
  enabled,
  visible,
}: {
  sessionId: string;
  enabled: boolean;
  visible: boolean;
}) {
  const { t } = useTranslation();
  const statusLabels = {
    running: t('rightSidebar.terminal.process.running'),
    terminating: t('rightSidebar.terminal.process.terminating'),
    exited: t('rightSidebar.terminal.process.exited'),
    terminated: t('rightSidebar.terminal.process.terminated'),
    missing: t('rightSidebar.terminal.process.missing'),
  };
  const { confirm } = useConfirmDialog();
  const [snapshot, setSnapshot] = useState<{ sessionId: string; rows: TerminalRuntimeRecord[] }>({
    sessionId,
    rows: [],
  });
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const refreshRef = useRef<() => void>(() => undefined);
  const bucket = useSyncExternalStore(
    useCallback(
      (listener) =>
        subscribe((id) => {
          if (id === sessionId) listener();
        }),
      [sessionId],
    ),
    useCallback(() => getBucket(sessionId), [sessionId]),
  );
  useEffect(() => {
    if (!enabled || !visible) return;
    // Renderer HMR can precede a preload restart. Keep the workspace usable
    // while the host does not yet expose the new runtime navigation API.
    if (
      typeof window.electronAPI.terminal.list !== 'function' ||
      typeof window.electronAPI.terminal.onStatus !== 'function'
    ) {
      setFailed(true);
      return;
    }
    let disposed = false;
    let request = 0;
    const refresh = () => {
      const revision = ++request;
      void window.electronAPI.terminal
        .list(sessionId)
        .then((rows) => {
          if (disposed || revision !== request) return;
          setSnapshot({ sessionId, rows });
          setFailed(false);
        })
        .catch(() => {
          if (!disposed && revision === request) setFailed(true);
        });
    };
    refreshRef.current = refresh;
    const off = window.electronAPI.terminal.onStatus((record) => {
      if (record.sessionId === sessionId) refresh();
    });
    refresh();
    return () => {
      disposed = true;
      off();
      refreshRef.current = () => undefined;
    };
  }, [enabled, visible, sessionId]);
  const run = useCallback(
    async (id: string, action: () => Promise<unknown>) => {
      if (busy) return;
      setBusy(id);
      try {
        await action();
      } catch {
        toast.error(t('rightSidebar.terminal.actionFailed'));
      } finally {
        setBusy(null);
        refreshRef.current();
      }
    },
    [busy, t],
  );
  if (!enabled) return null;
  const groups = cliSessionGroups(
    sessionId,
    bucket.tabs,
    snapshot.sessionId === sessionId ? snapshot.rows : [],
  );
  return (
    <section
      aria-label={t('rightSidebar.terminal.sessions')}
      className="border-b border-[var(--border-default)] pb-2"
    >
      <div className="px-3 py-2 text-12 font-medium text-[var(--text-secondary)]">
        {t('rightSidebar.terminal.sessions')}
      </div>
      {failed ? (
        <Button
          size="md"
          variant="secondary"
          className="mx-2 px-2"
          onClick={() => refreshRef.current()}
        >
          {t('rightSidebar.terminal.retryList')}
        </Button>
      ) : groups.length === 0 ? (
        <p className="px-3 py-1 text-12 text-[var(--text-tertiary)]">
          {t('rightSidebar.terminal.noSessions')}
        </p>
      ) : (
        groups.map(group => <details key={group.id} open className="px-1">
          <summary className="cursor-pointer select-none px-2 py-1 text-12 text-[var(--text-secondary)]">
            {group.title || t(group.unplaced ? 'rightSidebar.workbench.unplaced' : 'rightSidebar.terminal.workbenchTitle', { count: group.items.length })}
          </summary>
          {group.items.map((row) => (
          <div key={row.terminalId} className="flex items-center gap-1 px-1">
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-full px-2 py-2 text-left hover:bg-[var(--surface-hover)]"
              disabled={busy !== null}
              onClick={() =>
                void run(row.terminalId, () => openOrFocusTerminal(sessionId, row.terminalId))
              }
            >
              <Terminal size={14} className="shrink-0" />
              <span className="min-w-0">
                <span className="block truncate text-12">{row.title}</span>
                <span className="block text-11 text-[var(--text-tertiary)]">
                  {statusLabels[row.status]}
                  {row.detached ? ' · ' + t('rightSidebar.terminal.hidden') : ''}
                </span>
              </span>
            </button>
            {row.status === 'running' ? (
              <Tip text={t('rightSidebar.terminal.terminate')}>
                <Button
                  variant="secondary"
                  size="md"
                  className="w-8 px-0"
                  disabled={busy !== null}
                  aria-label={t('rightSidebar.terminal.terminate')}
                  onClick={() =>
                    void run(row.terminalId, async () => {
                      if (
                        await confirm({
                          title: t('rightSidebar.terminal.terminate'),
                          description: t('rightSidebar.terminal.terminateConfirm'),
                          confirmVariant: 'destructive',
                          confirmText: t('rightSidebar.terminal.terminate'),
                        })
                      )
                        await window.electronAPI.terminal.terminate(row.terminalId);
                    })
                  }
                >
                  <Square size={13} />
                </Button>
              </Tip>
            ) : (
              row.status !== 'terminating' && (
                <Tip text={t('rightSidebar.terminal.forget')}>
                  <Button
                    variant="secondary"
                    size="md"
                    className="w-8 px-0"
                    disabled={busy !== null}
                    aria-label={t('rightSidebar.terminal.forget')}
                    onClick={() =>
                      void run(row.terminalId, () => forgetTerminal(sessionId, row.terminalId))
                    }
                  >
                    <Trash2 size={13} />
                  </Button>
                </Tip>
              )
            )}
          </div>
        ))}
        </details>)
      )}
    </section>
  );
}
