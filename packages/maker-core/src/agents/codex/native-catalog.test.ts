import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { projectCodexNativeConfig, projectCodexNativeModels } from './native-catalog.js';
describe('native task catalog projection', () => {
  it('keeps native presentation metadata and task overrides without service credentials or arbitrary nested configs', () => {
    const raw = { config: { model: 'global-default', model_provider: 'provider', model_reasoning_effort: 'high',
      model_providers: { provider: { name: 'Selected', wire_api: 'responses', http_headers: { Authorization: 'invalid-secret' }, env_key: 'KEY', base_url: 'https://invalid-secret@fixture.invalid' } },
      features: { plugins: true, unknownFutureSecret: 'invalid-secret' },
      tui: { theme: 'dark', animations: true, status_line: ['model-name', 'context-used'], notifications: ['invalid-secret'] },
      shell_environment_policy: { set: { KEY: 'invalid-secret' } }, profiles: { other: { key: 'invalid-secret' } },
      mcp_servers: { other: { env: { KEY: 'invalid-secret' } } }, instructions: 'invalid-secret',
    }, origins: { file: { path: 'invalid-secret' } } };
    const result = projectCodexNativeConfig(raw, { model: 'task-model', effort: 'low', serviceTier: null });
    assert.equal(JSON.stringify(result).includes('invalid-secret'), false);
    assert.equal(result.config.model, 'task-model'); assert.equal(result.config.model_reasoning_effort, 'low');
    assert.equal(result.config.service_tier, null);
    assert.deepEqual(result.config.model_providers, { provider: { name: 'Selected', wire_api: 'responses' } });
    assert.deepEqual(result.config.features, { plugins: true }); assert.deepEqual(result.origins, {});
    assert.deepEqual(result.config.tui, { theme: 'dark', animations: true, status_line: ['model-name', 'context-used'] });
    assert.equal(raw.config.model, 'global-default');
  });
  it('rejects a malformed response and does not copy object-shaped public fields', () => {
    assert.throws(() => projectCodexNativeConfig({}, { model: 'task' }), /invalid/);
    const projected = projectCodexNativeConfig({ config: { model: { secret: true }, tui: { status_line: ['KEY=secret'] } } }, { model: 'task' });
    assert.deepEqual(projected, { config: { model: 'task', tui: {} }, origins: {}, layers: null });
    assert.throws(() => projectCodexNativeConfig({ config: { approval_policy: { secret: true } } }, { model: 'task' }), /approval policy/);
  });
  it('preserves structured native approval flags without copying unknown policy data', () => {
    const granular = { sandbox_approval: false, rules: true, skill_approval: true, request_permissions: false, mcp_elicitations: true };
    const projected = projectCodexNativeConfig({ config: { approval_policy: { granular: { ...granular, unknown: 'invalid-secret' } } } }, { model: 'task' });
    assert.deepEqual(projected.config.approval_policy, { granular });
    assert.equal(JSON.stringify(projected).includes('invalid-secret'), false);
  });
  it('lists only the task provider choices with exact ids, route abilities and current hidden history', () => {
    const choice = (id: string, visible = true) => ({ id, name: id, visible, efforts: ['low', 'high'], defaultEffort: 'high', fastMode: false });
    const result = projectCodexNativeModels([choice('custom/model'), choice('hidden', false), choice('unselected-hidden', false), choice('custom/model')],
      [{ model: 'native-other', id: 'native-other', defaultReasoningEffort: 'ultra', secret: 'invalid-secret' }] as never, 'hidden');
    assert.deepEqual(result.data.map(item => item.id), ['custom/model', 'hidden']);
    assert.equal(result.data[0]!.model, 'custom/model'); assert.equal(result.data[1]!.isDefault, true);
    assert.equal(result.data[1]!.hidden, true); assert.equal(result.nextCursor, null);
    assert.deepEqual(result.data[0]!.additionalSpeedTiers, []); assert.equal(JSON.stringify(result).includes('invalid-secret'), false);
  });
});
