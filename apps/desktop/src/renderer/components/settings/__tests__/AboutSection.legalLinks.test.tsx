// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { legalLinksForRealm } from '../../../../shared/legalLinks';

const toast = vi.hoisted(() => ({
  error: vi.fn(),
}));
const auth = vi.hoisted(() => ({
  serviceRealm: 'global' as 'cn' | 'global',
  mode: 'local' as 'signed-out' | 'local' | 'cloud',
  isAuthenticated: false,
}));

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
  useAuth: () => auth,
}));

import { CindyLegalPanel, CindyServicePanels, LegalLinksRows } from '../AboutSection';

const openExternal = vi.fn();

describe('AboutSection legal links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.serviceRealm = 'global';
    auth.mode = 'local';
    auth.isAuthenticated = false;
    openExternal.mockResolvedValue({ success: true });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      openExternal,
    };
  });

  afterEach(() => cleanup());

  it.each(['signed-out', 'local', 'cloud'] as const)(
    'hides service panels without an authenticated account in %s mode',
    (mode) => {
      auth.mode = mode;
      const { container } = render(<CindyServicePanels />);
      expect(container.childElementCount).toBe(0);
    },
  );

  it('shows the real service information for a cloud account and removes it on sign-out', () => {
    auth.mode = 'cloud';
    auth.isAuthenticated = true;
    const { rerender } = render(<CindyServicePanels />);
    expect(screen.getByRole('button', { name: 'settings.about.legal.title' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'settings.about.social.title' })).toBeTruthy();
    auth.mode = 'local';
    auth.isAuthenticated = false;
    rerender(<CindyServicePanels />);
    expect(screen.queryByRole('button', { name: 'settings.about.legal.title' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.about.social.title' })).toBeNull();
  });

  it('keeps Cindy legal information collapsed until the user opens it', () => {
    render(<CindyLegalPanel />);

    const disclosure = screen.getByRole('button', {
      name: 'settings.about.legal.title',
    });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(
      screen.queryByRole('button', {
        name: 'settings.about.legal.viewDocument:settings.about.legal.termsOfServiceLabel',
      }),
    ).toBeNull();

    fireEvent.click(disclosure);

    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(
      screen.getByRole('button', {
        name: 'settings.about.legal.viewDocument:settings.about.legal.termsOfServiceLabel',
      }),
    ).not.toBeNull();
  });

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
      expect(openExternal).toHaveBeenCalledWith(legalLinksForRealm('global').termsOfService),
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
