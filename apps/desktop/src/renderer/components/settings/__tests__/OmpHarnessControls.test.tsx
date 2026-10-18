// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OMP_HARNESS_DEFAULTS,
  type OmpHarnessSettings,
  type OmpHarnessState,
} from '../../../../shared/harnessSettings';
import { OmpHarnessControls, useOmpHarnessSettings } from '../OmpHarnessControls';
import { SettingsSearchNavigationContext } from '../SettingsSearchNavigation';
import harnessSearch from '../HarnessSettings.settings-search';

const mocks = vi.hoisted(() => ({
  makerEnabled: true,
  confirm: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  selector: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.error, success: mocks.success } }));
vi.mock('@/hooks/useMemorySettings', () => ({
  useMemorySettings: () => ({ makerEnabled: mocks.makerEnabled }),
}));
vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: [], loading: false }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));
vi.mock('../HarnessVersionsSection', () => ({ HARNESS_BUTTON: '' }));
vi.mock('../DefaultOverrideControls', () => ({
  DefaultOverrideControls: (props: {
    isCustomized: boolean;
    disabled?: boolean;
    onReset: () => void;
  }) =>
    props.isCustomized ? (
      <button disabled={props.disabled || !props.isCustomized} onClick={props.onReset}>
        restore
      </button>
    ) : null,
}));
vi.mock('@/components/ui/slider', () => ({
  Slider: (props: {
    value: number[];
    min: number;
    max: number;
    step: number;
    disabled: boolean;
    onValueChange: (v: number[]) => void;
    onValueCommit: (v: number[]) => void;
    'aria-label': string;
    'aria-valuetext': string;
  }) => (
    <input
      type="range"
      min={props.min}
      max={props.max}
      step={props.step}
      value={props.value[0]}
      disabled={props.disabled}
      aria-label={props['aria-label']}
      aria-valuetext={props['aria-valuetext']}
      onChange={(event) => props.onValueChange([Number(event.currentTarget.value)])}
      onBlur={(event) => props.onValueCommit([Number(event.currentTarget.value)])}
    />
  ),
}));
vi.mock('@/components/ui/switch', () => ({
  Switch: (props: {
    id?: string;
    checked: boolean;
    disabled?: boolean;
    onCheckedChange: (v: boolean) => void;
    'aria-label'?: string;
  }) => (
    <button
      id={props.id}
      type="button"
      role="switch"
      aria-label={props['aria-label']}
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={() => props.onCheckedChange(!props.checked)}
    />
  ),
}));
vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: (props: {
    modelId: string;
    disabled: boolean;
    onModelChange: (id: string) => unknown;
    fallbackOption: { onSelect: () => unknown };
  }) => {
    mocks.selector(props);
    return (
      <div>
        <span>{props.modelId || 'inherited-model'}</span>
        <button disabled={props.disabled} onClick={() => props.onModelChange('model-a')}>
          pick-model
        </button>
        <button disabled={props.disabled} onClick={() => props.fallbackOption.onSelect()}>
          inherit-model
        </button>
      </div>
    );
  },
}));

let value: OmpHarnessSettings;
function snapshot(): OmpHarnessState {
  const customizedKeys = (Object.keys(value) as (keyof OmpHarnessSettings)[]).filter(
    (key) => value[key] !== OMP_HARNESS_DEFAULTS[key],
  );
  return {
    ownerGeneration: 7,
    value: { ...value },
    defaults: { ...OMP_HARNESS_DEFAULTS },
    customizedKeys,
    isCustomized: customizedKeys.length > 0,
    unifiedEnabled: true,
  };
}
const api = {
  get: vi.fn(),
  set: vi.fn(),
  reset: vi.fn(),
  clearMemory: vi.fn(),
};
type Group = 'memory' | 'subagents' | 'compaction';
function Harness({ groups = ['subagents'] }: { groups?: Group[] }) {
  const controller = useOmpHarnessSettings();
  return (
    <>
      <span>{controller.state ? 'ready' : 'loading'}</span>
      {groups.map((group) => (
        <OmpHarnessControls key={group} group={group} controller={controller} />
      ))}
    </>
  );
}
function expand(index = 0) {
  fireEvent.click(screen.getAllByRole('button', { name: /settings.harness.advanced/ })[index]!);
}
function field(key: string) {
  return screen.getByRole('textbox', { name: 'settings.harness.' + key }) as HTMLInputElement;
}
async function mount(groups: Group[] = ['subagents']) {
  const result = render(<Harness groups={groups} />);
  await screen.findByText('ready');
  return result;
}

