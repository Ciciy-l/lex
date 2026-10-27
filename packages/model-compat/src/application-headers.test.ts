import { describe, expect, it } from 'vitest';
import { appendLexUserAgent, withLexApplicationHeaders, withLexCustomHeaders } from './application-headers.js';

describe('model request application identity', () => {
  it('preserves actual native metadata and adds one token through repeated proxies', () => {
    const native = 'codex_cli_rs/0.162.1 (Windows 10.0; x86_64)';
    const once = withLexApplicationHeaders({ 'User-Agent': native, originator: 'codex_cli_rs', authorization: 'fixture' }, { appendNativeUserAgent: true });
    const twice = withLexApplicationHeaders(new Headers(once), { appendNativeUserAgent: true });
    expect(twice).toEqual({ 'user-agent': native + ' Lex', 'x-title': 'Lex', originator: 'codex_cli_rs', authorization: 'fixture' });
    expect(appendLexUserAgent('Lex/0.162.1 (Windows; Lex; 0.1.12)')).toBe('Lex/0.162.1 (Windows; Lex; 0.1.12)');
  });
  it('keeps explicit headers, including empty values and mixed-case last overrides', () => {
    const custom = { 'user-agent': 'native/1', 'User-Agent': 'chosen/2', 'X-TITLE': '', 'x-app': 'cli' };
    expect(withLexApplicationHeaders(custom)).toEqual({ 'User-Agent': 'chosen/2', 'X-TITLE': '', 'x-app': 'cli' });
    expect(custom['user-agent']).toBe('native/1');
    expect(withLexApplicationHeaders({})).toEqual({ 'X-Title': 'Lex' });
  });
  it('does not invent versions or change native/client identity headers', () => {
    const h = withLexApplicationHeaders({ originator: 'codex_cli_rs', 'x-stainless-package-version': '0.91.1' }, { appendNativeUserAgent: true });
    expect(h).toEqual({ originator: 'codex_cli_rs', 'x-stainless-package-version': '0.91.1', 'X-Title': 'Lex' });
    expect(h).not.toHaveProperty('user-agent');
  });
  it('preserves Claude custom-header lines verbatim and supplies only an absent title', () => {
    const input = 'Authorization: Bearer fake\nx-tenant: test';
    expect(withLexCustomHeaders(input)).toBe(input + '\nX-Title: Lex');
    expect(withLexCustomHeaders(withLexCustomHeaders(input))).toBe(input + '\nX-Title: Lex');
    expect(withLexCustomHeaders('x-tItLe: chosen\r\nX-Other: value')).toBe('x-tItLe: chosen\r\nX-Other: value');
  });
});
