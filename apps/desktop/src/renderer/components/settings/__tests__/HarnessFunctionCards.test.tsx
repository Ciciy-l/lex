// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemorySection } from '../MemorySection';
import { CompactionSection } from '../CompactionSection';

const mocks = vi.hoisted(() => ({
  setMakerEnabled: vi.fn(),
  legacyReset: vi.fn(),
  additionalReset: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useMemorySettings', () => ({
  useMemorySettings: () => ({ makerEnabled: true, setMakerEnabled: mocks.setMakerEnabled }),
}));
vi.mock('@/hooks/useCompactionSettings', () => ({
  useCompactionSettings: (kind: string) => ({
    pct: kind === 'claude' ? null : 85,
    isCustomized: false,
    setPct: vi.fn(),
    resetPct: vi.fn(),
  }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn() }),
}));
vi.mock('../DefaultOverrideControls', () => ({
  DefaultOverrideControls: (props: {
    isCustomized: boolean;
    disabled?: boolean;
    onReset: () => void;
  }) =>
    props.isCustomized ? (
      <button disabled={props.disabled} onClick={props.onReset}>
        restore-settings
      </button>
    ) : null,
}));
vi.mock('@/components/ui/slider', () => ({
  Slider: (props: { value: number[]; 'aria-label': string }) => (
    <input type="range" readOnly value={props.value[0]} aria-label={props['aria-label']} />
  ),
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.additionalReset.mockResolvedValue(true);
  mocks.legacyReset.mockResolvedValue({ maker: false, isCustomized: false });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      memoryGet: vi.fn(async () => ({ enabled: true })),
      memoryGetSettingsState: vi.fn(async () => ({ isCustomized: false })),
      memoryResetSettings: mocks.legacyReset,
    },
  };
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'electronAPI');
});

describe('Harness function cards', () => {
  it('includes additional memory overrides in the overall restore and keeps its row in the card', async () => {
    render(
      <MemorySection
        additionalSettings={{ customized: true, pending: false, reset: mocks.additionalReset }}
      >
        <div>OMP memory row</div>
      </MemorySection>,
    );
    const row = screen.getByText('OMP memory row');
    expect(
      row.parentElement?.contains(
        screen.getByRole('switch', { name: 'settings.memory.maker.toggleAria' }),
      ),
    ).toBe(true);
    fireEvent.click(screen.getByText('restore-settings'));
    await waitFor(() => expect(mocks.legacyReset).toHaveBeenCalledTimes(1));
    expect(mocks.additionalReset).toHaveBeenCalledTimes(1);
    expect(mocks.setMakerEnabled).toHaveBeenCalledWith(false);
    expect(mocks.success).toHaveBeenCalledWith('settings.defaults.restored');
  });

  it('does not claim a full restore or reset other engines after the OMP step fails', async () => {
    mocks.additionalReset.mockResolvedValue(false);
    render(
      <MemorySection
        additionalSettings={{ customized: true, pending: false, reset: mocks.additionalReset }}
      />,
    );
    fireEvent.click(screen.getByText('restore-settings'));
    await waitFor(() =>
      expect((screen.getByText('restore-settings') as HTMLButtonElement).disabled).toBe(false),
    );
    expect(mocks.additionalReset).toHaveBeenCalledTimes(1);
    expect(mocks.legacyReset).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it('keeps Pi and OMP compaction available when Claude settings have not loaded', () => {
    render(
      <CompactionSection>
        <button>OMP compaction</button>
      </CompactionSection>,
    );
    expect(
      screen.getByRole('slider', { name: 'settings.compaction.piCard.sliderAria' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('slider', { name: 'settings.compaction.card.sliderAria' }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'OMP compaction' })).toBeTruthy();
  });
});
