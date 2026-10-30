import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { emitRefresh } from '@/lib/sessionsBus';
import { getDraft, getFastModeForModel } from '@/state/newMakerDraft';
import { extractIpcError } from '@/utils/ipcError';
import type { CindyImportSource, CindyImportScan, CindyImportPreview, CindyImportResult } from '../../../shared/cindyImport';

export function CindyImportWizard({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const api = window.electronAPI.localDb.cindyImport;
  const [sources, setSources] = useState<CindyImportSource[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [scan, setScan] = useState<CindyImportScan>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<{ previewId: string; items: CindyImportPreview[] }>();
  const [results, setResults] = useState<CindyImportResult[]>();
  const [busy, setBusy] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState('');
  const [allowIncomplete, setAllowIncomplete] = useState(false);
  const mounted = useRef(true);
  const initialized = useRef(false);
  const chooseSourceButton = useRef<HTMLButtonElement>(null);
  const translate = (key: string) => t('settings.cindyImport.' + key);
  const problem = (code?: string) => t('settings.cindyImport.errors.' + code, { defaultValue: translate('errors.importFailed') });
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); }
    catch (error) {
      if (mounted.current) {
        const code = extractIpcError(error)?.message ?? 'importFailed';
        setError(code);
        if (['sourceChanged', 'sourceRunning', 'sourceUnreadable', 'invalidSelection', 'ownerChanged'].includes(code)) {
          setScan(undefined); setSelected(new Set()); setPreview(undefined); setResults(undefined);
          if (code === 'ownerChanged') { setSources([]); setSourceId(''); }
        }
      }
    }
    finally { if (mounted.current) setBusy(false); }
  }
  useEffect(() => {
    mounted.current = true;
    if (!initialized.current) {
      initialized.current = true;
      void perform(async () => { const items = await api.discover(); if (mounted.current) { setSources(items); setSourceId(items[0]?.id ?? ''); } });
    }
    return () => { mounted.current = false; queueMicrotask(() => { if (!mounted.current) void api.cancel().catch(() => undefined); }); };
  }, []);
  const close = () => { void api.cancel().catch(() => undefined); onClose(); };
  const commit = () => perform(async () => {
    if (!preview) return;
    setCommitting(true);
    try {
      const preferences = Object.fromEntries((['cc', 'codex', 'pi', 'omp'] as const).map((engine) => {
        const prefs = getDraft().lastByVendor[engine];
        return [engine, { model: prefs.model, providerId: prefs.providerId, effort: prefs.effort, planMode: prefs.planMode, fastMode: getFastModeForModel(prefs.model) }];
      }));
      const completed = await api.commit({ previewId: preview.previewId, allowIncomplete, preferences });
      if (mounted.current) setResults(completed);
      emitRefresh();
    } finally { if (mounted.current) setCommitting(false); }
  });
  const valid = preview?.items.filter((item) => !item.error) ?? [];
  const incomplete = valid.some((item) => item.issues.length);
  return <AlertDialog.Root open onOpenChange={(open) => { if (!open && !busy) close(); }}>
    <AlertDialog.Portal>
      <AlertDialog.Overlay className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]" />
      <AlertDialog.Content className="fixed left-1/2 top-1/2 z-[10000] flex max-h-[85vh] w-[calc(100%-32px)] max-w-[640px] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4 text-13 text-[var(--text-primary)]" onOpenAutoFocus={(event) => { event.preventDefault(); chooseSourceButton.current?.focus(); }} onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}>
        <AlertDialog.Title className="text-16 font-medium">{translate('title')}</AlertDialog.Title>
        <AlertDialog.Description className="text-13 text-[var(--text-secondary)]">{translate('description')}</AlertDialog.Description>
        {error && <p role="alert">{problem(error)}</p>}
        <div className="min-h-0 space-y-4 overflow-y-auto">
          {!scan && <>
            <p>{translate('quitFirst')}</p>
            {sources.length === 0 && <p>{translate('noSources')}</p>}
            <div className="space-y-2">
              {sources.map((source) => <Button key={source.id} disabled={busy} variant={sourceId === source.id ? 'primary' : 'secondary'} className="h-auto min-h-9 w-full justify-start gap-2 whitespace-normal py-2 text-left" aria-pressed={sourceId === source.id} onClick={() => setSourceId(source.id)}>
                <Check size={14} className={sourceId === source.id ? 'shrink-0' : 'shrink-0 invisible'} />
                <span className="min-w-0 break-all">{source.label} · {t('settings.cindyImport.account', { count: source.accountIndex })}<span className="block text-12 font-normal text-[var(--text-secondary)]">{source.location}</span></span>
              </Button>)}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button ref={chooseSourceButton} disabled={busy} variant="secondary" onClick={() => perform(async () => { const items = await api.chooseSource(); setSources((old) => [...old.filter((existing) => !items.some((item) => item.location === existing.location)), ...items]); if (items[0]) setSourceId(items[0].id); })}>{translate('chooseSource')}</Button>
              <Button disabled={busy || !sourceId} loading={busy} onClick={() => perform(async () => setScan(await api.scan(sourceId)))}>{translate('scan')}</Button>
            </div>
          </>}
          {scan && !preview && <>
            <p>{translate('selectHint')} {t('settings.cindyImport.excluded', { count: scan.excluded })}</p>
            <Button disabled={busy} variant="secondary" onClick={() => setSelected(new Set(scan.candidates.filter((c) => !c.imported).slice(0, 100).map((c) => c.id)))}>{translate('selectAll')}</Button>
            {scan.candidates.length === 0 && <p>{translate('empty')}</p>}
            <div className="space-y-2">
              {scan.candidates.map((item) => <Button key={item.id} disabled={busy || item.imported} aria-pressed={selected.has(item.id)} className="h-auto min-h-9 w-full justify-start gap-2 whitespace-normal py-2 text-left" variant={selected.has(item.id) ? 'primary' : 'secondary'} onClick={() => setSelected((old) => { const next = new Set(old); if (next.has(item.id)) next.delete(item.id); else if (next.size < 100) next.add(item.id); return next; })}>
                <Check size={14} className={selected.has(item.id) ? 'shrink-0' : 'invisible shrink-0'} />
                <span className="min-w-0 break-all">{item.title || translate('untitled')}<span className="block text-12 font-normal text-[var(--text-secondary)]">{{ cc: 'Claude Code', codex: 'Codex', pi: 'Pi', omp: 'OMP' }[item.agentKind]} · {new Date(item.updatedAt).toLocaleDateString()} {item.archived ? '· ' + translate('archived') : ''} {item.imported ? '· ' + translate('alreadyImported') : ''}<br />{item.workingDir || translate('standalone')}</span></span>
              </Button>)}
            </div>
          </>}
          {preview && !results && <>
            <p>{translate('projectWarning')}</p>
            {preview.items.map((item) => <div key={item.id} className="space-y-2 rounded-xl border border-[var(--border-default)] p-3">
              <p className="break-all font-medium">{item.title || translate('untitled')}</p>
              {item.error ? <p>{problem(item.error)}</p> : <>
                <p>{item.historyIncomplete ? translate('historyOnly') : translate('fullCopy')}</p>
                {item.issues.map((issue) => <p key={issue}>{problem(issue)}</p>)}
                {item.missingFiles.length > 0 && <details><summary className="min-h-8 cursor-pointer">{translate('missingFiles')}</summary><ul className="list-inside list-disc break-all">{item.missingFiles.map((file) => <li key={file}>{file}</li>)}</ul></details>}
                <p className="break-all text-[var(--text-secondary)]">{item.workingDir || (item.needsDirectory ? translate('needsDirectory') : translate('newDirectory'))}</p>
                {(item.workingDir || item.needsDirectory) && <Button disabled={busy} variant="secondary" onClick={() => perform(async () => { const dir = await api.chooseProject(preview.previewId, item.id); if (dir) setPreview({ ...preview, items: preview.items.map((i) => i.id === item.id ? { ...i, workingDir: dir, needsDirectory: false } : i) }); })}>{translate('chooseProject')}</Button>}
              </>}
            </div>)}
            {incomplete && <Button disabled={busy} variant={allowIncomplete ? 'primary' : 'secondary'} className="h-auto min-h-9 gap-2 whitespace-normal py-2 text-left" aria-pressed={allowIncomplete} onClick={() => setAllowIncomplete(!allowIncomplete)}><Check size={14} className={allowIncomplete ? 'shrink-0' : 'invisible shrink-0'} />{translate('allowIncomplete')}</Button>}
          </>}
          {results && <div role="status" className="space-y-3">{results.map((result) => <div key={result.id}><p className="break-all font-medium">{preview?.items.find((item) => item.id === result.id)?.title || translate('untitled')}</p><p>{translate('results.' + result.status)} {result.status === 'failed' ? problem(result.code) : ''}</p>{result.status === 'imported' && preview?.items.find((item) => item.id === result.id)?.historyIncomplete && <p>{translate('historyOnly')}</p>}</div>)}</div>}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {busy && <span role="status" className="self-center text-[var(--text-secondary)]">{translate(committing ? 'importing' : 'preparing')}</span>}
          <Button variant="secondary" onClick={busy ? () => { void api.cancel().catch(() => setError('importFailed')); } : close}>{translate(busy ? 'cancel' : 'close')}</Button>
          {scan && !preview && <Button disabled={!selected.size || busy} loading={busy} onClick={() => perform(async () => setPreview(await api.preview(scan.scanId, [...selected])))}>{t('settings.cindyImport.preview', { count: selected.size })}</Button>}
          {preview && !results && <Button disabled={busy || !valid.length || valid.some((item) => item.needsDirectory) || (incomplete && !allowIncomplete)} loading={committing} onClick={commit}>{translate('import')}</Button>}
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>;
}
