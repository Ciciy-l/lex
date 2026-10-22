import { describe, expect, it } from 'vitest';
import { accountVaultKey, passportVaultKey } from '../accountMetadata.js';
import { parseAuthSessionRecord, serializeAuthSessionRecord } from '../sessionRealm.js';
import { authServiceFromScope, authServiceScope, normalizeLexServerOrigin, storedAuthServiceScope } from '../service.js';

describe('deployment-bound account services', () => {
  it.each([
    [' HTTPS://LEX.EXAMPLE:443/ ', 'https://lex.example'],
    ['http://127.0.0.1:3101/', 'http://127.0.0.1:3101'],
    ['http://localhost:80', 'http://localhost'],
    ['http://[::1]:3101', 'http://[::1]:3101'],
    ['https://lex.example:8443', 'https://lex.example:8443'],
  ])('canonicalizes %s', (input, origin) => expect(normalizeLexServerOrigin(input)).toBe(origin));

  it.each([
    'http://192.168.1.2:3101', 'http://lex.example', 'ftp://lex.example',
    'https://user:password@lex.example', 'https://lex.example/admin',
    'https://lex.example/api/', 'https://lex.example?x=1', 'https://lex.example#token',
    'https://lex.example/./', 'https://lex.example\\admin', 'https://lex.example\n',
  ])('rejects ambiguous/insecure address %s', input => expect(() => normalizeLexServerOrigin(input)).toThrow());

  it.each(['https://lex.example:bad', 'https://[invalid]', 'http://:3101'])('returns a stable error for malformed %s', input => {
    expect(() => normalizeLexServerOrigin(input)).toThrow('INVALID_SERVER_URL');
  });

  it('keeps same membership/passport ids disjoint across origins and Cindy', () => {
    const a = authServiceScope({ kind: 'lex-server', origin: 'https://a.example' });
    const b = authServiceScope({ kind: 'lex-server', origin: 'https://b.example' });
    expect(new Set([a, b, 'global', 'cn']).size).toBe(4);
    expect(new Set([a, b, 'global', 'cn'].map(scope => accountVaultKey(scope as typeof a, 'same-member'))).size).toBe(4);
    expect(passportVaultKey(a, 'same-passport')).not.toBe(passportVaultKey(b, 'same-passport'));
    expect(authServiceFromScope(a)).toEqual({ kind: 'lex-server', origin: 'https://a.example' });
  });

  it('retains old Cindy sessions and keys without migration', () => {
    const old = parseAuthSessionRecord(serializeAuthSessionRecord('cn', 'synthetic-old'));
    expect(old).toEqual({ version: 1, realm: 'cn', refreshToken: 'synthetic-old' });
    expect(storedAuthServiceScope(old!)).toBe('cn');
    expect(accountVaultKey('global', 'member')).toBe('["global","member"]');
  });

  it('restores a Lex destination before a credential can be requested', () => {
    const service = { kind: 'lex-server', origin: 'http://127.0.0.1:3101' } as const;
    const record = parseAuthSessionRecord(serializeAuthSessionRecord('global', 'synthetic-server', service));
    expect(record?.version).toBe(2);
    expect(storedAuthServiceScope(record!)).toBe('lex-server:http://127.0.0.1:3101');
    expect(parseAuthSessionRecord(JSON.stringify({ ...record, realm: 'cn' }))).toBeNull();
    expect(parseAuthSessionRecord(JSON.stringify({ ...record, version: 1 }))).toBeNull();
    expect(() => storedAuthServiceScope({ realm: 'lex-server:https://a.example' as 'global' })).toThrow();
  });
});
