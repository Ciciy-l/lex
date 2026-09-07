import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/lib/toast';

export function RenameDialog({ initialValue, onSave, onClose }: {
  initialValue: string; onSave: (value: string) => Promise<unknown>; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const save = async () => {
    if (saving.current) return;
    saving.current = true; setBusy(true);
    try { await onSave(value.trim()); onClose(); }
    catch { toast.error(t('rightSidebar.terminal.actionFailed')); }
    finally { saving.current = false; setBusy(false); }
  };
  return <ConfirmDialog open onOpenChange={(open) => { if (!open && !saving.current) onClose(); }}
    title={t('rightSidebar.workbench.rename')} description={t('rightSidebar.workbench.renameHint')}
    loading={busy} onConfirm={() => void save()} content={<Input aria-label={t('rightSidebar.workbench.rename')}
      maxLength={120} value={value} onChange={value => setValue(value.replace(/[\x00-\x1f\x7f]/g, ''))}
      onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void save(); } }} />} />;
}
