import { AsyncLocalStorage } from 'node:async_hooks';
import { throwIpcError } from '../utils/ipcValidate.js';

// Selection belongs to one request, never to a process-wide current repository.
const selection = new AsyncLocalStorage<string | undefined>();
export const currentReviewRepositoryId = () => selection.getStore();

export function withReviewRepository<T>(payload: unknown, task: () => Promise<T>): Promise<T> {
  const id = (payload as { repositoryId?: unknown } | null)?.repositoryId;
  if (id !== undefined && (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) {
    throwIpcError('INVALID_PARAMS', 'Invalid repository identity');
  }
  return selection.run(id as string | undefined, task);
}
