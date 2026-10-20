import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { projectNativeMcpConfirmation, decodeNativeMcpConfirmation } from './native-mcp-confirmation.js';

const params = { threadId: 'owned', turnId: 'turn', serverName: 'fixture', mode: 'form' as const,
  message: 'Fixture tool confirmation', requestedSchema: { type: 'object', properties: {} },
  _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'], tool_name: 'fixture', tool_params: { path: '/fixture' } } };
describe('native MCP confirmation preserves the existing policy decision', () => {
  it('keeps the actual tool evidence while removing unsupported persistent choices', () => {
    const projected = projectNativeMcpConfirmation(params, true);
    assert.deepEqual(projected._meta, { ...params._meta, persist: ['session'] });
    assert.deepEqual(params._meta.persist, ['session', 'always']);
  });
  it('forced confirmation cannot advertise or accept a session grant', () => {
    const projected = projectNativeMcpConfirmation(params, false);
    assert.equal(Object.hasOwn(projected._meta as object, 'persist'), false);
    assert.equal(decodeNativeMcpConfirmation({ action: 'accept', _meta: { persist: 'session' } }, projected), undefined);
    assert.deepEqual(decodeNativeMcpConfirmation({ action: 'accept', content: {}, _meta: null }, projected), {
      response: { action: 'accept', content: {}, _meta: null }, decision: 'accept',
    });
  });
  it('preserves a deliberate session grant and both negative native choices', () => {
    const projected = projectNativeMcpConfirmation(params, true);
    assert.equal(decodeNativeMcpConfirmation({ action: 'accept', _meta: { persist: 'session' } }, projected)?.decision, 'acceptForSession');
    for (const action of ['decline', 'cancel'] as const) {
      assert.deepEqual(decodeNativeMcpConfirmation({ action, content: null, _meta: null }, projected), {
        response: { action, content: null, _meta: null }, decision: action,
      });
    }
  });
  it('never invents persistence absent from the original request', () => {
    const projected = projectNativeMcpConfirmation({ ...params, _meta: { codex_approval_kind: 'mcp_tool_call' } }, true);
    assert.equal(decodeNativeMcpConfirmation({ action: 'accept', _meta: { persist: 'session' } }, projected), undefined);
  });
  it('rejects unrelated forms, URLs, arbitrary content and invented response metadata', () => {
    assert.throws(() => projectNativeMcpConfirmation({ ...params, _meta: {} }, true), /policy owner/);
    assert.throws(() => projectNativeMcpConfirmation({ ...params, mode: 'url', url: 'https://example.invalid', elicitationId: 'fixture' }, true), /policy owner/);
    const projected = projectNativeMcpConfirmation(params, true);
    for (const response of [null, [], { action: 'always' }, { action: 'accept', content: { arbitrary: true } },
      { action: 'accept', _meta: { persist: 'always' } }, { action: 'accept', _meta: { injected: true } },
      { action: 'decline', _meta: { persist: 'session' } }, { action: 'accept', ignored: true }]) {
      assert.equal(decodeNativeMcpConfirmation(response, projected), undefined);
    }
  });
});
