export type BillingSettingsIdentity = {
  mode: 'signed-out' | 'local' | 'cloud';
  membershipKind: 'personal' | 'org' | null;
  service?: { kind: 'cindy' | 'lex-server' };
};

export function canAccessBillingSettings(identity: BillingSettingsIdentity): boolean {
  return identity.mode === 'cloud' && identity.membershipKind === 'personal' && identity.service?.kind !== 'lex-server';
}
