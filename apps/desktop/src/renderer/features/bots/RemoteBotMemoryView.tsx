import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { REMOTE_RESOURCE_GET_CHANNEL, REMOTE_RESOURCE_INVOKE_CHANNEL, resolveRemoteText, type RemoteResource } from '@cindy/device-link';
import type { RemoteBot } from './remoteBotRoster';

interface Props { bot: RemoteBot }
interface Entry { id: string; title: string; subtitle?: string; resourceId: string }
interface Group { id: string; title: string; count: number; entries: Entry[] }
interface FormValue { title: string; body: string; expectedUpdatedAt: string }
interface RequestToken { generation: number; identity: string; resourceId: string }
type DraftStore = Map<string, FormValue>;
const row = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, locale: string): string => typeof value === 'string' ? value : value && typeof value === 'object' ? resolveRemoteText(value as never, locale) : '';
const remoteError = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
const sameDraft = (form: FormValue | null, draft: FormValue): boolean =>
  Boolean(form && form.title === draft.title && form.body === draft.body);
function currentRequest(
  token: RequestToken,
  generation: { current: number },
  identity: { current: string },
  resource: { current: string },
): boolean {
  return token.generation === generation.current
    && token.identity === identity.current
    && token.resourceId === resource.current;
}
const draftKeyFor = (identity: string, resourceId: string): string => identity + '\u0000' + resourceId;

function groupsOf(resource: RemoteResource, locale: string): Group[] {
  return (resource.blocks ?? []).filter((block) => block.primitive === 'list').flatMap((block) => {
    const data = row(block.data);
    const entries = Array.isArray(data.entries) ? data.entries.flatMap((candidate) => {
      const item = row(candidate);
      const id = typeof item.id === 'string' ? item.id : '';
      const resourceId = typeof item.resourceId === 'string' ? item.resourceId : '';
      const title = text(item.title, locale);
      return id && resourceId && title ? [{ id, resourceId, title, subtitle: text(item.subtitle, locale) || undefined }] : [];
    }) : [];
    return entries.length ? [{ id: block.id, title: text(block.title, locale) || block.id, count: typeof data.count === 'number' ? data.count : entries.length, entries }] : [];
  });
}
function formOf(resource: RemoteResource, locale: string): FormValue | null {
  const block = resource.blocks?.find((candidate) => candidate.primitive === 'form');
  const values = row(block?.data && row(block.data).values);
  return block ? { title: typeof values.title === 'string' ? values.title : text(resource.display.title, locale), body: typeof values.body === 'string' ? values.body : block.fallbackMarkdown, expectedUpdatedAt: typeof values.expectedUpdatedAt === 'string' ? values.expectedUpdatedAt : resource.revision } : null;
}

