/** Keep the outgoing database alive if shared-task closure cannot be made durable. */
export async function closeSharedTasksBeforeAccountHandover(options: {
  closeSharedTasks(): Promise<void>;
  releaseOwnership(): Promise<void>;
  onClosureFailure(error: unknown): void;
  onReleaseFailure(error: unknown): void;
}): Promise<void> {
  try {
    await options.closeSharedTasks();
  } catch (error) {
    options.onClosureFailure(error);
    throw error;
  } finally {
    // The relay must stop accepting peers even when a local journal is broken.
    // A lease-release failure remains best effort, but cannot hide a closure
    // failure that must abort the account handover.
    try {
      await options.releaseOwnership();
    } catch (error) {
      options.onReleaseFailure(error);
    }
  }
}
