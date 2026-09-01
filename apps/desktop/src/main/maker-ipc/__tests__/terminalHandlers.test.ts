import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IpcMainInvokeEvent, WebContents } from 'electron';

const mocks = vi.hoisted(() => ({
  ipcHandle: vi.fn(),
  managerConstructor: vi.fn(),
  managerCreate: vi.fn(() => ({
    shellId: 'bash',
    shellDisplayName: 'Bash',
    pid: 123,
    profile: 'shell' as const,
    profileDisplayName: 'Bash',
    exit: null,
  })),
  managerHas: vi.fn(() => true),
  managerIsOwner: vi.fn((id: string, sender: WebContents) => Boolean(id && sender)),
  managerWrite: vi.fn(),
  managerResize: vi.fn(),
  managerDispose: vi.fn(),
  managerRestart: vi.fn(() => ({
    shellId: 'bash',
    shellDisplayName: 'Bash',
    pid: 124,
    profile: 'shell' as const,
    profileDisplayName: 'Bash',
    exit: null,
  })),
  getDefaultShellPref: vi.fn(() => 'bash' as const),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.ipcHandle },
}));

vi.mock('../../terminal/ptyManager.js', () => ({
  PtyManager: class {
    constructor(deps: unknown) {
      mocks.managerConstructor(deps);
    }

    create = mocks.managerCreate;
    has = mocks.managerHas;
    isOwner = mocks.managerIsOwner;
    write = mocks.managerWrite;
    resize = mocks.managerResize;
    dispose = mocks.managerDispose;
    restart = mocks.managerRestart;
  },
}));

vi.mock('../../terminal/shellResolver.js', () => ({
  probeAvailableShells: vi.fn(() => []),
}));

vi.mock('../../terminal/terminalPrefsStore.js', () => ({
  getDefaultShellPref: mocks.getDefaultShellPref,
  setDefaultShellPref: vi.fn(),
}));

import { TERMINAL_INVOKE } from '../channels';
import { registerTerminalHandlers } from '../terminal-handlers';
import { markRsbWindowWebContentsId } from '../../right-sidebar-window/registry';

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function handlerFor(channel: string): InvokeHandler {
  const call = mocks.ipcHandle.mock.calls.find(([registered]) => registered === channel);
  if (!call) throw new Error(`${channel} handler was not registered`);
  return call[1] as InvokeHandler;
}

function createHandler(): InvokeHandler {
  return handlerFor(TERMINAL_INVOKE.CREATE);
}

function invokeCreate(params: Record<string, unknown>): unknown {
  const sender = { isDestroyed: () => false } as unknown as WebContents;
  return createHandler()({ sender } as IpcMainInvokeEvent, params);
}

describe('terminal CREATE shell preference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.managerHas.mockReturnValue(true);
    mocks.managerIsOwner.mockReturnValue(true);
    registerTerminalHandlers({ isTrustedSender: () => true });
  });

  it('resolves an omitted shellPref from the persisted main-process default', () => {
    invokeCreate({ id: 'terminal-1', cwd: '/tmp' });

    expect(mocks.getDefaultShellPref).toHaveBeenCalledOnce();
    expect(mocks.managerCreate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'terminal-1', shellPref: 'bash' }),
    );
  });

  it.each(['auto', 'zsh', null] as const)(
    'preserves an explicit shellPref (%s) without reading the global default',
    (shellPref) => {
      invokeCreate({ id: 'terminal-explicit', cwd: '/tmp', shellPref });

      expect(mocks.getDefaultShellPref).not.toHaveBeenCalled();
      expect(mocks.managerCreate).toHaveBeenCalledWith(expect.objectContaining({ shellPref }));
    },
  );

  it('rejects an invalid explicit shellPref before spawning', () => {
    expect(() =>
      invokeCreate({ id: 'terminal-invalid', cwd: '/tmp', shellPref: 'not-a-shell' }),
    ).toThrow(/invalid shellPref/);
    expect(mocks.getDefaultShellPref).not.toHaveBeenCalled();
    expect(mocks.managerCreate).not.toHaveBeenCalled();
  });

  it('preserves a controlled Agent profile and rejects arbitrary executables', () => {
    invokeCreate({ id: 'agent-pane', cwd: '/tmp', profile: 'codex' });
    expect(mocks.managerCreate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'agent-pane', profile: 'codex' }),
    );

    expect(() =>
      invokeCreate({ id: 'unsafe-pane', cwd: '/tmp', profile: 'C:\\Windows\\System32\\cmd.exe' }),
    ).toThrow(/invalid terminal profile/);
  });

  it('bounds native-facing identifiers and working-directory paths', () => {
    expect(() => invokeCreate({ id: 'x'.repeat(513), cwd: '/tmp' })).toThrow(
      /at most 512 characters/,
    );
    expect(() => invokeCreate({ id: 'terminal-1', cwd: 'x'.repeat(4_097) })).toThrow(
      /at most 4096 characters/,
    );
    expect(mocks.managerCreate).not.toHaveBeenCalled();
  });

  it('does not expose native executable paths in spawn errors', () => {
    mocks.managerCreate.mockImplementationOnce(() => {
      throw new Error('spawn C:\\Users\\private\\shell.exe ENOENT');
    });

    let caught: unknown;
    try {
      invokeCreate({ id: 'terminal-1', cwd: '/tmp' });
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain('TERMINAL_SHELL_NOT_FOUND');
    expect(String(caught)).not.toContain('C:\\Users\\private');
  });
});

