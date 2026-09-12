/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'ccAgent.layout.new': 'New task',
        'ccAgent.layout.automations': 'Automations',
        'sidebar.tabs.plugins': 'Plugins',
        'sidebar.tabs.bots': 'Teammates',
        'bots.backToTasks': 'Back to tasks',
      })[key] ?? key,
  }),
}));

vi.mock('@/cindy-brain/ghostUnreadStore', () => ({ useAnyGhostUnread: () => false }));
vi.mock('@/cindy-brain/GhostPanelRestoreEntry', () => ({
  GhostPanelRestoreEntry: () => null,
}));
vi.mock('@/features/cc-agent/sidebar/SidebarInlineSearch', () => ({
  SidebarInlineSearch: () => null,
}));
vi.mock('@/features/cc-agent/sidebar/conversationSearchContext', () => ({
  useConversationSearchContext: () => ({
    search: { query: '' },
    allKnownProjects: [],
    openSignal: 0,
  }),
}));
vi.mock('../GhostMainViewNavEntries', () => ({ GhostMainViewNavEntries: () => null }));

import { SidebarTopNav } from '../SidebarTopNav';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function renderTopNav(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <SidebarTopNav />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SidebarTopNav teammates entry', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it('hides the teammates entry by default', () => {
    renderTopNav('/cc-agent/task-a');

    expect(screen.queryByRole('button', { name: 'Teammates' })).toBeNull();
  });

  it('shows the enabled teammates entry and returns to the previously open task', () => {
    localStorage.setItem('experimental.teammates', 'true');
    renderTopNav('/cc-agent/task-a');

    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));

    expect(screen.getByTestId('location').textContent).toBe('/bots');
    fireEvent.click(screen.getByRole('button', { name: 'Back to tasks' }));

    expect(screen.getByTestId('location').textContent).toBe('/cc-agent/task-a');
  });

  it('replaces the entry with a return-to-tasks action inside the teammates workspace', () => {
    renderTopNav('/bots');

    expect(screen.queryByRole('button', { name: 'Teammates' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to tasks' }));

    expect(screen.getByTestId('location').textContent).toBe('/cc-agent');
  });
});
