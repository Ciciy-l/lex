import { History, Loader2, Send, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { Message } from '@/lib/ccAgent.types';
import type {
  OrcaContextPolicy,
  OrcaWorkerContextSupport,
} from '../../../shared/orcaContextPolicy';
import type { WorkerInfo } from './hooks/useWorkers';

interface WorkerContextStatus {
  contextSupport: OrcaWorkerContextSupport;
  clearedAt: number | null;
  historyRetained: boolean;
}

interface DispatchFailure {
  ok: false;
  errorCode?: string;
  message?: string;
  contextOutcome?: { policy: OrcaContextPolicy; outcome: string; applied: boolean };
  /** Policy the user submitted, preserved even if the selector resets after a rejection. */
  requestedPolicy?: OrcaContextPolicy;
}

const UNSUPPORTED: OrcaWorkerContextSupport = {
  clear: { supported: false, reason: 'host-version' },
  compact: { supported: false, reason: 'host-version' },
};

function reasonKey(reason: string | undefined): string {
  switch (reason) {
    case 'remote-session':
      return 'orca.dispatch.unsupportedRemoteSession';
    case 'manual-compact-unavailable':
      return 'orca.dispatch.unsupportedManualCompact';
    case 'native-presentation':
      return 'orca.dispatch.unsupportedNativePresentation';
    case 'native-completion-unverified':
      return 'orca.dispatch.unsupportedNativeUnverified';
    default:
      return 'orca.dispatch.unsupportedHost';
  }
}

interface HistoryContent {
  text: string | null;
  source: 'lead' | 'worker' | null;
}

/**
 * Clear-history rows are persisted provider payloads, not guaranteed strings.
 * Extract only user-readable text; never render the raw JSON envelope or its
 * internal field names (orcaSource/content/providerId/message).
 */
function readHistoryContent(content: unknown, depth = 0): HistoryContent {
  if (depth > 4) return { text: null, source: null };
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return readHistoryContent(JSON.parse(trimmed), depth + 1);
      } catch {
        return { text: content, source: null };
      }
    }
    return { text: content, source: null };
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    let source: HistoryContent['source'] = null;
    for (const block of content) {
      if (typeof block === 'string') {
        const text = readHistoryContent(block, depth + 1).text;
        if (text) parts.push(text);
        continue;
      }
      if (!block || typeof block !== 'object') continue;
      const value = block as Record<string, unknown>;
      if (value.type === 'text' && typeof value.text === 'string') {
        parts.push(value.text);
        continue;
      }
      if (value.type === 'image' || value.type === 'file') continue;
      const nested = readHistoryContent(value, depth + 1);
      if (nested.text) parts.push(nested.text);
      if (nested.source) source = nested.source;
    }
    return { text: parts.length > 0 ? parts.join('\n') : null, source };
  }
  if (content && typeof content === 'object') {
    const value = content as Record<string, unknown>;
    const source =
      value.orcaSource === 'lead' || value.orcaSource === 'worker'
        ? value.orcaSource
        : null;
    for (const key of ['text', 'content', 'message'] as const) {
      const nestedValue = value[key];
      if (
        typeof nestedValue === 'string'
        || Array.isArray(nestedValue)
        || (nestedValue !== null && typeof nestedValue === 'object')
      ) {
        const nested = readHistoryContent(nestedValue, depth + 1);
        if (nested.text) return { text: nested.text, source: source ?? nested.source };
      }
    }
    return { text: null, source };
  }
  if (typeof content === 'number' || typeof content === 'boolean') {
    return { text: String(content), source: null };
  }
  return { text: null, source: null };
}

function historyRoleKey(role: Message['role']): string {
  if (role === 'user') return 'orca.dispatch.roleUser';
  if (role === 'assistant') return 'orca.dispatch.roleAssistant';
  return 'orca.dispatch.roleTool';
}

function historySourceKey(source: HistoryContent['source']): string | null {
  if (source === 'lead') return 'orca.dispatch.sourceLead';
  if (source === 'worker') return 'orca.dispatch.sourceWorker';
  return null;
}

