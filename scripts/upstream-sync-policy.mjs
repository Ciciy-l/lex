import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REVIEW_PATHS = [
  ['Updater and distribution trust', /^apps\/desktop\/(?:cindy-updater\/|resources\/cindy-updater|src\/main\/(?:update|auto-update|manifestService|windowsUpdater))/],
  ['Potential system prompt or agent behavior change', /^(?:packages\/(?:maker-core|orca-workflow)\/src\/|apps\/desktop\/src\/main\/(?:maker-host|maker-ipc)\/)/],
  ['Plugin foundation and installed-plugin compatibility', /^(?:apps\/desktop\/src\/main\/(?:cindy-brain|plugin-market)\/|apps\/desktop\/src\/shared\/ghost\.ts$|packages\/(?:plugin-protocol|cindy-tools)\/)/],
  ['Mobile native runtime / cold update', /^apps\/mobile\/(?:modules\/|plugins\/|package\.json$|app\.(?:json|config\.[cm]?js)$|eas\.json$)/],
];

export function classifyUpstreamReview(paths) {
  const production = paths.filter(file => !/(?:^|\/)(?:__tests__|__fixtures__)\/|\.(?:test|spec|bench)\.[cm]?[jt]sx?$/.test(file));
  return REVIEW_PATHS.flatMap(([reason, pattern]) => {
    const files = production.filter(file => pattern.test(file));
    return files.length ? [{ reason, files }] : [];
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [base, upstream] = process.argv.slice(2);
    if (![base, upstream].every(value => /^[a-f0-9]{40}$/.test(value ?? ''))) throw new Error('Expected two immutable commit SHAs.');
    // Check both sides of renames, including protected files moved out of scope.
    const files = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', base, upstream], {
      encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
    }).split('\0').filter(Boolean);
    const reasons = classifyUpstreamReview(files);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'approval_required=' + (reasons.length > 0) + '\n');
    if (reasons.length) {
      console.log('Cindy snapshot ' + upstream + ' needs maintainer approval before merging or opening a sync PR.');
      for (const { reason, files: matches } of reasons) {
        console.log('\n' + reason + ':');
        for (const file of matches.slice(0, 15)) console.log('- ' + JSON.stringify(file));
        if (matches.length > 15) console.log('- Additional paths: ' + (matches.length - 15));
      }
      console.log('\nThis is a conservative path preflight, not a claim that every matched file changes policy. Review the diff and existing upgrade behavior; use a separate manual sync branch after approval.');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
