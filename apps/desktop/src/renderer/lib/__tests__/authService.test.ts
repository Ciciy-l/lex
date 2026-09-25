// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { createAuthService } from '../authService';

describe('AuthService owner-boundary projection', () => {
  it('preserves the pending marker from initialize and auth-state pushes', async () => {
    const pendingState = {
      user: null,
      serviceRealm: 'global' as const,
      mode: 'signed-out' as const,
      dataOwnerId: null,
      ownerGeneration: 7,
      ownerBoundaryPending: true,
      canEnterApp: false,
      isAuthenticated: false,
      isCanary: false,
      deviceId: 'test-device',
      hasAccountDeletionReceipt: false,
      accountDeletionRestored: false,
      credentialStoreUnavailable: false,
    };
    let emitAuthState!: (state: unknown) => void;
    const electronApi = {
      onAuthStateChange: vi.fn((listener: (state: unknown) => void) => {
        emitAuthState = listener;
        return () => undefined;
      }),
      authInitialize: vi.fn(async () => pendingState),
    };
    const previousElectronApi = window.electronAPI;
    window.electronAPI = electronApi as unknown as typeof window.electronAPI;

    try {
      const service = createAuthService();
      const listener = vi.fn();
      service.onAuthStateChange(listener);

      await expect(service.initialize()).resolves.toMatchObject({ ownerBoundaryPending: true });
      emitAuthState(pendingState);
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({ ownerBoundaryPending: true }),
      );
      emitAuthState({ ...pendingState, ownerBoundaryPending: false });
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({ ownerBoundaryPending: false }),
      );

      service.dispose();
    } finally {
      window.electronAPI = previousElectronApi;
    }
  });
});
