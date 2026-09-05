import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isUiPath, validateDesignBasis } from './check-pr-design-basis.mjs';

export const CHECK_NAMES = ['verify', 'Windows unit tests', 'Desktop Git integration', 'check:pr-design-basis'];

export function readContext(env) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('Checks may only be reported by the trusted main dispatch workflow.');
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '') ||
      !/^[a-f0-9]{40}$/.test(env.SYNC_HEAD_SHA ?? '') ||
      !/^[1-9]\d*$/.test(env.SYNC_PR_NUMBER ?? '') ||
      !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? '') ||
      !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) {
    throw new Error('Invalid repository, PR, run identity or immutable head SHA.');
  }
  if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is required.');
  return {
    repository: env.GITHUB_REPOSITORY,
    sha: env.SYNC_HEAD_SHA,
    prNumber: env.SYNC_PR_NUMBER,
    externalId: env.GITHUB_RUN_ID + ':' + env.GITHUB_RUN_ATTEMPT + ':' + env.SYNC_HEAD_SHA,
    detailsUrl: 'https://github.com/' + env.GITHUB_REPOSITORY + '/actions/runs/' + env.GITHUB_RUN_ID,
  };
}

export function validatePull(pull, context) {
  if (pull.state !== 'open' || pull.base?.ref !== 'main' ||
      pull.base?.repo?.full_name !== context.repository ||
      pull.head?.repo?.full_name !== context.repository ||
      !pull.head?.ref?.startsWith('sync/cindy-') || pull.head.sha !== context.sha) {
    throw new Error('PR is not an open same-repository sync PR at the expected head. No success is reported.');
  }
}

export async function reportUpstreamCi(mode, env, fetchImpl = fetch) {
  if (!['prepare', 'complete'].includes(mode)) throw new Error('Expected prepare or complete.');
  const context = readContext(env);
  const apiRoot = 'https://api.github.com/repos/' + context.repository;
  const request = async (suffix, method = 'GET', body) => {
    const response = await fetchImpl(apiRoot + suffix, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept: 'application/vnd.github+json',
        authorization: 'Bearer ' + env.GITHUB_TOKEN,
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error('GitHub API request failed: HTTP ' + response.status);
    return response.json();
  };
  const readPull = async () => {
    const pull = await request('/pulls/' + context.prNumber);
    validatePull(pull, context);
    return pull;
  };
  await readPull();

  if (mode === 'prepare') {
    const checkIds = {};
    for (const name of CHECK_NAMES) {
      const check = await request('/check-runs', 'POST', {
        name, head_sha: context.sha, external_id: context.externalId,
        status: 'in_progress', details_url: context.detailsUrl,
        output: { title: 'Upstream validation in progress', summary: 'Testing the immutable sync PR head with the trusted Lex workflow.' },
      });
      if (!Number.isSafeInteger(check.id) || check.id <= 0) throw new Error('Invalid check run ID.');
      checkIds[name] = check.id;
    }
    return { checkIds, success: true };
  }

  const checkIds = JSON.parse(env.SYNC_CHECK_IDS ?? '{}');
  for (const name of CHECK_NAMES) {
    const checkId = checkIds[name];
    if (!Number.isSafeInteger(checkId) || checkId <= 0) throw new Error('Missing prepared check: ' + name);
    const check = await request('/check-runs/' + checkId);
    if (check.name !== name || check.head_sha !== context.sha || check.external_id !== context.externalId ||
        check.app?.slug !== 'github-actions') {
      throw new Error('Check identity does not belong to this run attempt. Start a new dispatch or Re-run all jobs; Re-run failed jobs cannot reuse earlier prepared checks.');
    }
  }

  const filenames = [];
  for (let page = 1; page <= 30; page += 1) {
    const batch = await request('/pulls/' + context.prNumber + '/files?per_page=100&page=' + page);
    filenames.push(...batch.map(file => file.filename));
    if (batch.length < 100) break;
  }
  const pull = await readPull();
  if (!Number.isInteger(pull.changed_files) || filenames.length !== pull.changed_files || filenames.length > 3000) {
    throw new Error('Could not validate the complete PR file list.');
  }
  const designErrors = validateDesignBasis(pull.body ?? '', filenames.filter(isUiPath));
  const results = [env.SYNC_VERIFY_RESULT, env.SYNC_WINDOWS_RESULT, env.SYNC_GIT_RESULT];
  let success = true;
  for (const [index, name] of CHECK_NAMES.entries()) {
    await readPull();
    const passed = index === 3 ? designErrors.length === 0 : results[index] === 'success';
    success = success && passed;
    await request('/check-runs/' + checkIds[name], 'PATCH', {
      status: 'completed', conclusion: passed ? 'success' : 'failure', details_url: context.detailsUrl,
      output: {
        title: passed ? 'Validation passed' : 'Validation failed',
        summary: index === 3
          ? (designErrors.join('\n') || 'PR design basis validated using the trusted main checker. Runtime visual review is still required.')
          : 'Trusted workflow job result: ' + (results[index] ?? 'missing') + '. Only success passes.',
      },
    });
  }
  return { checkIds, success };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  reportUpstreamCi(process.argv[2], process.env).then(result => {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'check_ids=' + JSON.stringify(result.checkIds) + '\n');
    process.exitCode = result.success ? 0 : 1;
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
