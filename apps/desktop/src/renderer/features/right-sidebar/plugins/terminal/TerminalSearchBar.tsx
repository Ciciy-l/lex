import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUp, ArrowDown, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tip } from '@/components/ui/tooltip';
import { getOrCreateXterm } from './lib/xtermPool';

export function TerminalSearchBar({ terminalId, onClose }: { terminalId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [found, setFound] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const addon = getOrCreateXterm(terminalId).searchAddon;
  const find = (backwards = false, incremental = false) => {
    if (!query) { addon.clearDecorations(); setFound(true); return; }
    setFound(backwards ? addon.findPrevious(query, { caseSensitive }) : addon.findNext(query, { caseSensitive, incremental }));
  };
  useEffect(() => { inputRef.current?.focus(); return () => addon.clearDecorations(); }, [addon]);
  useEffect(() => { find(false, true); }, [query, caseSensitive, addon]);
  return <div className="flex shrink-0 items-center gap-1 border-b border-[var(--border-default)] bg-[var(--surface)] px-2 py-1"
    onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === 'Escape') { e.stopPropagation(); onClose(); } else if (e.key === 'Enter') { e.preventDefault(); find(e.shiftKey); } }}>
    <Input inputRef={inputRef} value={query} onChange={setQuery} className="min-w-0 flex-1" ariaLabel={t('rightSidebar.workbench.searchOutput')} placeholder={t('rightSidebar.workbench.searchOutput')} />
    <Tip text={t('rightSidebar.workbench.matchCase')}><Button variant="secondary" size="md" aria-label={t('rightSidebar.workbench.matchCase')} aria-pressed={caseSensitive} onClick={() => setCaseSensitive(v => !v)}>Aa</Button></Tip>
    {!found && <span role="status" className="text-11 text-[var(--text-secondary)]">{t('rightSidebar.workbench.noMatches')}</span>}
    <Tip text={t('rightSidebar.workbench.previousMatch')}><Button variant="secondary" size="md" aria-label={t('rightSidebar.workbench.previousMatch')} onClick={() => find(true)}><ArrowUp size={14} /></Button></Tip>
    <Tip text={t('rightSidebar.workbench.nextMatch')}><Button variant="secondary" size="md" aria-label={t('rightSidebar.workbench.nextMatch')} onClick={() => find()}><ArrowDown size={14} /></Button></Tip>
    <Tip text={t('rightSidebar.workbench.closeSearch')}><Button variant="secondary" size="md" aria-label={t('rightSidebar.workbench.closeSearch')} onClick={onClose}><X size={14} /></Button></Tip>
  </div>;
}
