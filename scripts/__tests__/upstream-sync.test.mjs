import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { CHECK_NAMES, readContext, reportUpstreamCi } from '../report-upstream-ci.mjs';
import { validateDesignBasis } from '../check-pr-design-basis.mjs';
import { classifyUpstreamReview } from '../upstream-sync-policy.mjs';

const read = relative => fs.readFileSync(new URL('../../' + relative, import.meta.url), 'utf8');
const sha = 'a'.repeat(40);
const env = {
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
  GITHUB_REPOSITORY: 'example/lex', GITHUB_TOKEN: 'test-token',
  GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', SYNC_HEAD_SHA: sha, SYNC_PR_NUMBER: '15',
  SYNC_VERIFY_RESULT: 'success', SYNC_WINDOWS_RESULT: 'success', SYNC_GIT_RESULT: 'success',
};
const body = '- 引用的设计规范：docs/design-rules/DESIGN.md §10、§15、§16';

function harness(overrides = {}) {
  const writes = [];
  const checks = new Map();
  const pull = {
    state: 'open', draft: false, body, changed_files: 1,
    base: { ref: 'main', repo: { full_name: env.GITHUB_REPOSITORY } },
    head: { sha, ref: 'sync/cindy-test', repo: { full_name: env.GITHUB_REPOSITORY } },
  };
  let reads = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.ok(url.startsWith('https://api.github.com/repos/example/lex/'));
    const route = url.slice('https://api.github.com/repos/example/lex'.length);
    let data;
    if (options.method !== 'GET') {
      const payload = JSON.parse(options.body);
      writes.push({ route, method: options.method, payload });
      if (options.method === 'POST') {
        const id = checks.size + 1;
        data = { ...payload, id, app: { slug: 'github-actions' } };
        checks.set(id, data);
      } else data = { ...checks.get(Number(route.split('/').at(-1))), ...payload };
    } else if (route.startsWith('/check-runs/')) {
      data = checks.get(Number(route.split('/').at(-1)));
    } else if (route.includes('/files?')) {
      data = overrides.files ?? [{ filename: 'apps/desktop/src/renderer/App.tsx' }];
    } else if (route === '/pulls/15') {
      reads += 1;
      data = overrides.readPull ? overrides.readPull(pull, reads) : pull;
    } else throw new Error('Unexpected route: ' + route);
    return { ok: true, json: async () => data };
  };
  const prepare = async () => {
    const result = await reportUpstreamCi('prepare', env, fetchImpl);
    return { ...env, SYNC_CHECK_IDS: JSON.stringify(result.checkIds) };
  };
  return { writes, checks, pull, fetchImpl, prepare };
}

test('registers all checks on the PR SHA and finishes them with trusted job results', async () => {
  const state = harness();
  const prepared = await state.prepare();
  assert.equal(state.writes.length, 4);
  for (const write of state.writes) {
    assert.equal(write.payload.head_sha, sha);
    assert.equal(write.payload.status, 'in_progress');
  }
  const result = await reportUpstreamCi('complete', prepared, state.fetchImpl);
  assert.equal(result.success, true);
  assert.deepEqual(state.writes.slice(4).map(write => write.payload.conclusion), Array(4).fill('success'));
});

test('missing, failed, cancelled and skipped jobs never receive a success check', async () => {
  for (const key of ['SYNC_VERIFY_RESULT', 'SYNC_WINDOWS_RESULT', 'SYNC_GIT_RESULT']) {
    for (const status of ['failure', 'cancelled', 'skipped', undefined]) {
      const state = harness();
      const prepared = await state.prepare();
      const result = await reportUpstreamCi('complete', { ...prepared, [key]: status }, state.fetchImpl);
      assert.equal(result.success, false);
      const resultIndex = ['SYNC_VERIFY_RESULT', 'SYNC_WINDOWS_RESULT', 'SYNC_GIT_RESULT'].indexOf(key);
      assert.equal(state.writes[4 + resultIndex].payload.conclusion, 'failure');
    }
  }
});

test('rejects malformed inputs and untrusted workflow refs', () => {
  for (const [key, value] of [
    ['GITHUB_EVENT_NAME', 'pull_request'], ['GITHUB_REF', 'refs/heads/sync/cindy-test'],
    ['SYNC_HEAD_SHA', 'main'], ['SYNC_PR_NUMBER', '15/../../checks'],
    ['GITHUB_REPOSITORY', '../outside/repo'], ['GITHUB_RUN_ATTEMPT', '0'], ['GITHUB_TOKEN', ''],
  ]) assert.throws(() => readContext({ ...env, [key]: value }));
});

