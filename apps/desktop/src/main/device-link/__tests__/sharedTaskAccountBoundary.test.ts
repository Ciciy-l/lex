import { describe, expect, it, vi } from 'vitest';
import { closeSharedTasksBeforeAccountHandover } from '../sharedTaskAccountBoundary.js';

describe('SharedTask account handover boundary', () => {
  it('blocks DB release when local closure journaling fails, while still releasing relay ownership', async () => {
    const closureError = new Error('journal unavailable');
    const closeSharedTasks = vi.fn().mockRejectedValue(closureError);
    const releaseOwnership = vi.fn().mockResolvedValue(undefined);
    const onClosureFailure = vi.fn();
    const onReleaseFailure = vi.fn();

    await expect(closeSharedTasksBeforeAccountHandover({
      closeSharedTasks,
      releaseOwnership,
      onClosureFailure,
      onReleaseFailure,
    })).rejects.toBe(closureError);

    expect(onClosureFailure).toHaveBeenCalledExactlyOnceWith(closureError);
    expect(releaseOwnership).toHaveBeenCalledOnce();
    expect(onReleaseFailure).not.toHaveBeenCalled();
  });

  it('keeps a release failure best effort after durable local closure succeeds', async () => {
    const releaseError = new Error('relay lease unavailable');
    const closeSharedTasks = vi.fn().mockResolvedValue(undefined);
    const releaseOwnership = vi.fn().mockRejectedValue(releaseError);
    const onClosureFailure = vi.fn();
    const onReleaseFailure = vi.fn();

    await expect(closeSharedTasksBeforeAccountHandover({
      closeSharedTasks,
      releaseOwnership,
      onClosureFailure,
      onReleaseFailure,
    })).resolves.toBeUndefined();

    expect(onClosureFailure).not.toHaveBeenCalled();
    expect(onReleaseFailure).toHaveBeenCalledExactlyOnceWith(releaseError);
  });
});