beforeEach(() => {
  vi.resetAllMocks();
  value = { ...OMP_HARNESS_DEFAULTS };
  mocks.makerEnabled = true;
  mocks.confirm.mockResolvedValue(true);
  api.get.mockImplementation(async () => snapshot());
  api.set.mockImplementation(async (patch: Partial<OmpHarnessSettings>) => {
    value = { ...value, ...patch };
    return snapshot();
  });
  api.reset.mockImplementation(async (keys: (keyof OmpHarnessSettings)[]) => {
    const patch = Object.fromEntries(keys.map((key) => [key, OMP_HARNESS_DEFAULTS[key]]));
    value = { ...value, ...patch };
    return snapshot();
  });
  api.clearMemory.mockResolvedValue(undefined);
  (window as unknown as { electronAPI: unknown }).electronAPI = { maker: { ompHarness: api } };
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'electronAPI');
});

describe('OMP settings within function groups', () => {
  it('keeps advanced fields collapsed while exposing saved customization', async () => {
    value.maxConcurrency = 4;
    await mount();
    expect(screen.queryByRole('textbox')).toBeNull();
    const advanced = screen.getByRole('button', { name: /settings.harness.advanced/ });
    expect(advanced.getAttribute('aria-expanded')).toBe('false');
    expect(within(advanced).getByText('settings.defaults.customizedBadge')).toBeTruthy();
    expand();
    expect(field('maxConcurrency').value).toBe('4');
  });

  it('uses the standard model selector without pretending to persist provider or effort settings', async () => {
    value.subagentModel = 'unavailable-model';
    await mount();
    expect(screen.getByText('unavailable-model')).toBeTruthy();
    const props = mocks.selector.mock.calls.at(-1)![0];
    expect(props).toMatchObject({
      vendorKey: 'omp',
      unifiedAgents: ['omp'],
      triggerVariant: 'field',
      configurationEnabled: false,
    });
    expect(props.onProviderChange).toBeUndefined();
    expect(props.unknownModelLabel('missing')).toBe('missing');
    fireEvent.click(screen.getByText('pick-model'));
    await waitFor(() => expect(screen.getByText('model-a')).toBeTruthy());
    expect(api.set).toHaveBeenLastCalledWith({ subagentModel: 'model-a' }, 7);
    fireEvent.click(screen.getByText('inherit-model'));
    await screen.findByText('inherited-model');
    expect(api.set).toHaveBeenLastCalledWith({ subagentModel: null }, 7);
  });

  it('validates integers, saves Enter once, preserves zero, and clears to native defaults', async () => {
    await mount();
    expand();
    const input = field('maxConcurrency');
    for (const invalid of ['129', '-1', '1.5', 'not-a-number']) {
      fireEvent.change(input, { target: { value: invalid } });
      fireEvent.blur(input);
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(api.set).not.toHaveBeenCalled();
    }
    input.focus();
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.set).toHaveBeenCalledTimes(1));
    expect(api.set).toHaveBeenLastCalledWith({ maxConcurrency: 0 }, 7);
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await waitFor(() => expect(api.set).toHaveBeenLastCalledWith({ maxConcurrency: null }, 7));
    expect(input.placeholder).toBe('settings.harness.nativeDefault');
  });

  it('rolls back a failed save and resets invalid drafts without changing another group', async () => {
    value.maxConcurrency = 4;
    value.nativeMemory = true;
    await mount();
    expand();
    api.set.mockRejectedValueOnce(new Error('write failed'));
    fireEvent.change(field('maxConcurrency'), { target: { value: '8' } });
    fireEvent.blur(field('maxConcurrency'));
    await waitFor(() => expect(field('maxConcurrency').value).toBe('4'));
    expect(mocks.error).toHaveBeenCalledWith('settings.harness.saveFailed');
    fireEvent.change(field('maxRecursionDepth'), { target: { value: '99' } });
    fireEvent.blur(field('maxRecursionDepth'));
    fireEvent.click(screen.getByText('restore'));
    await waitFor(() => expect(field('maxRecursionDepth').value).toBe(''));
    expect(field('maxConcurrency').value).toBe('');
    expect(api.reset).toHaveBeenCalledWith(
      ['subagentModel', 'maxConcurrency', 'maxRecursionDepth'],
      7,
    );
    expect(value.nativeMemory).toBe(true);
  });

  it('opens and reopens advanced settings on search activation', async () => {
    const entry = harnessSearch.entries.find((item) => item.id === 'harness.ompConcurrency')!;
    const view = render(
      <SettingsSearchNavigationContext.Provider value={{ entry, activation: 1 }}>
        <Harness />
      </SettingsSearchNavigationContext.Provider>,
    );
    await screen.findByText('ready');
    expect(field('maxConcurrency')).toBeTruthy();
    expect(document.getElementById(entry.targetId)).toBeTruthy();
    expand();
    expect(screen.queryByRole('textbox')).toBeNull();
    view.rerender(
      <SettingsSearchNavigationContext.Provider value={{ entry, activation: 2 }}>
        <Harness />
      </SettingsSearchNavigationContext.Provider>,
    );
    expect(field('maxConcurrency')).toBeTruthy();
  });

  it('disables compaction parameters without discarding them or inventing a default threshold', async () => {
    value.keepRecentTokens = 1234;
    await mount(['compaction']);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByText('restore')).toBeNull();
    const header = screen.getByText('OMP').parentElement!;
    expect(header.lastElementChild?.textContent).toBe('OMP');
    expand();
    const slider = screen.getByRole('slider', {
      name: 'settings.harness.compactionThreshold',
    }) as HTMLInputElement;
    expect(slider.getAttribute('aria-valuetext')).toBe('settings.harness.nativeDefault');
    fireEvent.click(screen.getByRole('switch', { name: 'settings.harness.compactionEnabled' }));
    await waitFor(() => expect(value.compactionEnabled).toBe(false));
    expect(slider.disabled).toBe(true);
    expect(field('keepRecentTokens').disabled).toBe(true);
    expect(field('keepRecentTokens').value).toBe('1234');
    expect(api.set).toHaveBeenLastCalledWith({ compactionEnabled: false }, 7);
  });

  it('previews the threshold without writes, commits a percentage, and restores the native policy', async () => {
    await mount(['compaction']);
    const slider = screen.getByRole('slider') as HTMLInputElement;
    expect(screen.queryByText('restore')).toBeNull();
    expect(api.set).not.toHaveBeenCalled();
    fireEvent.change(slider, { target: { value: '83' } });
    expect(slider.getAttribute('aria-valuetext')).toBe('83%');
    expect(api.set).not.toHaveBeenCalled();
    fireEvent.blur(slider);
    await waitFor(() => expect(api.set).toHaveBeenLastCalledWith({ compactionThreshold: 83 }, 7));
    await waitFor(() => expect(slider.disabled).toBe(false));
    fireEvent.change(slider, { target: { value: '49' } });
    fireEvent.blur(slider);
    await waitFor(() => expect(api.set).toHaveBeenLastCalledWith({ compactionThreshold: null }, 7));
    expect(slider.getAttribute('aria-valuetext')).toBe('settings.harness.nativeDefault');
  });

  it('rolls back failed threshold saves and restores the entire compaction group', async () => {
    value.compactionThreshold = 81;
    value.keepRecentTokens = 1000;
    await mount(['compaction']);
    const slider = screen.getByRole('slider') as HTMLInputElement;
    api.set.mockRejectedValueOnce(new Error('write failed'));
    fireEvent.change(slider, { target: { value: '90' } });
    fireEvent.blur(slider);
    await waitFor(() => expect(slider.value).toBe('81'));
    expand();
    fireEvent.click(screen.getByText('restore'));
    await waitFor(() =>
      expect(slider.getAttribute('aria-valuetext')).toBe('settings.harness.nativeDefault'),
    );
    expect(api.reset).toHaveBeenCalledWith(
      ['compactionEnabled', 'compactionThreshold', 'keepRecentTokens'],
      7,
    );
    expect(value.keepRecentTokens).toBeNull();
  });

  it('pauses native memory under unified memory and requires confirmation before clearing', async () => {
    value.nativeMemory = true;
    const view = await mount(['memory']);
    expect(screen.getByRole('button', { name: 'settings.harness.clearMemory' }).querySelector('svg')).toBeTruthy();
    expand();
    const native = screen.getByRole('switch', {
      name: 'settings.harness.nativeMemory',
    }) as HTMLButtonElement;
    expect(native.disabled).toBe(true);
    expect(native.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('settings.harness.nativeMemoryPaused')).toBeTruthy();
    mocks.makerEnabled = false;
    view.rerender(<Harness groups={['memory']} />);
    expect(native.disabled).toBe(false);
    mocks.confirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'settings.harness.clearMemory' }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(api.clearMemory).not.toHaveBeenCalled();
    api.clearMemory.mockRejectedValueOnce(new Error('OMP_MEMORY_BUSY'));
    fireEvent.click(screen.getByRole('button', { name: 'settings.harness.clearMemory' }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('settings.harness.memoryBusy'));
    expect(api.clearMemory).toHaveBeenCalledWith(7);
    expect(value.nativeMemory).toBe(true);
  });

  it('shares one load and mutation guard across all three groups', async () => {
    let resolve!: (state: OmpHarnessState) => void;
    api.set.mockReturnValueOnce(
      new Promise<OmpHarnessState>((done) => {
        resolve = done;
      }),
    );
    await mount(['memory', 'subagents', 'compaction']);
    expand(2);
    expect(api.get).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('pick-model'));
    expect(
      (
        screen.getByRole('switch', {
          name: 'OMP · settings.harness.unifiedMemory',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('switch', { name: 'settings.harness.compactionEnabled' }));
    expect(api.set).toHaveBeenCalledTimes(1);
    await act(async () => resolve(snapshot()));
  });

  it('recovers from load failure through retry', async () => {
    api.get.mockRejectedValueOnce(new Error('offline'));
    render(<Harness />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect((screen.getByText('pick-model') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('settings.harness.retry'));
    await screen.findByText('ready');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
