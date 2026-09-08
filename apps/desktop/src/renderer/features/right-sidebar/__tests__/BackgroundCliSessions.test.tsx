// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bucket: { tabs: [] }, list: vi.fn(), confirm: vi.fn(), destroy: vi.fn(), open: vi.fn(), error: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../store', () => ({ getBucket: () => mocks.bucket, subscribe: () => () => {} }));
vi.mock('../lib/terminalNavigation', () => ({ destroyTerminal: mocks.destroy, openOrFocusTerminal: mocks.open }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: mocks.confirm }) }));
vi.mock('@/components/ui/tooltip', () => ({ Tip: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.error } }));
import { BackgroundCliSessions } from '../BackgroundCliSessions';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.confirm.mockResolvedValue(false);
  mocks.open.mockResolvedValue(undefined);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    terminal: { list: mocks.list, onStatus: () => () => {} },
  } });
});
afterEach(cleanup);

describe('background terminal actions', () => {
  it.each(['running', 'terminating', 'exited', 'terminated'])('offers only activate and confirmed destroy for %s', async status => {
    mocks.list.mockResolvedValue([{ terminalId: 'pty-a', sessionId: 'lead', title: 'PowerShell 7', profile: 'shell', cwd: '/project', status, detached: true, pid: 1, exit: null }]);
    render(<BackgroundCliSessions sessionId="lead" enabled visible />);
    const row = await screen.findByRole('button', { name: /PowerShell 7/ });
    expect(screen.getAllByRole('button')).toHaveLength(2);
    await act(async () => { fireEvent.click(row); });
    expect(mocks.open).toHaveBeenCalledWith('lead', 'pty-a');
    const trash = screen.getByRole('button', { name: 'rightSidebar.terminal.destroyPane' });
    expect(trash.querySelector('svg.lucide-trash2, svg.lucide-trash-2')).toBeTruthy();
    await act(async () => { fireEvent.click(trash); });
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmVariant: 'destructive' }));
    expect(mocks.destroy).not.toHaveBeenCalled();
    mocks.confirm.mockResolvedValue(true);
    mocks.destroy.mockImplementation(async () => { mocks.list.mockResolvedValue([]); });
    await act(async () => { fireEvent.click(trash); });
    expect(mocks.destroy).toHaveBeenCalledWith('lead', 'pty-a');
    expect(screen.queryByRole('button', { name: /PowerShell 7/ })).toBeNull();
  });

  it('retains the entry and reports errors if destruction fails', async () => {
    mocks.list.mockResolvedValue([{ terminalId: 'pty-a', sessionId: 'lead', title: 'Keep me', profile: 'shell', cwd: '/project', status: 'running', detached: false, pid: 1, exit: null }]);
    mocks.confirm.mockResolvedValue(true);
    mocks.destroy.mockRejectedValue(new Error('termination failed'));
    render(<BackgroundCliSessions sessionId="lead" enabled visible />);
    const trash = await screen.findByRole('button', { name: 'rightSidebar.terminal.destroyPane' });
    await act(async () => { fireEvent.click(trash); });
    expect(screen.getByRole('button', { name: /Keep me/ })).toBeTruthy();
    expect(mocks.error).toHaveBeenCalled();
  });
});