export function RemoteBotMemoryView({ bot }: Props) {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const baseId = `settings:${bot.id}/memory`;
  const client = useMemo(() => ({ protocolVersion: 1, primitives: ['status', 'search', 'list', 'form', 'action'] }), []);
  const [resource, setResource] = useState<RemoteResource | null>(null);
  const [detail, setDetail] = useState<RemoteResource | null>(null);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<FormValue | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<RemoteResource | null>(null);
  const generation = useRef(0);
  const drafts = useRef<DraftStore>(new Map());
  const operationSequence = useRef(0);
  const activeOperation = useRef<number | null>(null);
  const identityKey = bot.deviceId + ':' + bot.id;
  const activeIdentity = useRef(identityKey);
  const activeResource = useRef(baseId);
  if (activeIdentity.current !== identityKey) {
    activeIdentity.current = identityKey;
    activeResource.current = baseId;
    generation.current += 1;
    activeOperation.current = null;
  }
  const draftKey = (resourceId: string) => draftKeyFor(identityKey, resourceId);
  const beginOperation = () => {
    const operation = ++operationSequence.current;
    activeOperation.current = operation;
    setBusy(true);
    return operation;
  };
  const finishOperation = (operation: number) => {
    if (activeOperation.current !== operation) return;
    activeOperation.current = null;
    setBusy(false);
  };
  const invalidateRequests = () => {
    generation.current += 1;
    activeResource.current = baseId;
    activeOperation.current = null;
    setBusy(false);
  };
  const updateDraft = (update: (current: FormValue) => FormValue) => {
    setDraft((current) => {
      if (!current) return current;
      const next = update(current);
      drafts.current.set(draftKey(activeResource.current), next);
      return next;
    });
  };
  const tokenFor = (resourceId: string): RequestToken => ({
    generation: generation.current, identity: identityKey, resourceId,
  });
  const get = useCallback(async (id: string, filter?: string) => {
    const request = { client, ref: { collectionId: 'teammates', kind: 'bot', id }, ...(filter ? { query: filter } : {}) };
    return window.electronAPI.deviceLink.invoke(bot.deviceId, REMOTE_RESOURCE_GET_CHANNEL, [request]) as Promise<RemoteResource>;
  }, [bot.deviceId, client]);
  const loadList = useCallback(async (filter = query) => {
    activeResource.current = baseId;
    const token = { ...tokenFor(baseId), generation: ++generation.current };
    try {
      setError(null);
      const next = await get(baseId, filter);
      if (currentRequest(token, generation, activeIdentity, activeResource)) setResource(next);
    } catch (cause) {
      if (currentRequest(token, generation, activeIdentity, activeResource)) setError(remoteError(cause));
    }
  }, [baseId, get, identityKey, query]);
  const loadDetail = useCallback(async (id: string) => {
    activeResource.current = id;
    const token = { ...tokenFor(id), generation: ++generation.current };
    try {
      setError(null);
      const next = await get(id);
      if (currentRequest(token, generation, activeIdentity, activeResource)) {
        setDetail(next);
        const loaded = formOf(next, locale);
        const saved = drafts.current.get(draftKey(id));
        if (saved) setDraft(saved);
        else {
          if (loaded) drafts.current.set(draftKey(id), loaded);
          setDraft(loaded);
        }
      }
    } catch (cause) {
      if (currentRequest(token, generation, activeIdentity, activeResource)) setError(remoteError(cause));
    }
  }, [get, identityKey, locale]);
  useEffect(() => () => { generation.current += 1; activeOperation.current = null; }, []);
  useEffect(() => {
    if (activeIdentity.current !== identityKey) return;
    activeOperation.current = null;
    setBusy(false);
    setSelected(null);
    setDetail(null);
    setDraft(null);
    setConflict(null);
  }, [identityKey]);
  useEffect(() => { if (!selected) void loadList(query); }, [loadList, query, selected]);
  const open = (id: string) => {
    setSelected(id);
    setDetail(null);
    setDraft(drafts.current.get(draftKey(id)) ?? null);
    setConflict(null);
    void loadDetail(id);
  };
  const invoke = async (resourceRef: RemoteResource['ref'], actionId: string, input: Record<string, unknown>) => window.electronAPI.deviceLink.invoke(bot.deviceId, REMOTE_RESOURCE_INVOKE_CHANNEL, [{ client, collectionId: 'teammates', actionId, resourceRef, input }]);
  const save = async () => {
    if (!detail || !draft || busy) return;
    const currentDetail = detail;
    const currentDraft = draft;
    const token = tokenFor(currentDetail.ref.id);
    const operation = beginOperation();
    setError(null);
    try {
      const latest = await get(currentDetail.ref.id); const latestForm = formOf(latest, locale);
      if (!currentRequest(token, generation, activeIdentity, activeResource)) return;
      if (!latestForm || latest.revision !== currentDraft.expectedUpdatedAt) { setConflict(latest); return; }
      const input: Record<string, unknown> = { expectedUpdatedAt: latest.revision };
      if (currentDraft.title !== latestForm.title) input.title = currentDraft.title;
      if (currentDraft.body !== latestForm.body) input.body = currentDraft.body;
      if (Object.keys(input).length > 1) await invoke(latest.ref, 'memory-update', input);
      if (!currentRequest(token, generation, activeIdentity, activeResource)) return;
      const next = await get(latest.ref.id);
      if (!currentRequest(token, generation, activeIdentity, activeResource)) return;
      const nextDraft = formOf(next, locale);
      if (nextDraft) drafts.current.set(draftKey(currentDetail.ref.id), nextDraft);
      setDetail(next); setDraft(nextDraft); setConflict(null);
    } catch (cause) {
      if (!currentRequest(token, generation, activeIdentity, activeResource)) return;
      try {
        const next = await get(currentDetail.ref.id);
        if (!currentRequest(token, generation, activeIdentity, activeResource)) return;
        const nextForm = formOf(next, locale);
        // A timeout may have committed our exact draft. Reconcile it as a
        // success, but never resend a mutation whose result is unknown.
        if (sameDraft(nextForm, currentDraft)) {
          if (nextForm) drafts.current.set(draftKey(currentDetail.ref.id), nextForm);
          setDetail(next); setDraft(nextForm); setConflict(null);
        } else if (next.revision !== currentDraft.expectedUpdatedAt) setConflict(next);
        else setError(remoteError(cause));
      } catch { if (currentRequest(token, generation, activeIdentity, activeResource)) setError(remoteError(cause)); }
    } finally { finishOperation(operation); }
  };
  const remove = async () => {
    if (!detail || !draft || busy || !window.confirm(t('bots.memory.deleteTitle'))) return;
    const currentDetail = detail;
    const currentDraft = draft;
    const token = tokenFor(currentDetail.ref.id);
    const operation = beginOperation();
    setError(null);
    try {
      const latest = await get(currentDetail.ref.id);
      if (!currentRequest(token, generation, activeIdentity, activeResource)) return;
      if (latest.revision !== currentDraft.expectedUpdatedAt) { setConflict(latest); return; }
      await invoke(latest.ref, 'memory-delete', { expectedUpdatedAt: latest.revision });
      if (!currentRequest(token, generation, activeIdentity, activeResource)) return;
      drafts.current.delete(draftKey(currentDetail.ref.id));
      activeResource.current = baseId;
      generation.current += 1;
      activeOperation.current = null;
      setBusy(false);
      setSelected(null); setDetail(null); setDraft(null); setConflict(null); await loadList('');
    }
    catch (cause) {
      try {
        if (!currentRequest(token, generation, activeIdentity, activeResource)) return;
        const next = await get(currentDetail.ref.id);
        if (!currentRequest(token, generation, activeIdentity, activeResource)) return;
        if (next.revision !== currentDraft.expectedUpdatedAt) setConflict(next);
        else setError(remoteError(cause));
      } catch { if (currentRequest(token, generation, activeIdentity, activeResource)) setError(remoteError(cause)); }
    } finally { finishOperation(operation); }
  };
  const groups = resource ? groupsOf(resource, locale) : [];
  const back = () => {
    invalidateRequests();
    if (selected) { setSelected(null); setDetail(null); setDraft(null); setConflict(null); }
    else navigate('/bots/remote/' + encodeURIComponent(bot.deviceId) + '/' + encodeURIComponent(bot.id));
  };
  return <main className="flex h-full min-h-0 flex-col bg-[var(--surface)]">
    <header className="flex items-center gap-3 border-b border-[var(--border-default)] px-4 py-3">
      <button type="button" aria-label={t('bots.settingsBack')} className="rounded-[8px] px-2 py-1 text-14 hover:bg-[var(--surface-hover)]" onClick={back}>←</button>
      <div className="min-w-0"><h1 className="truncate text-16 font-medium text-[var(--text-primary)]">{t('bots.memory.title')}</h1><p className="truncate text-12 text-[var(--text-secondary)]">{bot.name} · {bot.deviceName}</p></div>
    </header>
    <div className="min-h-0 flex-1 overflow-auto p-4">
      {error ? <p role="alert" className="mb-3 rounded-[8px] border border-[var(--status-danger)]/30 p-3 text-13 text-[var(--status-danger)]">{error}</p> : null}
      {!selected ? <><input aria-label={t('bots.memory.search')} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('bots.memory.search')} className="mb-4 w-full rounded-[8px] border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2 text-13 text-[var(--text-primary)] outline-none" />{groups.length ? <div className="space-y-4">{groups.map((group) => <section key={group.id}><h2 className="mb-2 text-12 font-medium text-[var(--text-secondary)]">{group.title} <span className="text-[var(--text-tertiary)]">{group.count}</span></h2><div className="divide-y divide-[var(--border-default)] overflow-hidden rounded-[8px] border border-[var(--border-default)]">{group.entries.map((entry) => <button key={entry.resourceId} type="button" className="block w-full px-3 py-3 text-left hover:bg-[var(--surface-hover)]" onClick={() => open(entry.resourceId)}><span className="block text-14 text-[var(--text-primary)]">{entry.title}</span>{entry.subtitle ? <span className="mt-1 block text-12 text-[var(--text-secondary)]">{entry.subtitle}</span> : null}</button>)}</div></section>)}</div> : <p className="text-13 text-[var(--text-secondary)]">{query ? t('bots.memory.noResults') : t('bots.memory.empty')}</p>}</> : detail && draft ? <div className="mx-auto max-w-2xl space-y-4">{conflict ? <div role="alert" className="space-y-3 rounded-[8px] border border-[var(--status-danger)]/40 bg-[var(--surface-elevated)] p-4"><p className="text-13 text-[var(--status-danger)]">{t('bots.memory.conflict')}</p><button type="button" className="rounded-[8px] border px-3 py-2 text-13" onClick={() => { const next = formOf(conflict, locale); if (next) drafts.current.set(draftKey(detail.ref.id), next); setDetail(conflict); setDraft(next); setConflict(null); }}>{t('bots.memory.useLatest')}</button><button type="button" className="rounded-[8px] border px-3 py-2 text-13" onClick={() => { if (conflict) updateDraft((current) => ({ ...current, expectedUpdatedAt: conflict.revision })); setConflict(null); }}>{t('bots.memory.keepMine')}</button></div> : null}<input aria-label={t('bots.memory.titleLabel')} value={draft.title} disabled={busy} onChange={(event) => updateDraft((current) => ({ ...current, title: event.target.value }))} className="w-full rounded-[8px] border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2 text-14 text-[var(--text-primary)]" /><textarea aria-label={t('bots.memory.bodyLabel')} value={draft.body} disabled={busy} onChange={(event) => updateDraft((current) => ({ ...current, body: event.target.value }))} className="min-h-64 w-full rounded-[8px] border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2 text-14 text-[var(--text-primary)]" /><div className="flex gap-2"><button type="button" className="rounded-[8px] bg-[var(--accent)] px-3 py-2 text-13 text-white disabled:opacity-50" disabled={busy} onClick={() => void save()}>{t('bots.save')}</button><button type="button" className="rounded-[8px] border border-[var(--status-danger)] px-3 py-2 text-13 text-[var(--status-danger)] disabled:opacity-50" disabled={busy} onClick={() => void remove()}>{t('bots.memory.delete')}</button></div></div> : <p className="text-13 text-[var(--text-secondary)]">{t('ccAgent.common.loading', { defaultValue: 'Loading…' })}</p>}
    </div>
  </main>;
}
