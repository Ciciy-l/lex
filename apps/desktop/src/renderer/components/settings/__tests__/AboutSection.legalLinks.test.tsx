// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { legalLinksForRealm } from '../../../../shared/legalLinks';

const toast = vi.hoisted(() => ({
  error: vi.fn(),
}));
const auth = vi.hoisted(() => ({ serviceRealm: 'global' as 'cn' | 'global' }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { document?: string }) =>
      options?.document ? `${key}:${options.document}` : key,
  }),
}));

vi.mock('@/lib/toast', () => ({
  toast,
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ serviceRealm: auth.serviceRealm }),
}));

import { LegalLinksRows } from '../AboutSection';

const openExternal = vi.fn();

describe('AboutSection legal links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.serviceRealm = 'global';
    openExternal.mockResolvedValue({ success: true });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      openExternal,
    };
  });

  afterEach(() => cleanup());

  it('renders both legal documents and opens the region-selected URLs externally', async () => {
    render(<LegalLinksRows />);

    const termsButton = screen.getByRole('button', {
      name: 'settings.about.legal.viewDocument:settings.about.legal.termsOfServiceLabel',
    });
    expect(termsButton.textContent).toContain(
      'settings.about.legal.viewDocument:settings.about.legal.termsOfServiceLabel',
    );
    expect(termsButton.className).toContain('px-6');
    expect(termsButton.className).toContain('py-2.5');

    fireEvent.click(termsButton);
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith(
        legalLinksForRealm('global').termsOfService,
      ),
    );

    const privacyButton = screen.getByRole('button', {
      name: 'settings.about.legal.viewDocument:settings.about.legal.privacyPolicyLabel',
    });
    expect(privacyButton.textContent).toContain(
      'settings.about.legal.viewDocument:settings.about.legal.privacyPolicyLabel',
    );

    fireEvent.click(privacyButton);
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith(legalLinksForRealm('global').privacyPolicy),
    );
  });

  it('uses the active China-mainland account realm for Cindy legal documents', async () => {
    auth.serviceRealm = 'cn';
    render(<LegalLinksRows />);

    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.about.legal.viewDocument:settings.about.legal.termsOfServiceLabel',
      }),
    );

    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith(legalLinksForRealm('cn').termsOfService),
    );
  });

  it('shows the localized failure message when the system browser cannot open a document', async () => {
    openExternal.mockResolvedValueOnce({ success: false });
    render(<LegalLinksRows />);

    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.about.legal.viewDocument:settings.about.legal.privacyPolicyLabel',
      }),
    );

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('settings.about.legal.openFailed'),
    );
  });
});
