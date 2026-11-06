import { describe, expect, it, vi } from 'vitest';

import {
  createHostProviderKeyReader,
  resolveHostProviderKey,
  type HostProviderKeyDeps,
} from '../hostProviderKey.js';
import { LEX_SERVER_MANAGED_PROVIDER_ID } from '../../../shared/lexServerManagedModels.js';

function deps(overrides: Partial<HostProviderKeyDeps> = {}): HostProviderKeyDeps {
  return {
    hasManagedProvider: () => false,
    readManagedCredential: vi.fn(() => 'managed-secret'),
    readCustomProviderKey: vi.fn(() => 'custom-secret'),
    ...overrides,
  };
}

describe('resolveHostProviderKey', () => {
  it('returns null for a legacy reserved channel without a managed catalog entry', () => {
    const d = deps();
    expect(
      resolveHostProviderKey(LEX_SERVER_MANAGED_PROVIDER_ID, 'codex', 'openai-chat', d),
    ).toBeNull();
    expect(d.readManagedCredential).not.toHaveBeenCalled();
    expect(d.readCustomProviderKey).not.toHaveBeenCalled();
  });

  it('rejects derived reserved identities the same way', () => {
    const d = deps();
    expect(
      resolveHostProviderKey(
        `${LEX_SERVER_MANAGED_PROVIDER_ID}--openai-chat`,
        'codex',
        'openai-chat',
        d,
      ),
    ).toBeNull();
    expect(d.readManagedCredential).not.toHaveBeenCalled();
    expect(d.readCustomProviderKey).not.toHaveBeenCalled();
  });

  it('reads the managed credential only for the real managed catalog entry', () => {
    const readManagedCredential = vi.fn(() => 'managed-secret');
    const readCustomProviderKey = vi.fn(() => 'custom-secret');
    const d = deps({
      hasManagedProvider: (id) => id === LEX_SERVER_MANAGED_PROVIDER_ID,
      readManagedCredential,
      readCustomProviderKey,
    });
    expect(
      resolveHostProviderKey(LEX_SERVER_MANAGED_PROVIDER_ID, 'codex', undefined, d),
    ).toBe('managed-secret');
    expect(readManagedCredential).toHaveBeenCalledWith(LEX_SERVER_MANAGED_PROVIDER_ID);
    expect(readCustomProviderKey).not.toHaveBeenCalled();
  });

  it('keeps ordinary custom providers and channels on the custom reader', () => {
    const readManagedCredential = vi.fn(() => 'managed-secret');
    const readCustomProviderKey = vi.fn(() => 'custom-secret');
    const d = deps({ readManagedCredential, readCustomProviderKey });
    expect(resolveHostProviderKey('custom-alias', 'pi', 'openai-chat', d))
      .toBe('custom-secret');
    expect(resolveHostProviderKey('normal-channel', 'pi', 'openai-chat', d))
      .toBe('custom-secret');
    expect(readCustomProviderKey).toHaveBeenCalledTimes(2);
    expect(readManagedCredential).not.toHaveBeenCalled();
  });

  it('the production wrapper preserves the same decisions', () => {
    const d = deps();
    const reader = createHostProviderKeyReader(d);
    expect(reader(LEX_SERVER_MANAGED_PROVIDER_ID, 'codex')).toBeNull();
    expect(reader('custom-alias', 'codex')).toBe('custom-secret');
  });
});