describe('terminal IPC authorization and ownership', () => {
  const owner = { isDestroyed: () => false } as unknown as WebContents;
  const intruder = { isDestroyed: () => false } as unknown as WebContents;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.managerHas.mockReturnValue(true);
    mocks.managerIsOwner.mockImplementation((_id: string, sender: WebContents) => sender === owner);
  });

  it('rejects an untrusted renderer before creating a native process', () => {
    registerTerminalHandlers({ isTrustedSender: () => false });

    expect(() =>
      handlerFor(TERMINAL_INVOKE.CREATE)({ sender: owner } as IpcMainInvokeEvent, {
        id: 'terminal-1',
        cwd: '/tmp',
      }),
    ).toThrow(/PERMISSION_DENIED/);
    expect(mocks.managerCreate).not.toHaveBeenCalled();
  });

  it.each([
    [TERMINAL_INVOKE.WRITE, ['terminal-1', 'hello']],
    [TERMINAL_INVOKE.RESIZE, ['terminal-1', 80, 24]],
    [TERMINAL_INVOKE.DISPOSE, ['terminal-1']],
    [TERMINAL_INVOKE.RESTART, ['terminal-1']],
  ] as const)('rejects %s when another window owns the session', (channel, args) => {
    registerTerminalHandlers({ isTrustedSender: () => true });

    expect(() => handlerFor(channel)({ sender: intruder } as IpcMainInvokeEvent, ...args)).toThrow(
      /PERMISSION_DENIED/,
    );
    expect(mocks.managerWrite).not.toHaveBeenCalled();
    expect(mocks.managerResize).not.toHaveBeenCalled();
    expect(mocks.managerDispose).not.toHaveBeenCalled();
    expect(mocks.managerRestart).not.toHaveBeenCalled();
  });

  it('fails closed when a PTY output target is no longer a trusted Cindy window', () => {
    const send = vi.fn();
    const target = {
      isDestroyed: () => false,
      send,
    } as unknown as WebContents;

    registerTerminalHandlers({
      isTrustedSender: () => true,
      isTrustedOwner: () => false,
    });
    const deps = mocks.managerConstructor.mock.calls[0]?.[0] as {
      sink: {
        emitData: (owner: WebContents, payload: { id: string; chunk: string }) => void;
        emitExit: (
          owner: WebContents,
          payload: { id: string; exit: { code: number | null; signal: string | null } },
        ) => void;
      };
    };

    deps.sink.emitData(target, { id: 'pane-1', chunk: 'private output' });
    deps.sink.emitExit(target, { id: 'pane-1', exit: { code: 0, signal: null } });
    expect(send).not.toHaveBeenCalled();
  });

  it('delivers PTY output to a destination that still passes the outbound gate', () => {
    const send = vi.fn();
    const target = {
      isDestroyed: () => false,
      send,
    } as unknown as WebContents;

    registerTerminalHandlers({
      isTrustedSender: () => true,
      isTrustedOwner: () => true,
    });
    const deps = mocks.managerConstructor.mock.calls[0]?.[0] as {
      sink: {
        emitData: (owner: WebContents, payload: { id: string; chunk: string }) => void;
      };
    };

    deps.sink.emitData(target, { id: 'pane-1', chunk: 'hello' });
    expect(send).toHaveBeenCalledWith('terminal:data', { id: 'pane-1', chunk: 'hello' });
  });

  it('rejects oversized paste chunks and native PTY dimensions', () => {
    registerTerminalHandlers({ isTrustedSender: () => true });

    expect(() =>
      handlerFor(TERMINAL_INVOKE.WRITE)(
        { sender: owner } as IpcMainInvokeEvent,
        'terminal-1',
        'x'.repeat(1024 * 1024 + 1),
      ),
    ).toThrow(/at most 1048576 characters/);
    expect(() =>
      handlerFor(TERMINAL_INVOKE.RESIZE)(
        { sender: owner } as IpcMainInvokeEvent,
        'terminal-1',
        10_001,
        24,
      ),
    ).toThrow(/at most 10000/);
    expect(mocks.managerWrite).not.toHaveBeenCalled();
    expect(mocks.managerResize).not.toHaveBeenCalled();
  });

  it('allows ownership transfer only between the primary window and a registered RSB window', () => {
    const main = { id: 101, isDestroyed: () => false } as unknown as WebContents;
    const rsb = { id: 202, isDestroyed: () => false } as unknown as WebContents;
    const other = { id: 303, isDestroyed: () => false } as unknown as WebContents;
    markRsbWindowWebContentsId(202);

    registerTerminalHandlers({
      isTrustedSender: () => true,
      getFallbackOwner: () => main,
    });
    const deps = mocks.managerConstructor.mock.calls[0]?.[0] as {
      canTransferOwner: (current: WebContents, next: WebContents, id: string) => boolean;
    };

    expect(deps.canTransferOwner(main, rsb, 'pane-1')).toBe(true);
    expect(deps.canTransferOwner(rsb, main, 'pane-1')).toBe(true);
    expect(deps.canTransferOwner(main, other, 'pane-1')).toBe(false);
    expect(deps.canTransferOwner(rsb, other, 'pane-1')).toBe(false);
    expect(deps.canTransferOwner(other, main, 'pane-1')).toBe(false);
  });
});
