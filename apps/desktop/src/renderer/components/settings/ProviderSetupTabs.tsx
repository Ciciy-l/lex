import { useTranslation } from 'react-i18next';
import type { CSSProperties } from 'react';
import { SegmentedControl } from '@/components/ui/segmented-control';

/** Both forms keep their drafts mounted; switching only changes the visible editor. */
export function ProviderSetupTabs({
  mode,
  panelId,
  disabled,
  onChange,
}: {
  mode: 'protocol' | 'harness';
  panelId: string;
  disabled?: boolean;
  onChange: () => void;
}) {
  const { t } = useTranslation();
  return (
    <SegmentedControl
      role="tablist"
      aria-label={t('models.channels.setupMode')}
      value={mode}
      disabled={disabled}
      style={
        {
          '--segmented-track': 'var(--settings-input-bg)',
          '--segmented-selected-bg': 'var(--surface-elevated)',
          '--segmented-selected-border': 'var(--border-default)',
          '--segmented-selected-shadow': 'none',
          '--segmented-option-fg': 'var(--text-secondary)',
          '--segmented-hover-bg': 'var(--surface-hover)',
        } as CSSProperties
      }
      options={[
        {
          value: 'protocol',
          label: t('models.channels.byProtocol'),
          id: panelId + '-protocol',
          'aria-controls': panelId,
        },
        {
          value: 'harness',
          label: t('models.channels.byHarness'),
          id: panelId + '-harness',
          'aria-controls': panelId,
        },
      ]}
      onValueChange={(value) => {
        if (value !== mode) onChange();
      }}
    />
  );
}