test('rejects closed, fork, wrong-base, wrong-branch and advanced PRs before any write', async () => {
  for (const mutate of [
    pull => { pull.state = 'closed'; },
    pull => { pull.head.repo.full_name = 'fork/lex'; },
    pull => { pull.base.ref = 'release'; }, pull => { pull.base.repo.full_name = 'other/lex'; },
    pull => { pull.head.ref = 'feat/unrelated'; }, pull => { pull.head.sha = 'b'.repeat(40); },
  ]) {
    const state = harness();
    mutate(state.pull);
    await assert.rejects(state.prepare());
    assert.equal(state.writes.length, 0);
  }
});

test('failed-only retries are rejected with the supported recovery path', async () => {
  const state = harness();
  const prepared = await state.prepare();
  await assert.rejects(reportUpstreamCi('complete', { ...prepared, GITHUB_RUN_ATTEMPT: '2' }, state.fetchImpl), /Re-run all jobs; Re-run failed jobs/);
  assert.equal(state.writes.length, 4);
});

test('PR advancing during file retrieval cannot receive success', async () => {
  const state = harness({ readPull: (pull, reads) => reads > 2 ? { ...pull, head: { ...pull.head, sha: 'b'.repeat(40) } } : pull });
  const prepared = await state.prepare();
  await assert.rejects(reportUpstreamCi('complete', prepared, state.fetchImpl));
  assert.equal(state.writes.length, 4);
});

test('UI changes without design basis fail while non-UI changes remain valid', async () => {
  for (const ui of [true, false]) {
    const state = harness(ui ? {} : { files: [{ filename: 'scripts/utility.mjs' }] });
    state.pull.body = 'No design field';
    const prepared = await state.prepare();
    const result = await reportUpstreamCi('complete', prepared, state.fetchImpl);
    assert.equal(result.success, !ui);
    assert.equal(state.writes.at(-1).payload.conclusion, ui ? 'failure' : 'success');
  }
});

test('incomplete PR file pagination fails closed', async () => {
  const state = harness();
  state.pull.changed_files = 4000;
  const prepared = await state.prepare();
  await assert.rejects(reportUpstreamCi('complete', prepared, state.fetchImpl), /complete PR file list/);
  assert.equal(state.writes.length, 4);
});

test('API failure cannot post successful checks', async () => {
  await assert.rejects(reportUpstreamCi('prepare', env, async () => ({ ok: false, status: 403 })), /HTTP 403/);
});

test('workflow separates read-only untrusted tests from trusted check writers', () => {
  const ci = YAML.parse(read('.github/workflows/ci.yml'));
  assert.deepEqual(ci.permissions, { contents: 'read' });
  for (const name of ['prepare-sync-checks', 'report-sync-checks']) {
    const job = ci.jobs[name];
    assert.equal(job.permissions.checks, 'write');
    const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.with.ref, '${{ github.sha }}');
    assert.equal(checkout.with['persist-credentials'], false);
    assert.ok(job.steps.every(step => !/pnpm|npm install|download-artifact/.test(step.run ?? step.uses ?? '')));
  }
  for (const name of ['verify-checks', 'linux-unit-shards', 'windows-unit-shards', 'git-integration']) {
    const job = ci.jobs[name];
    assert.equal(job.permissions, undefined);
    const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.with.ref, '${{ inputs.checkout_ref || github.sha }}');
    assert.equal(checkout.with['persist-credentials'], false);
    const node = job.steps.find(step => step.uses?.startsWith('actions/setup-node@'));
    assert.match(node.with.cache, /github.event_name != 'workflow_dispatch'/);
    assert.equal(node.with['package-manager-cache'], false);
  }
  assert.deepEqual(ci.jobs['report-sync-checks'].needs, ['prepare-sync-checks', 'verify', 'windows-unit', 'git-integration']);
});

