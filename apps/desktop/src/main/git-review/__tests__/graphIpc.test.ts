import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  trusted: vi.fn(),
  local: vi.fn(),
  graph: vi.fn(),
  compare: vi.fn(),
}));
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle }, shell: { openPath: vi.fn() } }));
vi.mock('../../security/trustedAppRenderer.js', () => ({
  isTrustedAppRendererEvent: mocks.trusted,
}));
vi.mock('../graphReader.js', () => ({
  withLocalGraphScope: mocks.local,
  readGitGraph: mocks.graph,
  readGitGraphComparison: mocks.compare,
}));
vi.mock('../sshReviewBackend.js', () => ({
  withSessionReviewExecution: vi.fn(),
  createSshPreviewReaderDeps: vi.fn(),
}));
import { registerGitReviewIpc } from '../ipc';

beforeEach(() => {
  vi.resetAllMocks();
  registerGitReviewIpc();
});
describe('Git Graph IPC boundary', () => {
  it.each([
    'git-review:graph',
    'git-review:graph-compare',
    'git-review:navigation',
    'git-review:commit-files',
  ])('rejects untrusted senders on %s before parsing or lookup', async (channel) => {
    mocks.trusted.mockReturnValue(false);
    const handler = mocks.handle.mock.calls.find(([name]) => name === channel)![1];
    await expect(handler({}, {})).rejects.toThrow('PERMISSION_DENIED');
    expect(mocks.local).not.toHaveBeenCalled();
    expect(mocks.graph).not.toHaveBeenCalled();
  });
  it('validates graph bounds before local session lookup', async () => {
    mocks.trusted.mockReturnValue(true);
    const handler = mocks.handle.mock.calls.find(([name]) => name === 'git-review:graph')![1];
    await expect(
      handler({}, { sessionId: 'lead', limit: 1001, currentBranch: false, includeRemotes: true }),
    ).rejects.toThrow(/\[INVALID_PARAMS\]/);
    expect(mocks.local).not.toHaveBeenCalled();
  });
  it.each(['git-review:graph', 'git-review:graph-compare'])(
    'reports malformed %s payloads as INVALID_PARAMS, not INTERNAL',
    async (channel) => {
      mocks.trusted.mockReturnValue(true);
      const handler = mocks.handle.mock.calls.find(([name]) => name === channel)![1];
      for (const payload of [
        null,
        {},
        {
          sessionId: 'lead',
          fromRef: 'main',
          fromOid: 'HEAD',
          toRef: 'topic',
          toOid: 'b'.repeat(40),
        },
      ]) {
        const error = await handler({}, payload).catch((error: Error) => error);
        expect(error.message).toContain('[INVALID_PARAMS]');
        expect(error.message).not.toContain('[INTERNAL]');
      }
      expect(mocks.local).not.toHaveBeenCalled();
    },
  );
  it('does not misclassify backend failures as parameter errors', async () => {
    mocks.trusted.mockReturnValue(true);
    mocks.local.mockRejectedValue(new Error('read failed'));
    const handler = mocks.handle.mock.calls.find(([name]) => name === 'git-review:graph')![1];
    await expect(
      handler({}, { sessionId: 'lead', limit: 100, currentBranch: true, includeRemotes: false }),
    ).rejects.toThrow('[INTERNAL]');
  });
  it('passes only parsed data through authoritative local scope resolution', async () => {
    mocks.trusted.mockReturnValue(true);
    const scope = { repoRoot: '/authoritative' };
    mocks.local.mockImplementation(async (_session, task) => task(scope));
    mocks.graph.mockResolvedValue('result');
    const handler = mocks.handle.mock.calls.find(([name]) => name === 'git-review:graph')![1];
    const request = { sessionId: 'lead', limit: 100, currentBranch: true, includeRemotes: false };
    await expect(handler({}, { ...request, cwd: '/untrusted' })).resolves.toBe('result');
    expect(mocks.local).toHaveBeenCalledWith('lead', expect.any(Function));
    expect(mocks.graph).toHaveBeenCalledWith(scope, request);
  });
});
