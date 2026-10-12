import AsyncStorage from '@react-native-async-storage/async-storage';
import { parseAuthSessionRecord, type AuthRegion } from '@cindy/auth-client';
import { readMobileAccountVault } from './mobileAccountVault';
import { getSecureItem } from './secureStorage';

const KEY = 'lex.mobile.personal-login-realm.v1';
let writeQueue: Promise<void> = Promise.resolve();

export function parsePersonalLoginRealm(value: unknown): AuthRegion {
  return value === 'cn' ? 'cn' : 'global';
}

export async function readPersonalLoginRealm(): Promise<AuthRegion> {
  await writeQueue.catch(() => undefined);
  return parsePersonalLoginRealm(await AsyncStorage.getItem(KEY));
}

export function savePersonalLoginRealm(realm: AuthRegion): Promise<void> {
  if (realm !== 'cn' && realm !== 'global') return Promise.reject(new Error('INVALID_AUTH_REGION'));
  const run = writeQueue.catch(() => undefined).then(() => AsyncStorage.setItem(KEY, realm));
  writeQueue = run;
  return run;
}

/** Read realm metadata before the network startup gate; never send a credential here. */
export async function readStartupAuthRealm(): Promise<AuthRegion> {
  const vault = await readMobileAccountVault();
  const active = vault.activeAccountKey ? vault.resources[vault.activeAccountKey] : undefined;
  if (active) return active.realm;
  if (!vault.signedOutAt) {
    const raw = await getSecureItem('cindy.mobile.auth.session.v1');
    if (raw) {
      const session = parseAuthSessionRecord(raw);
      if (session) return session.realm;
    }
  }
  return readPersonalLoginRealm();
}
