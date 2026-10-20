import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { decodeNativePermissions, projectNativePermissions } from './native-permissions.js';

const params = { threadId: 'task', turnId: 'turn', itemId: 'item',
  permissions: { network: { enabled: true }, fileSystem: null } };
describe('native permission overlay ownership', () => {
  it('accepts the exact reviewed overlay and preserves native stricter review', () => {
    assert.deepEqual(decodeNativePermissions({ permissions: { network: { enabled: true } }, scope: 'turn', strictAutoReview: true }, params, true),
      { response: { permissions: { network: { enabled: true } }, scope: 'turn', strictAutoReview: true }, decision: 'accept' });
  });
  it('preserves an exact native filesystem grant with null request-only fields omitted', () => {
    const requested = { ...params, permissions: { network: null, fileSystem: { read: ['/protocol/path'], write: null } } };
    const response = { permissions: { fileSystem: { read: ['/protocol/path'], write: null } }, scope: 'turn' };
    assert.deepEqual(decodeNativePermissions(response, requested, false)?.response, response);
    assert.equal(decodeNativePermissions({ ...response, permissions: { fileSystem: { read: ['/foreign/path'], write: null } } }, requested, false), undefined);
  });
  it('does not allow the frontend to introduce filesystem access or mutate the reviewed overlay', () => {
    for (const permissions of [{ fileSystem: { write: ['/elsewhere'] } }, { network: { enabled: true }, fileSystem: {} }, { network: { enabled: true, host: 'other' } }])
      assert.equal(decodeNativePermissions({ permissions, scope: 'turn' }, params, true), undefined);
  });
  it('keeps a deliberate session grant only when host policy allows it', () => {
    const response = { permissions: { network: { enabled: true } }, scope: 'session' };
    assert.equal(decodeNativePermissions(response, params, true)?.decision, 'acceptForSession');
    assert.equal(decodeNativePermissions(response, params, false), undefined);
  });
  it('treats empty permissions as denial and rejects unknown fields or invalid scope', () => {
    assert.equal(decodeNativePermissions({ permissions: {}, scope: 'turn' }, params, false)?.decision, 'decline');
    for (const response of [{ permissions: {}, scope: 'session' }, { permissions: {}, scope: 'always' },
      { permissions: {}, scope: 'turn', arbitrary: true }, { permissions: {}, scope: 'turn', strictAutoReview: 'true' }])
      assert.equal(decodeNativePermissions(response, params, true), undefined);
  });
});

describe('single-turn permission form uses upstream native controls', () => {
  const request = { ...params, itemId: 'item', reason: 'fixture access' };
  it('keeps the native permissions overlay when session grants are eligible', () => {
    const projected = projectNativePermissions(3, request, true);
    assert.equal(projected.request.method, 'item/permissions/requestApproval');
    assert.equal(projected.decode({ permissions: { network: { enabled: true } }, scope: 'session' })?.decision, 'acceptForSession');
  });
  it('advertises only turn-scoped choices without weakening strict review', () => {
    const projected = projectNativePermissions(4, request, false);
    assert.equal(projected.request.method, 'item/tool/requestUserInput');
    const questions = projected.request.params.questions as Array<{ id: string; options: Array<{ label: string }> }>;
    assert.equal(questions.length, 1);
    const decode = (choice: string) => projected.decode({ answers: { [questions[0]!.id]: { answers: [choice] } } });
    assert.equal(decode(questions[0]!.options[0]!.label)?.decision, 'accept');
    assert.equal(decode(questions[0]!.options[1]!.label)?.response.strictAutoReview, true);
    assert.equal(decode(questions[0]!.options[2]!.label)?.decision, 'decline');
    assert.equal(decode('Allow for session'), undefined);
    assert.equal(projected.decode({ permissions: { network: { enabled: true } }, scope: 'session' }), undefined);
  });
  it('treats cancellation as denial, and cannot add a permission to the frozen request', () => {
    const mutable = structuredClone(request);
    const projected = projectNativePermissions(5, mutable, false);
    mutable.permissions.network.enabled = false;
    assert.equal(projected.decode({ answers: {} })?.decision, 'decline');
    assert.deepEqual(projected.decode({ answers: { 'lex-permission-grant': { answers: ['Allow for this turn'] } } })?.response,
      { permissions: { network: { enabled: true } }, scope: 'turn' });
    assert.equal(projected.decode({ answers: { foreign: { answers: ['Allow for this turn'] } } }), undefined);
  });
  it('accepts only the localized labels displayed when the request opened', () => {
    const copy = { header: '权限', confirmation: '确认', once: '允许本轮使用', onceDescription: '本轮',
      strict: '允许并逐条审查', strictDescription: '审查后续命令', deny: '不授予权限并继续', denyDescription: '不授予' };
    const projected = projectNativePermissions(6, request, false, copy);
    copy.once = 'changed';
    assert.equal(projected.decode({ answers: { 'lex-permission-grant': { answers: ['允许本轮使用'] } } })?.decision, 'accept');
    assert.equal(projected.decode({ answers: { 'lex-permission-grant': { answers: ['changed'] } } }), undefined);
    assert.equal(projected.decode({ answers: { 'lex-permission-grant': { answers: ['Allow for this turn'] } } }), undefined);
  });
});
