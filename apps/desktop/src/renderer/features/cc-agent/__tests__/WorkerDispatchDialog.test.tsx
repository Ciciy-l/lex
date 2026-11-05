// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toast } from '@/lib/toast';

import { WorkerDispatchDialog } from '../WorkerDispatchDialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const worker = {
  workerId: 'worker-1',
  sessionId: 'worker-session-1',
  role: 'developer',
  agent: 'codex' as const,
  model: 'gpt-5.4',
  effort: null,
  label: 'api',
  status: 'idle' as const,
  focused: true,
  idleSince: null,
};

function installBridge(overrides: {
  status?: unknown;
  send?: unknown;
  listCleared?: unknown;
} = {}) {
  const getWorkerContextStatus = vi.fn(async () =>
    overrides.status ?? {
      ok: true,
      contextSupport: {
        clear: { supported: true },
        compact: { supported: false, reason: 'native-completion-unverified' },
      },
      clearedAt: 100,
      historyRetained: true,
      lastContextEvent: null,
    },
  );
  const sendWorkerTask = vi.fn(async () =>
    overrides.send ?? ({ ok: true } as const),
  );
  const listCleared = vi.fn(async () =>
    overrides.listCleared ?? {
      clearedAt: 100,
      messages: [{ id: 'm1', role: 'user', content: 'old sentinel', createdAt: '2026-01-01' }],
      hasMore: false,
    },
  );
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    localDb: {
      orcaWorkflows: { getWorkerContextStatus, sendWorkerTask },
      messages: { listCleared },
    },
  };
  return { getWorkerContextStatus, sendWorkerTask, listCleared };
}

