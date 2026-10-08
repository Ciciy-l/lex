import { describe, expect, it } from 'vitest';
import { createSharedTaskSettingGuard } from '../sharedTaskSetting.js';

describe('shared-task setting admission boundary', () => {
  it('rejects a revoked setting before admission and does not write through the guard', () => {
    let current = true;
    const transaction = { admitted: false };
    const capture = {
      author: { sessionId: 'task' },
      isCurrent: () => current,
      authorize: (operation: string) => operation === 'agent.configure' && current,
    };
    const guard = createSharedTaskSettingGuard(capture, 'task', transaction);

    guard();
    current = false;
    expect(() => guard()).toThrow('SharedTask task access denied');
    expect(transaction.admitted).toBe(false);
  });

  it('keeps an admitted native operation rollback-capable after revocation', () => {
    let current = true;
    const transaction = { admitted: false };
    const capture = {
      author: { sessionId: 'task' },
      isCurrent: () => current,
      authorize: () => current,
    };
    const guard = createSharedTaskSettingGuard(capture, 'task', transaction);

    guard.admit();
    expect(transaction.admitted).toBe(true);
    current = false;
    expect(() => guard()).not.toThrow();
  });

  it('never admits a different task even when the caller is otherwise current', () => {
    const transaction = { admitted: false };
    const capture = {
      author: { sessionId: 'task-a' },
      isCurrent: () => true,
      authorize: () => true,
    };
    const guard = createSharedTaskSettingGuard(capture, 'task-b', transaction);

    expect(() => guard.admit()).toThrow('SharedTask task access denied');
    expect(transaction.admitted).toBe(false);
  });
});
