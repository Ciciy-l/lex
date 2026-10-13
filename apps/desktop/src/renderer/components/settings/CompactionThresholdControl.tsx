import { useTranslation } from 'react-i18next';
import { Slider } from '@/components/ui/slider';

/** 49 is a UI-only position; the native policy is stored as null, never as 49%. */
const NATIVE_POSITION = 49;

export function CompactionThresholdControl({
  value,
  nativeDefault = false,
  disabled = false,
  label,
  onChange,
  onCommit,
}: {
  value: number | null;
  nativeDefault?: boolean;
  disabled?: boolean;
  label: string;
  onChange: (value: number | null) => void;
  onCommit?: (value: number | null) => void;
}) {
  const { t } = useTranslation();
  const display = value === null ? t('settings.harness.nativeDefault') : `${value}%`;
  const decode = (position: number) =>
    nativeDefault && position === NATIVE_POSITION ? null : position;
  return (
    <div className="flex items-center gap-[14px]">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Slider
          value={[value ?? NATIVE_POSITION]}
          min={nativeDefault ? NATIVE_POSITION : 50}
          max={95}
          step={1}
          disabled={disabled}
          onValueChange={([position]) => {
            if (typeof position === 'number') onChange(decode(position));
          }}
          onValueCommit={([position]) => {
            if (typeof position === 'number') onCommit?.(decode(position));
          }}
          aria-label={label}
          aria-valuetext={display}
        />
        <div className="flex items-center justify-between text-11 leading-none text-[var(--text-tertiary)]">
          <span>{nativeDefault ? t('settings.harness.nativeDefault') + ' / 50%' : '50%'}</span>
          <span>95%</span>
        </div>
      </div>
      <span className="shrink-0 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-1.5 text-13 font-medium leading-none text-[var(--text-primary)]">
        {display}
      </span>
    </div>
  );
}
