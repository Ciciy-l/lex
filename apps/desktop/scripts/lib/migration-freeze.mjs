/**
 * SQLite migration 冻结校验。
 *
 * 从旧仓迁入的 migration SQL，以及迁仓首个 commit 已存在的 companion TS，
 * 由 drizzle/migration-baseline.json 固定内容 hash，不再依赖 notice 或旧仓
 * Git 历史。之后进入新仓 main 的 migration 继续用 Git tree 做增量冻结，
 * 因此只允许追加新 migration，不允许改写或删除历史 SQL，也不允许增删或
 * 改写已经发布的 companion TS runtime script。
 */
/* global process */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MIGRATION_PATH_RE = /^apps\/desktop\/drizzle\/\d{4}_.+\.sql$/;
const MIGRATION_SCRIPT_PATH_RE = /^apps\/desktop\/drizzle\/scripts\/\d{4}_.+\.ts$/;
const BASELINE_GIT_PATH = 'apps/desktop/drizzle/migration-baseline.json';
const BASELINE_FILE = path.join('apps', 'desktop', 'drizzle', 'migration-baseline.json');

function runGit(repoRoot, args) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

export function normalizedSha256(content) {
  return crypto.createHash('sha256').update(content.replace(/\r\n/g, '\n')).digest('hex');
}

