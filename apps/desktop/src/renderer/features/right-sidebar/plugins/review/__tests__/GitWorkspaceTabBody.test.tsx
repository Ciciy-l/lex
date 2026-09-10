// @vitest-environment jsdom

import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { TabKindHostContext } from '../../../types';
import type { ReviewState } from '../index';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../ReviewTabBody', () => ({
  ReviewTabBody: ({ state }: { state: ReviewState }) => (
    <div data-testid="review-body">review:{state.descriptor.kind}</div>
  ),
}));
vi.mock('../../git-graph/GitGraphTabBody', () => ({
  GitGraphTabBody: ({
    state,
    ctx,
    active,
  }: {
    state: ReviewState['graph'];
    ctx: TabKindHostContext;
    active?: boolean;
  }) => (
    <div data-testid="graph-body" data-active={String(active)}>
      graph:{String(state.currentBranch)}:{String(state.includeRemotes)}
      <button type="button" onClick={() => ctx.patchState({ currentBranch: true })}>
        branch
      </button>
      <button type="button" onClick={() => ctx.patchState({ includeRemotes: false })}>
        remotes
      </button>
    </div>
  ),
}));
vi.mock('../../git-graph/GitGraphLoadingState', () => ({
  GitGraphLoadingState: ({
    messageKey = 'rightSidebar.gitGraph.loading',
  }: {
    messageKey?: string;
  }) => (
    <div role="status" aria-busy="true" aria-label={messageKey} data-testid="git-graph-loading">
      {messageKey}
    </div>
  ),
}));

import { GitWorkspaceTabBody } from '../GitWorkspaceTabBody';

const initialState: ReviewState = {
  activeView: 'graph',
  graph: { currentBranch: false, includeRemotes: true },
  descriptor: { kind: 'unstaged' },
  messageSnapshot: null,
  jumpTarget: null,
  diffsExpanded: true,
  diffViewMode: 'unified',
  fileTreeVisible: false,
  wordWrap: false,
  wordDiff: false,
  hideWhitespace: false,
  richMarkdownPreview: true,
  branchBaseRef: null,
};

function Harness(props: { remoteHostId?: string | null; deviceLinkDeviceId?: string | null }) {
  const remoteHostId = props.remoteHostId ?? null;
  // An omitted test prop means ordinary local ownership; an explicitly
  // undefined prop exercises the distinct unresolved ownership state.
  const deviceLinkDeviceId = 'deviceLinkDeviceId' in props ? props.deviceLinkDeviceId : null;
  const [state, setState] = useState(initialState);
  const ctx = {
    tabId: 'git-tab',
    sessionId: 'lead',
    workdir: '/repo',
    remoteHostId,
    deviceLinkDeviceId,
    patchState: (patch: unknown) => {
      setState((current) => ({ ...current, ...(patch as Partial<ReviewState>) }));
    },
    onVisibilityChange: () => {},
    setCloseInterceptor: () => () => {},
  } satisfies TabKindHostContext;
  return (
    <>
      <button
        type="button"
        onClick={() => setState((current) => ({ ...current, activeView: 'review' }))}
      >
        show review
      </button>
      <GitWorkspaceTabBody state={state} ctx={ctx} />
    </>
  );
}

describe('GitWorkspaceTabBody', () => {
  it('lazily mounts Graph first, then keeps both workspace views alive after switching', async () => {
    render(<Harness />);
    expect(screen.getByTestId('git-graph-loading')).toBeTruthy();
    expect((await screen.findByTestId('graph-body')).getAttribute('data-active')).toBe('true');
    expect(screen.queryByTestId('review-body')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'show review' }));
    expect((await screen.findByTestId('review-body')).textContent).toContain('review:unstaged');
    const graph = screen.getByTestId('graph-body');
    expect(graph.closest('.hidden')).not.toBeNull();
    expect(graph.getAttribute('data-active')).toBe('false');
  });

  it('merges rapid Graph preference patches through the nested graph state', async () => {
    render(<Harness />);
    await screen.findByTestId('graph-body');
    fireEvent.click(screen.getByRole('button', { name: 'branch' }));
    fireEvent.click(screen.getByRole('button', { name: 'remotes' }));
    expect(screen.getByTestId('graph-body').textContent).toContain('graph:true:false');
  });

  it('fails closed to Review without mounting Graph in an SSH workspace', async () => {
    render(<Harness remoteHostId="ssh-host" />);
    expect(await screen.findByTestId('review-body')).toBeTruthy();
    expect(screen.queryByTestId('graph-body')).toBeNull();
  });

  it('keeps both Git views unmounted behind the visible Graph loader until ownership resolves', async () => {
    const { container, rerender } = render(<Harness deviceLinkDeviceId={undefined} />);

    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(screen.getByTestId('git-graph-loading')).toBeTruthy();
    expect(screen.getByRole('status', { name: 'rightSidebar.gitGraph.loading' })).toBeTruthy();
    expect(screen.queryByTestId('graph-body')).toBeNull();
    expect(screen.queryByTestId('review-body')).toBeNull();

    rerender(<Harness deviceLinkDeviceId={null} />);
    expect(await screen.findByTestId('graph-body')).toBeTruthy();
  });
});