describe('WorkerDispatchDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('shows capability reasons and only enables the supported policies', async () => {
    installBridge();
    render(
      <WorkerDispatchDialog open onClose={vi.fn()} leadSessionId="lead-1" worker={worker} />,
    );
    await waitFor(() => expect(screen.getByText('orca.dispatch.policyKeep')).toBeTruthy());
    expect(screen.getByRole('radio', { name: /orca\.dispatch\.policyClear/ })).toHaveProperty(
      'disabled',
      false,
    );
    const compact = screen.getByRole('radio', { name: /orca\.dispatch\.policyCompact/ });
    expect(compact).toHaveProperty('disabled', true);
    expect(screen.getByText('orca.dispatch.unsupportedNativeUnverified')).toBeTruthy();
  });

  it('sends the selected policy and surfaces the host receipt', async () => {
    const bridge = installBridge();
    const onClose = vi.fn();
    render(
      <WorkerDispatchDialog open onClose={onClose} leadSessionId="lead-1" worker={worker} />,
    );
    await waitFor(() => expect(bridge.getWorkerContextStatus).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText('orca.dispatch.messageLabel'), {
      target: { value: 'new task' },
    });
    fireEvent.click(screen.getByRole('radio', { name: /orca\.dispatch\.policyClear/ }));
    fireEvent.click(screen.getByRole('button', { name: 'orca.dispatch.send' }));
    await waitFor(() =>
      expect(bridge.sendWorkerTask).toHaveBeenCalledWith({
        leadSessionId: 'lead-1',
        workerId: 'worker-1',
        message: 'new task',
        contextPolicy: 'clear',
      }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the dialog open and reports the irreversible clear on failure', async () => {
    installBridge({
      send: {
        ok: false,
        errorCode: 'AGENT_NOT_READY',
        message: 'vendor refused',
        contextOutcome: { policy: 'clear', outcome: 'cleared', applied: true },
      },
    });
    const onClose = vi.fn();
    render(
      <WorkerDispatchDialog open onClose={onClose} leadSessionId="lead-1" worker={worker} />,
    );
    await waitFor(() => expect(screen.getByText('orca.dispatch.send')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('orca.dispatch.messageLabel'), {
      target: { value: 'new task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'orca.dispatch.send' }));
    await waitFor(() => expect(screen.getByText('orca.dispatch.clearAppliedFailure')).toBeTruthy());
    expect(screen.getByText('orca.dispatch.failureAgentNotReady')).toBeTruthy();
    expect(screen.queryByText('vendor refused')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('auto-loads audit pages and can collapse/reveal the full untruncated text', async () => {
    const firstPage = Array.from({ length: 30 }, (_, index) => ({
      id: `m${index + 1}`,
      role: 'user',
      content: `row-${index + 1}`,
      createdAt: '2026-01-01',
    }));
    const longText = `${'x'.repeat(650)}SENTINEL-AFTER-600`;
    const bridge = installBridge();
    bridge.listCleared
      .mockResolvedValueOnce({ clearedAt: 100, messages: firstPage, hasMore: true })
      .mockResolvedValueOnce({
        clearedAt: 100,
        messages: [
          { id: 'm31', role: 'assistant', content: longText, createdAt: '2026-01-01' },
        ],
        hasMore: false,
      });
    render(
      <WorkerDispatchDialog open onClose={vi.fn()} leadSessionId="lead-1" worker={worker} />,
    );
    await waitFor(() => expect(screen.getByText('orca.dispatch.viewHistory')).toBeTruthy());
    fireEvent.click(screen.getByText('orca.dispatch.viewHistory'));
    await waitFor(() =>
      expect(bridge.listCleared).toHaveBeenLastCalledWith('worker-session-1', {
        limit: 30,
        before: 'm30',
      }),
    );
    await waitFor(() => expect(screen.getByText(/SENTINEL-AFTER-600/)).toBeTruthy());
    expect(screen.queryByText('orca.dispatch.loadMore')).toBeNull();
    fireEvent.click(screen.getByText('orca.dispatch.collapse'));
    expect(screen.queryByText(/SENTINEL-AFTER-600/)).toBeNull();
    fireEvent.click(screen.getByText('orca.dispatch.showFull'));
    expect(screen.getByText(/SENTINEL-AFTER-600/)).toBeTruthy();
  });

  it('supports standard radio Arrow/Home/End navigation and skips disabled policies', async () => {
    installBridge();
    render(
      <WorkerDispatchDialog open onClose={vi.fn()} leadSessionId="lead-1" worker={worker} />,
    );
    await waitFor(() => expect(screen.getByText('orca.dispatch.policyKeep')).toBeTruthy());
    const keep = screen.getByRole('radio', { name: /orca\.dispatch\.policyKeep/ });
    const clear = screen.getByRole('radio', { name: /orca\.dispatch\.policyClear/ });
    const group = screen.getByRole('radiogroup');
    keep.focus();
    fireEvent.keyDown(group, { key: 'ArrowDown' });
    expect(clear.getAttribute('aria-checked')).toBe('true');
    expect(keep.getAttribute('aria-checked')).toBe('false');
    fireEvent.keyDown(group, { key: 'Home' });
    expect(keep.getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(group, { key: 'End' });
    // compact is disabled in this harness, so End lands on the last enabled option.
    expect(clear.getAttribute('aria-checked')).toBe('true');
  });

  it('keeps the dialog body scrollable and the action reachable at narrow heights', async () => {
    installBridge();
    render(
      <WorkerDispatchDialog open onClose={vi.fn()} leadSessionId="lead-1" worker={worker} />,
    );
    await waitFor(() => expect(screen.getByText('orca.dispatch.send')).toBeTruthy());
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('max-h-[calc(100vh_-_32px)]');
    expect(dialog.className).toContain('overflow-hidden');
    expect(dialog.className).toContain('rounded-xl');
    const scroll = screen.getByTestId('orca-dispatch-scroll');
    expect(scroll.className).toContain('overflow-y-auto');
    const textarea = screen.getByLabelText('orca.dispatch.messageLabel');
    expect(textarea.className).toContain('h-[110px]');
    expect(textarea.className).toContain('min-h-[88px]');
    expect(textarea.className).toContain('rounded-lg');
    const send = screen.getByRole('button', { name: 'orca.dispatch.send' });
    expect(scroll.contains(send)).toBe(false);
    expect(screen.getByRole('radio', { name: /orca\.dispatch\.policyKeep/ }).className)
      .toContain('rounded-lg');
  });

  it('maps busy dispatch failures to actionable localized copy without raw error text', async () => {
    const bridge = installBridge({
      send: {
        ok: false,
        errorCode: 'BUSY',
        message: 'context_policy clear is not supported while the worker is running',
      },
    });
    const onClose = vi.fn();
    render(
      <WorkerDispatchDialog open onClose={onClose} leadSessionId="lead-1" worker={worker} />,
    );
    await waitFor(() => expect(screen.getByText('orca.dispatch.send')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('orca.dispatch.messageLabel'), {
      target: { value: 'new task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'orca.dispatch.send' }));
    await waitFor(() => expect(screen.getByText('orca.dispatch.failureBusy')).toBeTruthy());
    expect(screen.queryByText(/context_policy/)).toBeNull();
    expect(screen.queryByText(/not supported while/)).toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(bridge.sendWorkerTask).toHaveBeenCalledOnce();
  });

  it('marks dormant compact as provisional, refreshes after rejection, and disables it in place', async () => {
    const bridge = installBridge();
    bridge.getWorkerContextStatus
      .mockResolvedValueOnce({
        ok: true,
        contextSupport: {
          clear: { supported: true },
          compact: { supported: true, provisional: true },
        },
        clearedAt: 100,
        historyRetained: true,
        lastContextEvent: null,
      })
      .mockResolvedValueOnce({
        ok: true,
        contextSupport: {
          clear: { supported: true },
          compact: { supported: false, reason: 'native-presentation' },
        },
        clearedAt: 100,
        historyRetained: true,
        lastContextEvent: null,
      });
    bridge.sendWorkerTask.mockResolvedValueOnce({
      ok: false,
      errorCode: 'CONTEXT_POLICY_UNSUPPORTED',
      message: 'context policy compact is not supported by this worker',
    });
    render(
      <WorkerDispatchDialog open onClose={vi.fn()} leadSessionId="lead-1" worker={worker} />,
    );
    await waitFor(() =>
      expect(screen.getByText('orca.dispatch.policyCompactProvisionalHint')).toBeTruthy(),
    );
    const compact = screen.getByRole('radio', { name: /orca\.dispatch\.policyCompact/ });
    expect(compact).toHaveProperty('disabled', false);
    fireEvent.click(compact);
    fireEvent.change(screen.getByLabelText('orca.dispatch.messageLabel'), {
      target: { value: 'compact it' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'orca.dispatch.send' }));
    await waitFor(() => expect(bridge.getWorkerContextStatus).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /orca\.dispatch\.policyCompact/ }))
        .toHaveProperty('disabled', true),
    );
    expect(screen.getByRole('radio', { name: /orca\.dispatch\.policyKeep/ }).getAttribute('aria-checked'))
      .toBe('true');
    expect(screen.queryByText(/context policy compact/)).toBeNull();
    expect(screen.getAllByText('orca.dispatch.unsupportedNativePresentation').length)
      .toBeGreaterThan(0);
    expect(screen.getByText('orca.dispatch.failureContextUnsupportedAction')).toBeTruthy();
  });

  it('restores focus to the trigger on Escape and all close paths', async () => {
    installBridge();
    const trigger = document.createElement('button');
    trigger.textContent = 'open dispatch';
    document.body.appendChild(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const view = render(
      <WorkerDispatchDialog open onClose={onClose} leadSessionId="lead-1" worker={worker} />,
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText('orca.dispatch.messageLabel')),
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    view.rerender(
      <WorkerDispatchDialog open={false} onClose={onClose} leadSessionId="lead-1" worker={worker} />,
    );
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('renders readable history text from provider payloads without leaking internal JSON', async () => {
    const bridge = installBridge();
    bridge.listCleared.mockResolvedValueOnce({
      clearedAt: 100,
      messages: [
        {
          id: 'u1',
          role: 'user',
          content: { orcaSource: 'lead', content: 'readable user task' },
          createdAt: '2026-01-01T10:00:00.000Z',
        },
        {
          id: 'a1',
          role: 'assistant',
          content: { message: 'upstream 502 response', providerId: 'provider-internal' },
          createdAt: '2026-01-01T10:01:00.000Z',
        },
        {
          id: 'a2',
          role: 'assistant',
          content: { content: [{ type: 'text', text: 'block text body' }] },
          createdAt: '2026-01-01T10:02:00.000Z',
        },
        {
          id: 'a3',
          role: 'assistant',
          content: { internalOnly: true },
          createdAt: '2026-01-01T10:03:00.000Z',
        },
      ],
      hasMore: false,
    });
    render(
      <WorkerDispatchDialog open onClose={vi.fn()} leadSessionId="lead-1" worker={worker} />,
    );
    await waitFor(() => expect(screen.getByText('orca.dispatch.viewHistory')).toBeTruthy());
    fireEvent.click(screen.getByText('orca.dispatch.viewHistory'));
    await waitFor(() => expect(screen.getByText('readable user task')).toBeTruthy());
    expect(screen.getByText('upstream 502 response')).toBeTruthy();
    expect(screen.getByText('block text body')).toBeTruthy();
    expect(screen.getByText(/orca\.dispatch\.sourceLead/)).toBeTruthy();
    expect(screen.getByText('orca.dispatch.historyUnsupportedContent')).toBeTruthy();
    expect(screen.queryByText(/orcaSource/)).toBeNull();
    expect(screen.queryByText(/providerId|provider-internal/)).toBeNull();
    expect(screen.queryByText(/internalOnly/)).toBeNull();
  });

  it('loads the retained cleared transcript through the local audit entry', async () => {
    const bridge = installBridge();
    render(
      <WorkerDispatchDialog open onClose={vi.fn()} leadSessionId="lead-1" worker={worker} />,
    );
    await waitFor(() => expect(screen.getByText('orca.dispatch.viewHistory')).toBeTruthy());
    fireEvent.click(screen.getByText('orca.dispatch.viewHistory'));
    await waitFor(() => expect(bridge.listCleared).toHaveBeenCalledWith('worker-session-1', { limit: 30 }));
    expect(screen.getByText(/old sentinel/)).toBeTruthy();
  });
});
