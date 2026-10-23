import type { MobileSavedAccount } from '@/auth/mobileAccountVault';

export interface AccountSwitcherPresentation {
  imageUrl: string | null;
  isOrg: boolean;
  subtitle: string | null;
  title: string;
}

export function presentSavedAccount(
  account: MobileSavedAccount,
): AccountSwitcherPresentation {
  const isOrg = account.kind === 'org';
  return {
    isOrg,
    imageUrl: isOrg ? account.orgLogoUrl : account.avatarUrl,
    title: isOrg
      ? account.orgName || account.displayName
      : account.displayName || account.email || (account.service?.kind === 'lex-server' ? new URL(account.service.origin).host : 'Cindy'),
    subtitle: [account.service?.kind === 'lex-server' ? new URL(account.service.origin).host : null, isOrg ? account.displayName : account.email].filter(Boolean).join(' · ') || null,
  };
}
