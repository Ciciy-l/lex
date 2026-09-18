/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; title?: string }) => {
      if (key === 'settings.experimental.toggleAria') {
        return `Toggle experimental feature: ${options?.title}`;
      }
      return options?.defaultValue ?? key;
    },
  }),
}));
vi.mock('../LspBetaCell', () => ({ LspBetaCell: () => null }));
vi.mock('../BetaChannelCell', () => ({ BetaChannelCell: () => null }));

import { ExperimentalSection } from '../ExperimentalSection';
import { useExperimentalFlag } from '@/hooks/useExperimentalFeatures';

function TeammatesFlagProbe() {
  const { enabled } = useExperimentalFlag('teammates');
  return <output data-testid="teammates-enabled">{String(enabled)}</output>;
}

const settingsViewSource = readFileSync(resolve(__dirname, '..', 'SettingsView.tsx'), 'utf8');

describe('Experimental teammates setting', () => {
  beforeEach(() => {
    localStorage.clear();
    (
      window as unknown as {
        electronAPI: { platform: string; supportsBetaUpdateChannel?: boolean };
      }
    ).electronAPI = { platform: 'win32', supportsBetaUpdateChannel: true };
  });
  afterEach(() => cleanup());

  it('defaults off and synchronizes the setting with other components in this window', () => {
    render(
      <MemoryRouter>
        <ExperimentalSection />
        <TeammatesFlagProbe />
      </MemoryRouter>,
    );

    const toggle = screen.getByRole('switch', { name: 'Toggle experimental feature: Teammates' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('teammates-enabled').textContent).toBe('false');

    fireEvent.click(toggle);

    expect(localStorage.getItem('experimental.teammates')).toBe('true');
    expect(screen.getByTestId('teammates-enabled').textContent).toBe('true');
  });

  it('keeps shared teammates settings behind the same flag', () => {
    expect(settingsViewSource).toContain("useExperimentalFlag('teammates')");
    expect(settingsViewSource).toMatch(
      /\{teammatesEnabled && \([\s\S]*?<BotsGlobalSettingsSection \/>/,
    );
  });
});