test('upstream bot preserves existing sync PRs, never force pushes, and fills design basis', () => {
  const source = read('.github/workflows/upstream-sync.yml');
  const workflow = YAML.parse(source);
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(workflow.jobs.sync.steps[0].with.ref, 'main');
  const merge = workflow.jobs.sync.steps.find(step => step.id === 'merge');
  assert.ok(merge.run.indexOf('open_sync=') < merge.run.indexOf('git switch'));
  assert.match(merge.run, /preserving its branch and manual fixes/);
  assert.match(merge.run, /GITHUB_RUN_ATTEMPT/);
  assert.doesNotMatch(source, /git push[^\n]*--force/);
  assert.match(source, /--ref main -f checkout_ref=.*-f pr_number=/);
  const create = workflow.jobs.sync.steps.find(step => step.name === 'Open upstream sync pull request');
  const prBody = create.run.match(/--body \$'([\s\S]+)'/)?.[1].replaceAll('\\n', '\n');
  assert.ok(prBody);
  for (const heading of ['## 这次改了什么', '## 怎么验证的', '## 风险']) assert.ok(prBody.includes(heading));
  assert.deepEqual(validateDesignBasis(prBody, ['apps/desktop/src/renderer/App.tsx']), []);
  assert.doesNotMatch(source, /\|\| true/);
  assert.equal(CHECK_NAMES.length, 4);
  assert.match(create.run, /--draft/);
  assert.equal(merge.if, "steps.policy.outputs.approval_required != 'true'");
});

test('sync drafts may receive real machine checks without becoming ready', async () => {
  const state = harness();
  state.pull.draft = true;
  const prepared = await state.prepare();
  assert.equal((await reportUpstreamCi('complete', prepared, state.fetchImpl)).success, true);
  assert.equal(state.pull.draft, true);
});

test('high-risk paths require approval before any automated merge or PR creation', () => {
  const review = classifyUpstreamReview([
    'apps/desktop/src/main/updateService.ts',
    'packages/maker-core/src/agents/pi/index.ts',
    'apps/desktop/src/main/cindy-brain/runtime/ghostFiles.ts',
    'apps/mobile/modules/xdt-screenshot-monitor/ios/Module.swift',
  ]);
  assert.equal(review.length, 4);
  assert.deepEqual(classifyUpstreamReview([
    'README.md', 'apps/desktop/src/main/__tests__/updateService.test.ts',
    'packages/maker-core/src/agents/pi/__tests__/pi.test.ts',
  ]), []);
  const steps = YAML.parse(read('.github/workflows/upstream-sync.yml')).jobs.sync.steps;
  assert.ok(steps.findIndex(step => step.id === 'policy') < steps.findIndex(step => step.id === 'merge'));
  assert.match(steps.find(step => step.id === 'policy').run, /node scripts\/upstream-sync-policy\.mjs/);
});

test('prompt assembly and updater helper policies also require approval', () => {
  for (const file of [
    'packages/orca-workflow/src/orca-bridge-prompt.ts',
    'apps/desktop/src/main/maker-ipc/orcaSessionStartOptions.ts',
    'apps/desktop/src/main/updateVersionPolicy.ts',
    'apps/desktop/src/main/updateArtifacts.ts',
    'apps/desktop/src/main/updateChannelStore.ts',
    'apps/desktop/src/main/auto-update-settings-store.ts',
  ]) assert.equal(classifyUpstreamReview([file]).length, 1, file);
});

test('moving a protected file outside protected paths still requires approval', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-upstream-policy-'));
  try {
    const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '--quiet');
    git('config', 'user.name', 'Policy Test');
    git('config', 'user.email', 'policy@example.invalid');
    git('config', 'diff.renames', 'true');
    const original = 'packages/orca-workflow/src/orca-bridge-prompt.ts';
    fs.mkdirSync(path.dirname(path.join(dir, original)), { recursive: true });
    fs.writeFileSync(path.join(dir, original), 'export const prompt = "fixture only";\n');
    git('add', '--all');
    git('commit', '--quiet', '-s', '-m', 'test: protected source');
    const base = git('rev-parse', 'HEAD');
    git('mv', original, 'ordinary.ts');
    git('commit', '--quiet', '-s', '-m', 'test: relocate source');
    const target = git('rev-parse', 'HEAD');
    assert.equal(git('diff', '--name-only', base, target), 'ordinary.ts');
    const outputFile = path.join(dir, 'github-output');
    const report = execFileSync(process.execPath, [fileURLToPath(new URL('../upstream-sync-policy.mjs', import.meta.url)), base, target], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: outputFile },
    });
    assert.equal(fs.readFileSync(outputFile, 'utf8'), 'approval_required=true\n');
    assert.ok(report.includes(original));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