function formatHistoryTime(value: Message['createdAt'], locale: string): string | null {
  const ms = typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : NaN;
  if (!Number.isFinite(ms)) return null;
  try {
    return new Intl.DateTimeFormat(locale || undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(ms);
  } catch {
    return null;
  }
}

export interface WorkerDispatchDialogProps {
  open: boolean;
  onClose(): void;
  leadSessionId: string;
  worker: WorkerInfo | null;
}

/**
 * Lightweight user-initiated dispatch entry for the focused Worker. The Lead's
 * MCP tool remains the primary path; this dialog exists so a user can choose an
 * explicit context policy and inspect retained pre-clear history locally.
 */
export function WorkerDispatchDialog({
  open,
  onClose,
  leadSessionId,
  worker,
}: WorkerDispatchDialogProps) {
  const { t, i18n } = useTranslation();
  const [message, setMessage] = useState('');
  const [policy, setPolicy] = useState<OrcaContextPolicy>('keep');
  const [status, setStatus] = useState<WorkerContextStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<DispatchFailure | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<Message[] | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [expandedHistoryIds, setExpandedHistoryIds] = useState<Set<string>>(new Set());
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const policyOptionRefs = useRef(new Map<OrcaContextPolicy, HTMLButtonElement>());
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const statusRequestRef = useRef(0);

  const support = status?.contextSupport ?? UNSUPPORTED;

  const workerId = worker?.workerId ?? null;
  const readStatus = useCallback(async (): Promise<WorkerContextStatus | null> => {
    if (!workerId) return null;
    const request = ++statusRequestRef.current;
    try {
      const raw = await window.electronAPI.localDb.orcaWorkflows.getWorkerContextStatus(
        leadSessionId,
        workerId,
      );
      if (request !== statusRequestRef.current) return null;
      const value = raw as Partial<WorkerContextStatus> | null;
      if (!value || typeof value !== 'object' || !value.contextSupport) return null;
      return {
        contextSupport: value.contextSupport,
        clearedAt: value.clearedAt ?? null,
        historyRetained: value.historyRetained === true,
      };
    } catch {
      return null;
    }
  }, [leadSessionId, workerId]);

  useEffect(() => {
    if (!open) return;
    // Capture the trigger before the initial textarea focus steals it, then
    // restore it on every close path (Escape, scrim, close button, success).
    const active = document.activeElement;
    returnFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    setMessage('');
    setPolicy('keep');
    setStatus(null);
    setStatusFailed(false);
    setFailure(null);
    setHistoryOpen(false);
    setHistory(null);
    setHistoryHasMore(false);
    setHistoryLoading(false);
    setHistoryLoadingMore(false);
    setExpandedHistoryIds(new Set());
    const timer = window.setTimeout(() => textareaRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(timer);
      statusRequestRef.current += 1;
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      if (target && target !== document.body) target.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open || !workerId) return;
    let cancelled = false;
    void readStatus().then((next) => {
      if (cancelled) return;
      if (next) {
        setStatus(next);
        setStatusFailed(false);
      } else {
        setStatus(null);
        setStatusFailed(true);
      }
    });
    return () => {
      cancelled = true;
      statusRequestRef.current += 1;
    };
  }, [open, workerId, readStatus]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !sending) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, sending, onClose]);

  const policyOptions = useMemo(
    () =>
      [
        {
          value: 'keep' as const,
          label: t('orca.dispatch.policyKeep'),
          hint: t('orca.dispatch.policyKeepHint'),
          capability: { supported: true as const },
        },
        {
          value: 'clear' as const,
          label: t('orca.dispatch.policyClear'),
          hint: t('orca.dispatch.policyClearHint'),
          capability: support.clear,
        },
        {
          value: 'compact' as const,
          label: t('orca.dispatch.policyCompact'),
          hint: support.compact.provisional
            ? t('orca.dispatch.policyCompactProvisionalHint')
            : t('orca.dispatch.policyCompactHint'),
          capability: support.compact,
        },
      ],
    [support, t],
  );

  const failureReason = useMemo(() => {
    if (!failure) return null;
    switch (failure.errorCode) {
      case 'BUSY':
        return t('orca.dispatch.failureBusy');
      case 'CONTEXT_POLICY_UNSUPPORTED': {
        const failedPolicy = failure.contextOutcome?.policy ?? failure.requestedPolicy ?? policy;
        const capability = failedPolicy === 'clear'
          ? support.clear
          : failedPolicy === 'compact'
            ? support.compact
            : null;
        return capability?.reason
          ? t(reasonKey(capability.reason))
          : t('orca.dispatch.failureContextUnsupported');
      }
      case 'CONTEXT_PREPARATION_FAILED':
        return t('orca.dispatch.failurePreparation');
      case 'AGENT_NOT_READY':
        return t('orca.dispatch.failureAgentNotReady');
      case 'NOT_FOUND':
        return t('orca.dispatch.failureNotFound');
      default:
        return t('orca.dispatch.failureGeneric');
    }
  }, [failure, policy, support, t]);

  const loadHistory = useCallback(async () => {
    if (!worker || historyLoading) return;
    setHistoryOpen(true);
    if (history !== null) return;
    setHistoryLoading(true);
    try {
      // Load every page up to a bounded safety cap so the audit view is a
      // complete history, not just the newest 30 rows. Hosts that predate
      // hasMore are handled by the full-page inference.
      const collected: Message[] = [];
      let before: string | undefined;
      let hasMore = true;
      for (let page = 0; page < 10 && hasMore; page += 1) {
        const result = await window.electronAPI.localDb.messages.listCleared(worker.sessionId, {
          limit: 30,
          ...(before ? { before } : {}),
        });
        if (result.messages.length === 0) {
          hasMore = false;
          break;
        }
        collected.push(...result.messages);
        before = result.messages[result.messages.length - 1]!.id;
        hasMore = result.hasMore === undefined
          ? result.messages.length === 30
          : result.hasMore;
      }
      setHistory(collected);
      setHistoryHasMore(hasMore);
      setExpandedHistoryIds(new Set(collected.map((item) => item.id)));
    } catch {
      toast.error(t('orca.dispatch.historyLoadFailed'));
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [worker, history, historyLoading, t]);

  const loadMoreHistory = useCallback(async () => {
    if (!worker || !history || history.length === 0 || historyLoadingMore || !historyHasMore) return;
    setHistoryLoadingMore(true);
    try {
      const result = await window.electronAPI.localDb.messages.listCleared(worker.sessionId, {
        limit: 30,
        before: history[history.length - 1]!.id,
      });
      setHistory((current) => [...(current ?? []), ...result.messages]);
      setExpandedHistoryIds((current) => {
        const next = new Set(current);
        for (const item of result.messages) next.add(item.id);
        return next;
      });
      setHistoryHasMore(result.hasMore === true);
    } catch {
      toast.error(t('orca.dispatch.historyLoadFailed'));
    } finally {
      setHistoryLoadingMore(false);
    }
  }, [worker, history, historyHasMore, historyLoadingMore, t]);

  const toggleHistoryExpanded = useCallback((id: string) => {
    setExpandedHistoryIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handlePolicyKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const enabled = policyOptions.filter(
        (option) => option.capability.supported === true && !sending,
      );
      if (enabled.length === 0) return;
      const currentIndex = Math.max(0, enabled.findIndex((option) => option.value === policy));
      let nextIndex: number | null = null;
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        nextIndex = (currentIndex + 1) % enabled.length;
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        nextIndex = (currentIndex - 1 + enabled.length) % enabled.length;
      } else if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = enabled.length - 1;
      }
      if (nextIndex === null) return;
      event.preventDefault();
      const next = enabled[nextIndex]!;
      setPolicy(next.value);
      policyOptionRefs.current.get(next.value)?.focus();
    },
    [policyOptions, policy, sending],
  );

  const handleSend = useCallback(async () => {
    if (!worker || sending) return;
    const text = message.trim();
    if (!text) return;
    setSending(true);
    setFailure(null);
    try {
      const result = (await window.electronAPI.localDb.orcaWorkflows.sendWorkerTask({
        leadSessionId,
        workerId: worker.workerId,
        message: text,
        contextPolicy: policy,
      })) as
        | { ok: true }
        | DispatchFailure
        | null;
      if (!result || result.ok !== true) {
        setFailure({ ...(result ?? { ok: false }), requestedPolicy: policy });
        // A dormant Codex/Pi may only discover that the resumed runtime cannot
        // compact after prepare. Refresh the capability projection immediately
        // so the dialog explains the concrete local reason without a reopen.
        if (policy !== 'keep') {
          void readStatus().then((next) => {
            if (next) {
              setStatus(next);
              setStatusFailed(false);
              if (next.contextSupport[policy].supported !== true) setPolicy('keep');
            }
          });
        }
        return;
      }
      toast.success(t('orca.dispatch.sent'));
      onClose();
    } catch {
      setFailure({ ok: false, requestedPolicy: policy });
      if (policy !== 'keep') {
        void readStatus().then((next) => {
          if (next) {
            setStatus(next);
            setStatusFailed(false);
            if (next.contextSupport[policy].supported !== true) setPolicy('keep');
          }
        });
      }
    } finally {
      setSending(false);
    }
  }, [worker, sending, message, leadSessionId, policy, onClose, t, readStatus]);

  if (!open || !worker) return null;

  const workerName = worker.label || worker.role;
  const canSend = message.trim().length > 0 && !sending && status !== null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-[var(--overlay-modal)]"
        onClick={() => {
          if (!sending) onClose();
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="orca-dispatch-title"
        className="relative z-10 flex max-h-[calc(100vh_-_32px)] w-[520px] max-w-[calc(100vw_-_32px)] flex-col overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]"
        style={{ boxShadow: 'var(--shadow-menu)' }}
      >
        <div
          data-testid="orca-dispatch-scroll"
          className="min-h-0 flex-1 overflow-y-auto p-4"
        >
          <div className="mb-4 flex items-center justify-between">
            <div className="min-w-0">
              <h2
                id="orca-dispatch-title"
                className="truncate text-16 font-medium text-[var(--text-primary)]"
              >
                {t('orca.dispatch.title', { name: workerName })}
              </h2>
            </div>
            <button
              type="button"
              aria-label={t('orca.dispatch.close')}
              disabled={sending}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50"
              onClick={onClose}
            >
              <X size={15} />
            </button>
          </div>

          <label className="mb-1 block text-12 font-medium text-[var(--text-secondary)]" htmlFor="orca-dispatch-message">
            {t('orca.dispatch.messageLabel')}
          </label>
          <textarea
            id="orca-dispatch-message"
            ref={textareaRef}
            className="mb-4 h-[110px] min-h-[88px] w-full resize-none rounded-lg border border-[var(--border-default)] bg-transparent px-3.5 py-2.5 text-13 leading-snug text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:border-[var(--text-secondary)]"
            placeholder={t('orca.dispatch.messagePlaceholder')}
            value={message}
            disabled={sending}
            onChange={(event) => setMessage(event.target.value)}
          />

          <fieldset className="mb-4 min-w-0">
            <legend className="mb-2 text-12 font-medium text-[var(--text-secondary)]">
              {t('orca.dispatch.contextLabel')}
            </legend>
            <div
              className="grid gap-2"
              role="radiogroup"
              aria-label={t('orca.dispatch.contextLabel')}
              onKeyDown={handlePolicyKeyDown}
            >
              {policyOptions.map((option) => {
                const disabled = option.capability.supported !== true || sending;
                const selected = policy === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    tabIndex={selected ? 0 : -1}
                    ref={(node) => {
                      if (node) policyOptionRefs.current.set(option.value, node);
                      else policyOptionRefs.current.delete(option.value);
                    }}
                    disabled={disabled}
                    className={cn(
                      'rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                      selected
                        ? 'border-[var(--text-secondary)] bg-[var(--surface-chip)]'
                        : 'border-[var(--border-default)] hover:bg-[var(--surface-hover)]',
                      disabled && 'cursor-not-allowed opacity-55 hover:bg-transparent',
                    )}
                    onClick={() => setPolicy(option.value)}
                  >
                    <span className="flex items-center gap-2 text-13 font-medium text-[var(--text-primary)]">
                      {option.label}
                      {selected && (
                        <span aria-hidden className="text-11 text-[var(--text-secondary)]">
                          ✓
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-11 leading-snug text-[var(--text-tertiary)]">
                      {option.capability.supported !== true
                        ? t(reasonKey(option.capability.reason))
                        : option.hint}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          {statusFailed && (
            <p className="mb-3 text-12 text-[var(--error-fg)]" role="alert">
              {t('orca.dispatch.unsupportedHost')}
            </p>
          )}

          {failure && (
            <div className="mb-3 rounded-lg border border-[var(--border-default)] px-3 py-2" role="alert">
              <p className="text-12 font-medium text-[var(--error-fg)]">
                {failure.contextOutcome?.applied
                  ? t('orca.dispatch.clearAppliedFailure')
                  : t('orca.dispatch.failed')}
              </p>
              {failureReason && (
                <p className="mt-1 break-words text-11 leading-snug text-[var(--text-secondary)]">
                  {failureReason}
                </p>
              )}
              {failure.errorCode === 'CONTEXT_POLICY_UNSUPPORTED' && (
                <p className="mt-0.5 break-words text-11 leading-snug text-[var(--text-tertiary)]">
                  {t('orca.dispatch.failureContextUnsupportedAction')}
                </p>
              )}
            </div>
          )}

          {status?.historyRetained && (
            <div>
              <button
                type="button"
                className="inline-flex min-h-6 items-center gap-1.5 rounded py-0.5 text-12 text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                aria-expanded={historyOpen}
                onClick={() => void loadHistory()}
              >
                <History size={13} />
                {t('orca.dispatch.viewHistory')}
              </button>
              {historyOpen && (
                <div
                  data-testid="orca-dispatch-history"
                  className="mt-2 max-h-[180px] overflow-y-auto rounded-xl border border-[var(--border-default)] p-2"
                >
                  {historyLoading ? (
                    <div className="flex items-center justify-center py-4 text-[var(--text-tertiary)]">
                      <Loader2 size={14} className="animate-spin" />
                    </div>
                  ) : history && history.length > 0 ? (
                    <ul className="space-y-2">
                      {history.map((item) => {
                        const content = readHistoryContent(item.content);
                        const text = content.text;
                        const sourceKey = historySourceKey(content.source);
                        const time = formatHistoryTime(item.createdAt, i18n.language);
                        const truncated = (text?.length ?? 0) > 600;
                        const expanded = expandedHistoryIds.has(item.id);
                        return (
                          <li key={item.id} className="rounded-lg bg-[var(--surface-chip)] px-2.5 py-2">
                            <div className="mb-0.5 flex flex-wrap items-center gap-x-1.5 text-10 uppercase tracking-wide text-[var(--text-tertiary)]">
                              <span>{t(historyRoleKey(item.role))}</span>
                              {sourceKey && (
                                <span className="normal-case tracking-normal">· {t(sourceKey)}</span>
                              )}
                              {time && (
                                <time
                                  className="ml-auto shrink-0 normal-case tracking-normal"
                                  dateTime={typeof item.createdAt === 'string' ? item.createdAt : undefined}
                                >
                                  {time}
                                </time>
                              )}
                            </div>
                            {text ? (
                              <p className="whitespace-pre-wrap break-words text-11 leading-snug text-[var(--text-secondary)]">
                                {expanded || !truncated ? text : `${text.slice(0, 600)}…`}
                              </p>
                            ) : (
                              <p className="text-11 leading-snug text-[var(--text-tertiary)]">
                                {t('orca.dispatch.historyUnsupportedContent')}
                              </p>
                            )}
                            {truncated && (
                              <button
                                type="button"
                                className="mt-1 min-h-6 rounded py-0.5 text-11 text-[var(--text-secondary)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                                aria-expanded={expanded}
                                onClick={() => toggleHistoryExpanded(item.id)}
                              >
                                {expanded ? t('orca.dispatch.collapse') : t('orca.dispatch.showFull')}
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="py-3 text-center text-11 text-[var(--text-tertiary)]">
                      {t('orca.dispatch.historyEmpty')}
                    </p>
                  )}
                  {historyHasMore && (
                    <button
                      type="button"
                      className="mt-2 inline-flex min-h-6 w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                      disabled={historyLoadingMore}
                      onClick={() => void loadMoreHistory()}
                    >
                      {historyLoadingMore ? <Loader2 size={12} className="animate-spin" /> : null}
                      {historyLoadingMore
                        ? t('orca.dispatch.loadingMore')
                        : t('orca.dispatch.loadMore')}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-[var(--border-default)] p-4">
          <button
            type="button"
            className={cn(
              'inline-flex w-full items-center justify-center gap-2 rounded-full py-2.5 text-13 font-medium leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
              canSend
                ? 'bg-[var(--confirm-btn-primary-bg)] text-[var(--confirm-btn-primary-text)] hover:bg-[var(--confirm-btn-primary-hover)]'
                : 'cursor-not-allowed bg-[var(--surface-chip)] text-[var(--text-tertiary)]',
            )}
            disabled={!canSend}
            aria-busy={sending}
            onClick={() => void handleSend()}
          >
            {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            {sending ? t('orca.dispatch.sending') : t('orca.dispatch.send')}
          </button>
        </div>
      </div>
    </div>
  );
}
