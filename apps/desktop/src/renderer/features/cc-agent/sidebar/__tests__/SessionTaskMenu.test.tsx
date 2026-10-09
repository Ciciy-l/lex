// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sharedTaskHostPeer } from '@cindy/device-link';
import type { Session } from '@/lib/ccAgent.types';
import { DropdownMenu, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { SessionTaskMenu } from '../SessionTaskMenu';

const state = vi.hoisted(() => ({
  host: vi.fn(),
  rowClick: vi.fn(),
  rename: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key.split('.').at(-1) }),
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: { removeDevice: vi.fn() },
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: 'owner', isAuthenticated: true }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));


const session = { id: 'task', title: 'Task', status: 'active' } as Session;
function Harness({ target = session, blocked = false }: { target?: Session; blocked?: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const slot = (text: string) => <DropdownMenuItem>{text}</DropdownMenuItem>;
  return (
    <MemoryRouter><div onClick={state.rowClick}>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger ref={trigger}>More</DropdownMenuTrigger>
        <SessionTaskMenu
          session={target}
          open={open}
          writeBlocked={blocked}
          returnFocus={() => trigger.current?.focus()}
          onRename={state.rename}
          onPin={vi.fn()}
          onArchive={vi.fn()}
          onUnarchive={vi.fn()}
          onDelete={vi.fn()}
          onOpenInNewWindow={vi.fn()}
          move={target.status === 'active' ? slot('move') : null}
          tags={slot('tags')}
          copy={slot('copy')}
          exportShare={slot('export')}
        />
      </DropdownMenu>
    </div></MemoryRouter>
  );
}
function openMenu() {
  fireEvent.keyDown(screen.getByRole('button', { name: 'More' }), { key: 'Enter' });
}
function labels() {
  return screen.getAllByRole('menuitem').map((item) => item.textContent);
}
beforeEach(() => {
  vi.clearAllMocks();
  setDataOwnerGeneration('owner');
  state.host.mockResolvedValue({ available: false, detail: null });
  Object.assign(window, {
    electronAPI: { sharedTask: { host: state.host, account: vi.fn().mockImplementation(async ({ action }) => action === 'get' ? null : []) } },
  });
});
afterEach(cleanup);

it('loads only on open and groups task organization, sharing, viewing and removal in order', () => {
  render(<Harness />);
  expect(state.host).not.toHaveBeenCalled();
  openMenu();
  expect(labels()).toEqual([
    'pin',
    'rename',
    'moveToProject',
    'tags',
    'copy',
    'title',
    'export',
    'openInNewWindow',
    'archived',
    'delete',
  ]);
  expect(screen.getAllByRole('separator')).toHaveLength(3);
  expect(state.host).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('menuitem', { name: 'rename' }));
  expect(state.rename).toHaveBeenCalledTimes(1);
  expect(state.rowClick).not.toHaveBeenCalled();
});

it('shows unpin without a branch entry even for a forked Pi task', () => {
  render(
    <Harness
      target={{ ...session, pinnedAt: '2026-09-23', agentKind: 'pi', parentSessionId: 'parent' }}
    />,
  );
  openMenu();
  expect(labels()).toEqual([
    'unpin',
    'rename',
    'moveToProject',
    'tags',
    'copy',
    'title',
    'export',
    'openInNewWindow',
    'archived',
    'delete',
  ]);
});

it('keeps restore and delete last for archived tasks and does not expose sharing', () => {
  render(<Harness target={{ ...session, status: 'archived' }} />);
  openMenu();
  expect(labels()).toEqual(['rename', 'tags', 'copy', 'export', 'unarchive', 'delete']);
});

it('keeps the guest menu limited to shared-task management', () => {
  render(
    <Harness target={{ ...session, deviceLinkDeviceId: sharedTaskHostPeer('share', 'device') }} />,
  );
  openMenu();
  expect(labels()).toEqual(['title']);
  expect(screen.queryByRole('separator')).toBeNull();
});

it('keeps the rejoin form mounted in shared-task management after the menu closes', async () => {
  render(
    <Harness target={{ ...session, deviceLinkDeviceId: sharedTaskHostPeer('share', 'device') }} />,
  );
  const more = screen.getByRole('button', { name: 'More' });
  openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'title' }));
  fireEvent.click(await screen.findByRole('button', { name: 'rejoin' }));
  expect(screen.queryByRole('menu')).toBeNull();
  expect(within(screen.getByRole('dialog')).getByRole('textbox', { name: /invitation/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(more));
  expect(state.rowClick).not.toHaveBeenCalled();
});

it('disables mutations while retaining read-only actions for an unavailable remote task', () => {
  render(<Harness blocked />);
  openMenu();
  for (const name of ['pin', 'rename', 'openInNewWindow', 'archived', 'delete']) {
    expect(screen.getByRole('menuitem', { name }).getAttribute('aria-disabled')).toBe('true');
  }
  expect(screen.getByRole('menuitem', { name: 'copy' }).getAttribute('aria-disabled')).not.toBe(
    'true',
  );
});

it('keeps the shared dialog after closing the menu and isolates its clicks from the row', async () => {
  render(<Harness />);
  const more = screen.getByRole('button', { name: 'More' });
  openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'title' }));
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  const dialog = screen.getByRole('dialog');
  expect(dialog.contains(document.activeElement)).toBe(true);
  fireEvent.click(within(dialog).getByRole('button', { name: 'dismiss' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(more));
  expect(state.rowClick).not.toHaveBeenCalled();
});
