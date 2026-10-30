import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { emitRefresh } from '@/lib/sessionsBus';
import { getDraft, getFastModeForModel } from '@/state/newMakerDraft';
import { extractIpcError } from '@/utils/ipcError';
import type { CindyImportSource, CindyImportScan, CindyImportPreview, CindyImportResult } from '../../../shared/cindyImport';

// Owned by the import page, not by a source tab: filtering must not cancel work
// or lose selections. Only leaving the page disposes the Main-side controller.
export function useCindyImport() {
  const api = window.electronAPI.localDb.cindyImport;
  const [sources, setSources] = useState<CindyImportSource[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [scan, setScan] = useState<CindyImportScan>();
  const [preview, setPreview] = useState<{ previewId: string; items: CindyImportPreview[] }>();
  const [results, setResults] = useState<CindyImportResult[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [allowIncomplete, setAllowIncomplete] = useState(false);
  const [needsRestart, setNeedsRestart] = useState(false);
  const mounted = useRef(true);
  const initialized = useRef(false);
  const inFlight = useRef(false);
  const canceled = useRef(false);

  function clearReview() {
    setPreview(undefined); setResults(undefined); setAllowIncomplete(false);
  }
  function clearScan() { setScan(undefined); clearReview(); }
  async function perform<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setBusy(true); setError('');
    try { return await action(); }
    catch (error) {
      if (mounted.current) {
        const code = extractIpcError(error)?.message ?? 'importFailed';
        setError(code);
        // Main clears its snapshot on every error except these two. Never keep
        // clickable handles that Main has already invalidated.
        if (!['confirmationRequired', 'unsafePath'].includes(code)) clearScan();
        if (['ownerChanged', 'canceled', 'invalidSelection'].includes(code)) setNeedsRestart(true);
      }
      return undefined;
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const discover = () => perform(async () => {
    canceled.current = false;
    clearScan(); setSources([]); setSourceId('');
    const items = await api.discover();
    if (mounted.current && !canceled.current) {
      setSources(items); setSourceId(items[0]?.id ?? ''); setNeedsRestart(false);
    }
  });
  useEffect(() => {
    mounted.current = true;
    if (!initialized.current) { initialized.current = true; void discover(); }
    return () => {
      mounted.current = false;
      queueMicrotask(() => { if (!mounted.current) void api.cancel().catch(() => undefined); });
    };
  }, []);

  const runScan = () => perform(async () => {
    clearScan();
    const value = await api.scan(sourceId);
    if (mounted.current && !canceled.current) setScan(value);
  });
  const chooseSource = () => perform(async () => {
    const items = await api.chooseSource();
    if (!mounted.current || canceled.current || !items.length) return;
    clearScan();
    setSources((old) => [...old.filter((existing) => !items.some((item) => item.location === existing.location)), ...items]);
    setSourceId(items[0].id);
  });
  const prepare = (ids: string[]) => perform(async () => {
    if (!scan) return;
    clearReview(); // Consent applies only to the missing items in this preview.
    const value = await api.preview(scan.scanId, ids);
    if (mounted.current && !canceled.current) setPreview(value);
  });
  const chooseProject = (id: string) => perform(async () => {
    if (!preview) return;
    const dir = await api.chooseProject(preview.previewId, id);
    if (dir && mounted.current && !canceled.current) setPreview({ ...preview, items: preview.items.map((item) => item.id === id ? { ...item, workingDir: dir, needsDirectory: false } : item) });
  });
  const commit = () => perform(async () => {
    if (!preview || canceled.current) return;
    const preferences = Object.fromEntries((['cc', 'codex', 'pi', 'omp'] as const).map((engine) => {
      const prefs = getDraft().lastByVendor[engine];
      return [engine, { model: prefs.model, providerId: prefs.providerId, effort: prefs.effort, planMode: prefs.planMode, fastMode: getFastModeForModel(prefs.model) }];
    }));
    const completed = await api.commit({ previewId: preview.previewId, allowIncomplete, preferences });
    if (mounted.current) {
      setResults(completed);
      const imported = new Set(completed.filter((item) => item.status === 'imported' || item.status === 'skipped').map((item) => item.id));
      setScan((old) => old && { ...old, candidates: old.candidates.map((item) => imported.has(item.id) ? { ...item, imported: true } : item) });
    }
    emitRefresh();
    return canceled.current ? undefined : completed;
  });
  const cancel = async () => {
    canceled.current = true; setNeedsRestart(true); setError('canceled');
    try { await api.cancel(); } catch { if (mounted.current) setError('importFailed'); }
  };
  return { sources, sourceId, scan, preview, results, busy, error, allowIncomplete, needsRestart,
    discover, runScan, chooseSource, prepare, chooseProject, commit, cancel, clearReview,
    setAllowIncomplete,
    selectSource(id: string) { if (!inFlight.current) { clearScan(); setError(''); setSourceId(id); } },
  };
}

type Controller = ReturnType<typeof useCindyImport>;

export function CindyImportSourcePicker({ controller: c, disabled }: { controller: Controller; disabled: boolean }) {
  const { t } = useTranslation();
  return <div className="space-y-2 text-12 text-[var(--text-secondary)]">
    <p>{t('settings.cindyImport.description')} {t('settings.cindyImport.quitFirst')}</p>
    <div className="flex flex-wrap gap-2">
      {c.sources.map((source) => <Button key={source.id} disabled={disabled || c.needsRestart} variant={c.sourceId === source.id ? 'primary' : 'secondary'} className="h-auto min-h-8 max-w-full whitespace-normal py-1 text-left" aria-pressed={c.sourceId === source.id} onClick={() => c.selectSource(source.id)}>
        {source.label} · {t('settings.cindyImport.account', { count: source.accountIndex })}
      </Button>)}
      <Button disabled={disabled} variant="secondary" onClick={c.needsRestart ? c.discover : c.chooseSource}>
        {t(c.needsRestart ? 'settings.cindyImport.restart' : 'settings.cindyImport.chooseSource')}
      </Button>
    </div>
    <p className="break-all">{c.sources.find((s) => s.id === c.sourceId)?.location || t('settings.cindyImport.noSources')}</p>
    <p>{t('settings.cindyImport.selectHint')} {!c.scan && t('settings.cindyImport.scanHint')}</p>
  </div>;
}

export function CindyImportReview({ controller: c, disabled, nativeCount, onCommit }: { controller: Controller; disabled: boolean; nativeCount: number; onCommit(): void }) {
  const { t } = useTranslation();
  const translate = (key: string) => t('settings.cindyImport.' + key);
  const problem = (code?: string) => t('settings.cindyImport.errors.' + code, { defaultValue: translate('errors.importFailed') });
  const valid = c.preview?.items.filter((item) => !item.error) ?? [];
  const incomplete = valid.some((item) => item.issues.length);
  return <div className="flex min-h-[320px] flex-1 flex-col text-13 text-[var(--text-primary)]">
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
      {!c.results && <>
        <p>{translate('projectWarning')}</p>
        {nativeCount > 0 && <p>{t('settings.cindyImport.alsoImportNative', { count: nativeCount })}</p>}
        {c.preview?.items.map((item) => <div key={item.id} className="space-y-2 rounded-xl border border-[var(--border-default)] p-3">
          <p className="break-all font-medium">{item.title || translate('untitled')}</p>
          {item.error ? <p>{problem(item.error)}</p> : <>
            <p>{item.historyIncomplete ? translate('historyOnly') : translate('fullCopy')}</p>
            {item.issues.map((issue) => <p key={issue}>{problem(issue)}</p>)}
            {item.missingFiles.length > 0 && <details><summary className="min-h-8 cursor-pointer">{translate('missingFiles')}</summary><ul className="list-inside list-disc break-all">{item.missingFiles.map((file) => <li key={file}>{file}</li>)}</ul></details>}
            <p className="break-all text-[var(--text-secondary)]">{item.workingDir || (item.needsDirectory ? translate('needsDirectory') : translate('newDirectory'))}</p>
            {(item.workingDir || item.needsDirectory) && <Button disabled={disabled} variant="secondary" onClick={() => c.chooseProject(item.id)}>{translate('chooseProject')}</Button>}
          </>}
        </div>)}
        {incomplete && <label className="flex min-h-9 cursor-pointer items-start gap-2 py-2"><input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-[var(--settings-menu-text-selected)]" disabled={disabled} checked={c.allowIncomplete} onChange={(event) => c.setAllowIncomplete(event.target.checked)} />{translate('allowIncomplete')}</label>}
      </>}
      {c.results && <div role="status" className="space-y-3">{c.results.map((result) => <div key={result.id}><p className="break-all font-medium">{c.preview?.items.find((item) => item.id === result.id)?.title || translate('untitled')}</p><p>{translate('results.' + result.status)} {result.status === 'failed' ? problem(result.code) : ''}</p>{result.status === 'imported' && c.preview?.items.find((item) => item.id === result.id)?.historyIncomplete && <p>{translate('historyOnly')}</p>}</div>)}</div>}
    </div>
    <footer className="flex shrink-0 flex-wrap justify-between gap-2 border-t border-[var(--settings-input-border)] px-4 py-3">
      <Button disabled={disabled} variant="secondary" onClick={c.clearReview}>{translate('backToList')}</Button>
      {!c.results && <Button disabled={disabled || c.needsRestart || !valid.length || valid.some((item) => item.needsDirectory) || (incomplete && !c.allowIncomplete)} loading={disabled} onClick={onCommit}>{t('settings.sessionImport.importSelected')}</Button>}
    </footer>
  </div>;
}
