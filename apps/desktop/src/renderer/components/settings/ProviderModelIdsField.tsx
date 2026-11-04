import { useId, useRef } from 'react';
import { Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Tip } from '@/components/ui/tooltip';
import { SettingsTextInput } from './SettingsTextInput';

/** Parse pasted or typed IDs while preserving first-seen order. */
export function parseProviderModelIds(value: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  // The stored contract splits on line breaks only; commas can be part of an ID.
  for (const candidate of value.split(/\r?\n/u)) {
    const id = candidate.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function ProviderModelIdsField({
  ids,
  draft,
  onDraftChange,
  onChange,
  disabled = false,
  label,
  addLabel,
  placeholder,
  removeLabel,
  rowLabel,
  emptyLabel,
}: {
  ids: readonly string[];
  draft: string;
  onDraftChange: (draft: string) => void;
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  label: string;
  addLabel: string;
  placeholder: string;
  removeLabel: (index: number) => string;
  rowLabel: (index: number) => string;
  emptyLabel: string;
}) {
  const idPrefix = useId();
  const rows = useRef(new Map<number, HTMLInputElement>());
  const addInput = useRef<HTMLInputElement>(null);

  const add = (raw = draft) => {
    const parsed = parseProviderModelIds(raw);
    if (parsed.length === 0) return;
    const seen = new Set(ids.map((id) => id.trim()).filter(Boolean));
    const additions = parsed.filter((id) => !seen.has(id));
    if (additions.length === 0) {
      onDraftChange('');
      return;
    }
    const firstAdded = ids.length;
    onChange([...ids, ...additions]);
    onDraftChange('');
    requestAnimationFrame(() => rows.current.get(firstAdded)?.focus());
  };

  return (
    <fieldset className="flex min-w-0 flex-col gap-2" disabled={disabled}>
      <legend className="text-13 text-[var(--text-primary)]">{label}</legend>
      {ids.length === 0 ? (
        <p className="text-12 leading-relaxed text-[var(--text-secondary)]">{emptyLabel}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {ids.map((id, index) => (
            // Index keys keep the controlled row mounted while its ID changes;
            // a value-derived key would remount on every keystroke and drop focus.
            <div key={index} className="flex min-w-0 items-center gap-2">
              <SettingsTextInput
                inputRef={(node) => {
                  if (node) rows.current.set(index, node);
                  else rows.current.delete(index);
                }}
                className="min-w-0 flex-1"
                size="md"
                surface="ivory"
                mono
                spellCheck={false}
                aria-label={rowLabel(index + 1)}
                value={id}
                onChange={(value) => {
                  const next = [...ids];
                  next[index] = value;
                  onChange(next);
                }}
              />
              <Tip text={removeLabel(index + 1)}>
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  className="w-9 shrink-0 px-0"
                  aria-label={removeLabel(index + 1)}
                  onClick={() => {
                    const next = ids.filter((_, current) => current !== index);
                    onChange(next);
                    // Both targets already exist; focusing synchronously avoids a
                    // late frame stealing focus from the user's next field.
                    if (next.length === 0) addInput.current?.focus();
                    else rows.current.get(Math.max(0, index - 1))?.focus();
                  }}
                >
                  <Trash2 size={15} aria-hidden="true" />
                </Button>
              </Tip>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <FormField id={`${idPrefix}-add`} label={addLabel} className="min-w-0 flex-1">
          {(control) => (
            <SettingsTextInput
              {...control}
              inputRef={addInput}
              size="md"
              surface="ivory"
              mono
              spellCheck={false}
              value={draft}
              placeholder={placeholder}
              onChange={onDraftChange}
              onPaste={(event) => {
                const pasted = event.clipboardData.getData('text');
                // Commas are valid ID characters, so a single-line paste is
                // ordinary text input. Only a line break is a batch separator.
                if (!/\r?\n/u.test(pasted)) return;
                event.preventDefault();
                const input = event.currentTarget;
                const start = input.selectionStart ?? draft.length;
                const end = input.selectionEnd ?? draft.length;
                // Honour the cursor/selection so a prefix such as `vendor/`
                // stays attached to the first pasted ID.
                add(draft.slice(0, start) + pasted + draft.slice(end));
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                event.preventDefault();
                add();
              }}
            />
          )}
        </FormField>
        <Button
          type="button"
          variant="secondary"
          disabled={parseProviderModelIds(draft).length === 0}
          onClick={() => add()}
        >
          <Plus size={14} aria-hidden="true" />
          {addLabel}
        </Button>
      </div>
    </fieldset>
  );
}
