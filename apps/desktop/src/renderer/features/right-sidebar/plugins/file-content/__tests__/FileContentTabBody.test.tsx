// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabKindHostContext } from '../../../types';
import type { TabCloseInterceptor } from '../../../store';
import type { FileContentTabState } from '../state';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  confirm: vi.fn(),
  unmounted: vi.fn(),
  handles: new Map<string, { isDirty: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> }>(),
  bodies: new Map<string, Record<string, unknown>>(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirmThree: mocks.confirm }),
}));
vi.mock('@/features/cc-agent/workdir-browse/hooks/useFileContent', () => ({
  useFileContent: mocks.read,
}));
vi.mock('@/features/cc-agent/workdir-browse/FileBodyView', async () => {
  const React = await import('react');
  return {
    FileBodyView: React.forwardRef(function Body(props: Record<string, unknown>, ref) {
      const path = String(props.relPath);
      const handle = React.useRef({ isDirty: vi.fn(() => false), save: vi.fn(async () => true) });
      React.useImperativeHandle(ref, () => handle.current, []);
      React.useEffect(
        () => () => {
          mocks.unmounted(path);
        },
        [path],
      );
      mocks.handles.set(path, handle.current);
      mocks.bodies.set(path, props);
      return React.createElement('div', { 'data-testid': path });
    }),
  };
});
import { FileContentTabBody } from '../FileContentTabBody';

function context(
  deviceLinkDeviceId: string | null | undefined = null,
  remoteHostId: string | null = null,
) {
  let close: TabCloseInterceptor | undefined;
  const ctx: TabKindHostContext = {
    tabId: 'file-tab',
    sessionId: 'lead',
    workdir: '/project',
    remoteHostId,
    deviceLinkDeviceId,
    patchState: vi.fn(),
    onVisibilityChange: vi.fn(),
    setCloseInterceptor: (handler) => {
      close = handler ?? undefined;
      return () => {
        close = undefined;
      };
    },
  };
  return { ctx, close: () => close!() };
}
const file: FileContentTabState = {
  path: 'a.ts',
  workdir: '/project',
  external: false,
  remoteHostId: null,
  deviceId: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.handles.clear();
  mocks.bodies.clear();
  mocks.read.mockReturnValue({
    content: { status: 'loading' },
    setLocal: vi.fn(),
    refresh: vi.fn(),
  });
});
afterEach(cleanup);

describe('independent file content tabs', () => {
  it.each([
    { device: null, ssh: null, external: false, expectedDevice: null, expectedSsh: null },
    { device: null, ssh: 'host-a', external: false, expectedDevice: null, expectedSsh: 'host-a' },
    {
      device: 'device-a',
      ssh: 'nested-host',
      external: false,
      expectedDevice: 'device-a',
      expectedSsh: null,
    },
    {
      device: 'device-a',
      ssh: 'nested-host',
      external: true,
      expectedDevice: null,
      expectedSsh: null,
    },
  ])(
    'uses the same authorized source for reading and editing: $device / $ssh / external=$external',
    (row) => {
      const { ctx } = context(row.device, row.ssh);
      render(
        <FileContentTabBody
          state={{ ...file, external: row.external }}
          ctx={ctx}
          active
          shellVisible
        />,
      );
      expect(mocks.read).toHaveBeenLastCalledWith(
        '/project',
        'a.ts',
        row.expectedSsh,
        row.expectedDevice,
      );
      expect(mocks.bodies.get('a.ts')).toMatchObject({
        deviceId: row.expectedDevice,
        remoteHostId: row.expectedSsh,
        allowEdit: !row.external,
        sessionId: row.external ? undefined : 'lead',
        active: true,
      });
    },
  );

  it('waits for unknown ownership without reading local files, then routes to the device', () => {
    const unknown = context();
    unknown.ctx.deviceLinkDeviceId = undefined;
    const state = { path: 'a.ts', workdir: '/project', external: false };
    const view = render(<FileContentTabBody state={state} ctx={unknown.ctx} active shellVisible />);
    expect(mocks.read).not.toHaveBeenCalled();
    view.rerender(
      <FileContentTabBody state={state} ctx={context('device-a').ctx} active shellVisible />,
    );
    expect(mocks.read).toHaveBeenLastCalledWith('/project', 'a.ts', null, 'device-a');
  });

  it('retains an existing editor and dirty handle while hidden or host ownership is temporarily unresolved', () => {
    const { ctx } = context();
    const view = render(<FileContentTabBody state={file} ctx={ctx} active shellVisible />);
    const handle = mocks.handles.get('a.ts');
    view.rerender(
      <FileContentTabBody
        state={file}
        ctx={{ ...ctx, deviceLinkDeviceId: undefined }}
        active={false}
        shellVisible
      />,
    );
    expect(mocks.unmounted).not.toHaveBeenCalled();
    expect(mocks.handles.get('a.ts')).toBe(handle);
    expect(mocks.bodies.get('a.ts')?.active).toBe(false);
    view.rerender(<FileContentTabBody state={file} ctx={ctx} active shellVisible={false} />);
    expect(mocks.bodies.get('a.ts')?.active).toBe(false);
    expect(mocks.unmounted).not.toHaveBeenCalled();
  });

  it('prompts and saves the closing file, never the active sibling', async () => {
    const a = context();
    const b = context();
    render(
      <>
        <FileContentTabBody state={file} ctx={a.ctx} active={false} shellVisible />
        <FileContentTabBody state={{ ...file, path: 'b.ts' }} ctx={b.ctx} active shellVisible />
      </>,
    );
    const handleA = mocks.handles.get('a.ts')!;
    const handleB = mocks.handles.get('b.ts')!;
    handleA.isDirty.mockReturnValue(true);
    mocks.confirm.mockResolvedValueOnce('cancel');
    expect(await a.close()).toBe(false);
    mocks.confirm.mockResolvedValueOnce('confirm');
    handleA.save.mockResolvedValueOnce(false);
    expect(await a.close()).toBe(false);
    mocks.confirm.mockResolvedValueOnce('confirm');
    handleA.save.mockImplementationOnce(async () => {
      handleA.isDirty.mockReturnValue(false);
      return true;
    });
    expect(await a.close()).toBe(true);
    handleA.isDirty.mockReturnValue(true);
    mocks.confirm.mockResolvedValueOnce('tertiary');
    expect(await a.close()).toBe(true);
    expect(handleA.save).toHaveBeenCalledTimes(2);
    expect(handleB.save).not.toHaveBeenCalled();
    expect(handleB.isDirty).not.toHaveBeenCalled();
  });

  it('refuses to close when new edits remain after a pending save finishes', async () => {
    const tab = context();
    render(<FileContentTabBody state={file} ctx={tab.ctx} active shellVisible />);
    const handle = mocks.handles.get('a.ts')!;
    handle.isDirty.mockReturnValue(true);
    mocks.confirm.mockResolvedValue('confirm');
    let finish!: (saved: boolean) => void;
    handle.save.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    const closing = tab.close();
    await vi.waitFor(() => expect(handle.save).toHaveBeenCalledOnce());
    finish(true);
    expect(await closing).toBe(false);
    expect(mocks.unmounted).not.toHaveBeenCalled();
  });
});