/** 读取并严格校验新仓固定的迁移基线。 */
export function readMigrationBaseline(repoRoot) {
  const baselinePath = path.join(repoRoot, BASELINE_FILE);
  let baseline;
  try {
    baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
  } catch (error) {
    throw new Error(
      `${BASELINE_FILE} 无法读取: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    baseline?.version !== 2 ||
    baseline.algorithm !== 'sha256' ||
    baseline.lineEndings !== 'lf' ||
    typeof baseline.sourceCommit !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(baseline.sourceCommit) ||
    typeof baseline.runtimeSourceCommit !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(baseline.runtimeSourceCommit) ||
    !baseline.migrations ||
    typeof baseline.migrations !== 'object' ||
    Array.isArray(baseline.migrations) ||
    !baseline.runtimeScripts ||
    typeof baseline.runtimeScripts !== 'object' ||
    Array.isArray(baseline.runtimeScripts)
  ) {
    throw new Error(`${BASELINE_FILE} 格式不合法`);
  }
  const entries = Object.entries(baseline.migrations);
  if (entries.length === 0) throw new Error(`${BASELINE_FILE} 没有 migration 条目`);
  for (const [fileName, hash] of entries) {
    const gitPath = `apps/desktop/drizzle/${fileName}`;
    if (
      !MIGRATION_PATH_RE.test(gitPath) ||
      typeof hash !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(hash)
    ) {
      throw new Error(`${BASELINE_FILE} 条目不合法: ${fileName}`);
    }
  }
  const runtimeEntries = Object.entries(baseline.runtimeScripts);
  if (runtimeEntries.length === 0) throw new Error(`${BASELINE_FILE} 没有 runtime script 条目`);
  for (const [fileName, hash] of runtimeEntries) {
    const gitPath = `apps/desktop/drizzle/scripts/${fileName}`;
    const sqlFileName = fileName.replace(/\.ts$/, '.sql');
    if (
      !MIGRATION_SCRIPT_PATH_RE.test(gitPath) ||
      typeof hash !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(hash) ||
      !(sqlFileName in baseline.migrations)
    ) {
      throw new Error(`${BASELINE_FILE} runtime script 条目不合法: ${fileName}`);
    }
  }
  const runtimeSourceCommit = resolveCommit(repoRoot, baseline.runtimeSourceCommit);
  const sourceScriptPaths = runGit(repoRoot, [
    'ls-tree',
    '-r',
    '--name-only',
    runtimeSourceCommit,
    '--',
    'apps/desktop/drizzle/scripts',
  ])
    .split(/\r?\n/)
    .filter((gitPath) => MIGRATION_SCRIPT_PATH_RE.test(gitPath))
    .sort();
  const declaredScriptPaths = runtimeEntries
    .map(([fileName]) => `apps/desktop/drizzle/scripts/${fileName}`)
    .sort();
  if (JSON.stringify(sourceScriptPaths) !== JSON.stringify(declaredScriptPaths)) {
    throw new Error(
      `${BASELINE_FILE} runtime script 集合与 ${runtimeSourceCommit.slice(0, 10)} 不一致`,
    );
  }
  for (const [fileName, expectedHash] of runtimeEntries) {
    const gitPath = `apps/desktop/drizzle/scripts/${fileName}`;
    const sourceHash = normalizedSha256(
      runGit(repoRoot, ['show', `${runtimeSourceCommit}:${gitPath}`]),
    );
    if (sourceHash !== expectedHash) {
      throw new Error(
        `${BASELINE_FILE} runtime script 指纹与 ${runtimeSourceCommit.slice(0, 10)} 不一致: ${fileName}`,
      );
    }
  }
  return baseline;
}

/** 校验从旧仓迁入的固定 migration 快照。 */
export function findBaselineMigrationChanges(repoRoot) {
  const baseline = readMigrationBaseline(repoRoot);
  const violations = [];
  for (const [fileName, expectedHash] of Object.entries(baseline.migrations)) {
    const gitPath = `apps/desktop/drizzle/${fileName}`;
    const currentPath = path.join(repoRoot, ...gitPath.split('/'));
    if (!fs.existsSync(currentPath)) {
      violations.push({ path: gitPath, kind: 'deleted' });
      continue;
    }
    const currentHash = normalizedSha256(fs.readFileSync(currentPath, 'utf-8'));
    if (currentHash !== expectedHash) {
      violations.push({ path: gitPath, kind: 'modified' });
    }
  }
  const runtimeScriptPaths = [];
  for (const [fileName, expectedHash] of Object.entries(baseline.runtimeScripts)) {
    const gitPath = `apps/desktop/drizzle/scripts/${fileName}`;
    runtimeScriptPaths.push(gitPath);
    const currentPath = path.join(repoRoot, ...gitPath.split('/'));
    if (!fs.existsSync(currentPath)) {
      violations.push({ path: gitPath, kind: 'deleted' });
      continue;
    }
    const currentHash = normalizedSha256(fs.readFileSync(currentPath, 'utf-8'));
    if (currentHash !== expectedHash) {
      violations.push({ path: gitPath, kind: 'modified' });
    }
  }
  return {
    sourceCommit: baseline.sourceCommit,
    runtimeSourceCommit: baseline.runtimeSourceCommit,
    migrationCount: Object.keys(baseline.migrations).length,
    runtimeScriptCount: runtimeScriptPaths.length,
    runtimeScriptPaths,
    violations,
  };
}

/** 把任意可解析 ref 固定成完整 commit SHA。 */
export function resolveCommit(repoRoot, ref) {
  if (!ref || typeof ref !== 'string') throw new Error('migration freeze ref is empty');
  return runGit(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
}

function companionScriptPath(sqlPath) {
  const fileName = path.posix.basename(sqlPath).replace(/\.sql$/, '.ts');
  return `apps/desktop/drizzle/scripts/${fileName}`;
}

/**
 * 比较某个新仓 commit 中已有的 migration SQL + companion TS 与当前工作树。
 *
 * 从迁仓首个 commit 起就存在的 companion 由固定基线保护；这里跳过这些路径，
 * 避免 main 曾误改历史脚本后，正确恢复反而被错误的 main tree 阻断。
 */
export function findFrozenMigrationChanges(repoRoot, ref, authoritativeRuntimePaths = new Set()) {
  const commit = resolveCommit(repoRoot, ref);
  const treePaths = runGit(repoRoot, [
    'ls-tree',
    '-r',
    '--name-only',
    commit,
    '--',
    'apps/desktop/drizzle',
  ])
    .split(/\r?\n/)
    .filter(Boolean);
  const migrationPaths = treePaths.filter((gitPath) => MIGRATION_PATH_RE.test(gitPath));
  const frozenScriptPaths = new Set(
    treePaths.filter((gitPath) => MIGRATION_SCRIPT_PATH_RE.test(gitPath)),
  );

  const violations = [];
  try {
    const frozenBaseline = JSON.parse(runGit(repoRoot, ['show', `${commit}:${BASELINE_GIT_PATH}`]));
    if (frozenBaseline.version >= 2) {
      const currentBaseline = JSON.parse(
        fs.readFileSync(path.join(repoRoot, BASELINE_FILE), 'utf-8'),
      );
      const frozenRuntimeBaseline = {
        version: frozenBaseline.version,
        runtimeSourceCommit: frozenBaseline.runtimeSourceCommit,
        runtimeScripts: frozenBaseline.runtimeScripts,
      };
      const currentRuntimeBaseline = {
        version: currentBaseline.version,
        runtimeSourceCommit: currentBaseline.runtimeSourceCommit,
        runtimeScripts: currentBaseline.runtimeScripts,
      };
      if (JSON.stringify(frozenRuntimeBaseline) !== JSON.stringify(currentRuntimeBaseline)) {
        violations.push({ path: BASELINE_GIT_PATH, kind: 'modified-runtime-baseline' });
      }
    }
  } catch (error) {
    throw new Error(
      `无法核对 ${commit.slice(0, 10)} 的 runtime baseline: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  for (const gitPath of migrationPaths) {
    const currentPath = path.join(repoRoot, ...gitPath.split('/'));
    if (!fs.existsSync(currentPath)) {
      violations.push({ path: gitPath, kind: 'deleted' });
      continue;
    }
    const frozenContent = runGit(repoRoot, ['show', `${commit}:${gitPath}`]);
    const currentContent = fs.readFileSync(currentPath, 'utf-8');
    if (normalizedSha256(frozenContent) !== normalizedSha256(currentContent)) {
      violations.push({ path: gitPath, kind: 'modified' });
    }

    const scriptPath = companionScriptPath(gitPath);
    if (authoritativeRuntimePaths.has(scriptPath)) continue;
    const scriptExistsAtBaseline = frozenScriptPaths.has(scriptPath);
    const currentScriptPath = path.join(repoRoot, ...scriptPath.split('/'));
    const scriptExistsNow = fs.existsSync(currentScriptPath);
    if (!scriptExistsAtBaseline && scriptExistsNow) {
      violations.push({ path: scriptPath, kind: 'added-runtime-script' });
      continue;
    }
    if (scriptExistsAtBaseline && !scriptExistsNow) {
      violations.push({ path: scriptPath, kind: 'deleted' });
      continue;
    }
    if (scriptExistsAtBaseline) {
      const frozenScript = runGit(repoRoot, ['show', `${commit}:${scriptPath}`]);
      const currentScript = fs.readFileSync(currentScriptPath, 'utf-8');
      if (normalizedSha256(frozenScript) !== normalizedSha256(currentScript)) {
        violations.push({ path: scriptPath, kind: 'modified' });
      }
    }
  }
  return {
    commit,
    migrationCount: migrationPaths.length,
    runtimeScriptCount: frozenScriptPaths.size,
    violations,
  };
}

function githubPullRequestBase(env) {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) return null;
  try {
    const event = JSON.parse(fs.readFileSync(eventPath, 'utf-8'));
    const sha = event?.pull_request?.base?.sha;
    return typeof sha === 'string' && sha ? sha : null;
  } catch {
    return null;
  }
}

/**
 * 当前分支若追踪某个远端 main，则它才是本仓发布 migration 的正确基线。
 *
 * Lex 同时保留 Cindy 的 origin remote；不能因为它叫 origin 就把 Cindy 的 main
 * 当成 Lex 已发布历史。只接受形如 lex/main 的追踪分支，避免 feature branch 被误当作冻结基线。
 */
function currentMainTrackingUpstream(repoRoot) {
  try {
    const upstream = runGit(repoRoot, [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}',
    ]).trim();
    return upstream.endsWith('/main') ? upstream : null;
  } catch {
    return null;
  }
}

/** 新仓尚无首个 commit 时允许无 main 基线；固定 manifest 仍会保护迁入历史。 */
export function resolveMainBaseline(repoRoot, env = process.env) {
  const candidates = [
    env.XDT_MIGRATION_BASE_REF,
    githubPullRequestBase(env),
    currentMainTrackingUpstream(repoRoot),
    'main',
    'origin/main',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return { ref: candidate, commit: resolveCommit(repoRoot, candidate) };
    } catch {
      // 尝试下一个本地可用基线；本函数不做网络 fetch。
    }
  }
  return null;
}

export function validateMigrationFreeze(repoRoot, env = process.env) {
  const fixedCheck = findBaselineMigrationChanges(repoRoot);
  const baseline = resolveMainBaseline(repoRoot, env);
  const mainCheck = baseline
    ? findFrozenMigrationChanges(repoRoot, baseline.commit, new Set(fixedCheck.runtimeScriptPaths))
    : null;
  return { fixedCheck, baseline, mainCheck };
}
