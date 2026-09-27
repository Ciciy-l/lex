// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SettingsSearchBox } from '../SettingsSearchBox';
import { createSettingsSearchParams } from '../settingsSearchCatalog';
import type { SettingsSearchContext } from '../settingsSearchTypes';
import type { SettingsSearchEntry } from '../settingsSearchTypes';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'settings.search.ariaLabel': 'Search settings',
        'settings.search.placeholder': 'Search settings or keywords…',
        'settings.search.resultsLabel': 'Settings search results',
        'settings.search.clear': 'Clear search',
        'settings.search.noResults': 'No matching settings',
        'settings.tabs.general': 'General',
        'settings.sections.appearance': 'Appearance',
        'settings.appearance.modeLabel': 'Appearance mode',
      })[key] ?? key,
  }),
}));

const context: SettingsSearchContext = {
  region: 'global',
  mode: 'cloud',
  membershipKind: 'personal',
  platform: 'darwin',
  teammatesEnabled: true,
};

describe('SettingsSearchBox', () => {
  it('navigates to a matching setting with keyboard selection and clears the query', () => {
    const onSelect = vi.fn((entry: SettingsSearchEntry) =>
      createSettingsSearchParams(new URLSearchParams('tab=ghosts&ghost=selected&debug=keep'), entry),
    );
    render(
      <SettingsSearchBox visibleTabIds={['general']} searchContext={context} onSelect={onSelect} />,
    );

    const input = screen.getByRole('combobox', { name: 'Search settings' });
    fireEvent.change(input, { target: { value: 'dark mode' } });
    const option = screen.getByRole('option');
    expect(option.textContent).toContain('Appearance mode');
    expect(option.textContent).toContain('General · Appearance');
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'settings.appearance.modeLabel' }));
    const selectedParams = onSelect.mock.results[0]?.value;
    expect(selectedParams?.get('tab')).toBeNull();
    expect(selectedParams?.get('section')).toBe('settings.appearance.modeLabel');
    expect(selectedParams?.get('debug')).toBe('keep');
    expect(selectedParams?.has('ghost')).toBe(false);
    expect((input as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe(input);
  });

  it('shows an empty result state without exposing unavailable tabs', () => {
    const onSelect = vi.fn();
    render(
      <SettingsSearchBox visibleTabIds={['general']} searchContext={context} onSelect={onSelect} />,
    );

    const input = screen.getByRole('combobox', { name: 'Search settings' });
    fireEvent.change(input, { target: { value: 'billing subscription' } });

    expect(screen.getByText('No matching settings')).toBeTruthy();
    expect(screen.queryByRole('option')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('clears the search and keeps keyboard focus available', () => {
    render(
      <SettingsSearchBox visibleTabIds={['general']} searchContext={context} onSelect={vi.fn()} />,
    );
    const input = screen.getByRole('combobox', { name: 'Search settings' });
    fireEvent.change(input, { target: { value: 'dark mode' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));

    expect((input as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe(input);
  });
});
