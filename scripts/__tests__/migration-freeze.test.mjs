import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  findBaselineMigrationChanges,
  findFrozenMigrationChanges,
  normalizedSha256,
  resolveMainBaseline,
  validateMigrationFreeze,
} from '../../apps/desktop/scripts/lib/migration-freeze.mjs';

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
}

function createFixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-migration-freeze-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Migration Freeze Test');
  git(repo, 'config', 'user.email', 'migration-freeze@example.invalid');
  const drizzleDir = path.join(repo, 'apps', 'desktop', 'drizzle');
  fs.mkdirSync(drizzleDir, { recursive: true });
  const initialSql = 'CREATE TABLE sample (id TEXT PRIMARY KEY);\n';
  fs.writeFileSync(path.join(drizzleDir, '0000_init.sql'), initialSql);
  const scriptsDir = path.join(drizzleDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  const initialScript = 'function run() {}\nmodule.exports = { run };\n';
  fs.writeFileSync(path.join(scriptsDir, '0000_init.ts'), initialScript);
  const baselinePath = path.join(drizzleDir, 'migration-baseline.json');
  fs.writeFileSync(
    baselinePath,
    `${JSON.stringify({
      version: 1,
      algorithm: 'sha256',
      lineEndings: 'lf',
      sourceCommit: '1'.repeat(40),
      migrations: { '0000_init.sql': normalizedSha256(initialSql) },
    }, null, 2)}\n`,
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial migration');
  const runtimeSourceCommit = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(
    baselinePath,
    `${JSON.stringify({
      version: 2,
      algorithm: 'sha256',
      lineEndings: 'lf',
      sourceCommit: '1'.repeat(40),
      runtimeSourceCommit,
      migrations: { '0000_init.sql': normalizedSha256(initialSql) },
      runtimeScripts: { '0000_init.ts': normalizedSha256(initialScript) },
    }, null, 2)}\n`,
  );
  git(repo, 'add', baselinePath);
  git(repo, 'commit', '-m', 'freeze migrated runtime scripts');
  const anchor = git(repo, 'rev-parse', 'HEAD');
  return {
    repo,
    anchor,
    cleanup: () => fs.rmSync(repo, { recursive: true, force: true }),
  };
}

test('fixed baseline allows new migrations while migrated SQL stays unchanged', () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(
      path.join(fixture.repo, 'apps', 'desktop', 'drizzle', '0001_new.sql'),
      'ALTER TABLE sample ADD COLUMN name TEXT;\n',
    );
    assert.deepEqual(findBaselineMigrationChanges(fixture.repo).violations, []);
  } finally {
    fixture.cleanup();
  }
});

test('fixed baseline rejects modifying or deleting migrated SQL', () => {
  const fixture = createFixture();
  const migrationPath = path.join(fixture.repo, 'apps', 'desktop', 'drizzle', '0000_init.sql');
  try {
    fs.writeFileSync(migrationPath, 'CREATE TABLE sample (id TEXT PRIMARY KEY, name TEXT);\n');
    assert.deepEqual(findBaselineMigrationChanges(fixture.repo).violations, [
      { path: 'apps/desktop/drizzle/0000_init.sql', kind: 'modified' },
    ]);
    fs.rmSync(migrationPath);
    assert.deepEqual(findBaselineMigrationChanges(fixture.repo).violations, [
      { path: 'apps/desktop/drizzle/0000_init.sql', kind: 'deleted' },
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('fixed baseline rejects modifying or deleting migrated runtime scripts', () => {
  const fixture = createFixture();
  const scriptPath = path.join(fixture.repo, 'apps', 'desktop', 'drizzle', 'scripts', '0000_init.ts');
  try {
    fs.writeFileSync(scriptPath, 'function run() { return 1; }\nmodule.exports = { run };\n');
    assert.deepEqual(findBaselineMigrationChanges(fixture.repo).violations, [
      { path: 'apps/desktop/drizzle/scripts/0000_init.ts', kind: 'modified' },
    ]);
    fs.rmSync(scriptPath);
    assert.deepEqual(findBaselineMigrationChanges(fixture.repo).violations, [
      { path: 'apps/desktop/drizzle/scripts/0000_init.ts', kind: 'deleted' },
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('fixed baseline rejects paired runtime script and hash tampering', () => {
  const fixture = createFixture();
  const drizzleDir = path.join(fixture.repo, 'apps', 'desktop', 'drizzle');
  const scriptPath = path.join(drizzleDir, 'scripts', '0000_init.ts');
  const baselinePath = path.join(drizzleDir, 'migration-baseline.json');
  try {
    const changedScript = 'function run() { return 1; }\nmodule.exports = { run };\n';
    fs.writeFileSync(scriptPath, changedScript);
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    baseline.runtimeScripts['0000_init.ts'] = normalizedSha256(changedScript);
    fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);

    assert.throws(
      () => findBaselineMigrationChanges(fixture.repo),
      /runtime script 指纹与 .* 不一致/,
    );
    assert.deepEqual(
      findFrozenMigrationChanges(
        fixture.repo,
        fixture.anchor,
        new Set(['apps/desktop/drizzle/scripts/0000_init.ts']),
      ).violations,
      [
        {
          path: 'apps/desktop/drizzle/migration-baseline.json',
          kind: 'modified-runtime-baseline',
        },
      ],
    );
  } finally {
    fixture.cleanup();
  }
});

test('new repository main baseline keeps freezing committed migrations', () => {
  const fixture = createFixture();
  try {
    assert.deepEqual(findFrozenMigrationChanges(fixture.repo, fixture.anchor).violations, []);
    assert.deepEqual(
      resolveMainBaseline(fixture.repo, { XDT_MIGRATION_BASE_REF: fixture.anchor }),
      { ref: fixture.anchor, commit: fixture.anchor },
    );
  } finally {
    fixture.cleanup();
  }
});

test('main tracking upstream takes precedence over an upstream origin main', () => {
  const fixture = createFixture();
  try {
    git(fixture.repo, 'remote', 'add', 'lex', 'https://example.invalid/lex.git');
    git(fixture.repo, 'update-ref', 'refs/remotes/lex/main', fixture.anchor);
    git(fixture.repo, 'branch', '--set-upstream-to=lex/main', 'main');

    assert.deepEqual(resolveMainBaseline(fixture.repo, {}), {
      ref: 'lex/main',
      commit: fixture.anchor,
    });
  } finally {
    fixture.cleanup();
  }
});

test('topic tracking upstream is not treated as a migration release baseline', () => {
  const fixture = createFixture();
  try {
    git(fixture.repo, 'remote', 'add', 'lex', 'https://example.invalid/lex.git');
    git(fixture.repo, 'checkout', '-b', 'feature/migration-work');
    git(fixture.repo, 'update-ref', 'refs/remotes/lex/feature/migration-work', fixture.anchor);
    git(
      fixture.repo,
      'branch',
      '--set-upstream-to=lex/feature/migration-work',
      'feature/migration-work',
    );

    assert.deepEqual(resolveMainBaseline(fixture.repo, {}), {
      ref: 'main',
      commit: fixture.anchor,
    });
  } finally {
    fixture.cleanup();
  }
});

test('new repository main baseline freezes companion runtime scripts', () => {
  const fixture = createFixture();
  const scriptPath = path.join(
    fixture.repo,
    'apps',
    'desktop',
    'drizzle',
    'scripts',
    '0000_init.ts',
  );
  try {
    fs.writeFileSync(
      scriptPath,
      'function run() { return 1; }\nmodule.exports = { run };\n',
    );
    assert.deepEqual(findFrozenMigrationChanges(fixture.repo, fixture.anchor).violations, [
      { path: 'apps/desktop/drizzle/scripts/0000_init.ts', kind: 'modified' },
    ]);

    fs.rmSync(scriptPath);
    assert.deepEqual(findFrozenMigrationChanges(fixture.repo, fixture.anchor).violations, [
      { path: 'apps/desktop/drizzle/scripts/0000_init.ts', kind: 'deleted' },
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('adding a runtime script to an already-frozen SQL changes its identity', () => {
  const fixture = createFixture();
  const scriptPath = path.join(
    fixture.repo,
    'apps',
    'desktop',
    'drizzle',
    'scripts',
    '0000_init.ts',
  );
  try {
    fs.rmSync(scriptPath);
    git(fixture.repo, 'add', '-u');
    git(fixture.repo, 'commit', '-m', 'baseline without runtime script');
    const noScriptAnchor = git(fixture.repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(scriptPath, 'function run() {}\nmodule.exports = { run };\n');
    assert.deepEqual(findFrozenMigrationChanges(fixture.repo, noScriptAnchor).violations, [
      {
        path: 'apps/desktop/drizzle/scripts/0000_init.ts',
        kind: 'added-runtime-script',
      },
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('a new migration may add its companion runtime script', () => {
  const fixture = createFixture();
  try {
    const drizzleDir = path.join(fixture.repo, 'apps', 'desktop', 'drizzle');
    fs.writeFileSync(path.join(drizzleDir, '0001_new.sql'), 'SELECT 1;\n');
    fs.writeFileSync(
      path.join(drizzleDir, 'scripts', '0001_new.ts'),
      'function run() {}\nmodule.exports = { run };\n',
    );
    assert.deepEqual(findFrozenMigrationChanges(fixture.repo, fixture.anchor).violations, []);
  } finally {
    fixture.cleanup();
  }
});

test('fixed runtime baseline permits restoring a script after main recorded a bad identity', () => {
  const fixture = createFixture();
  const scriptPath = path.join(
    fixture.repo,
    'apps',
    'desktop',
    'drizzle',
    'scripts',
    '0000_init.ts',
  );
  try {
    const canonical = fs.readFileSync(scriptPath, 'utf-8');
    fs.writeFileSync(
      scriptPath,
      'function run() { return 1; }\nmodule.exports = { run };\n',
    );
    git(fixture.repo, 'add', scriptPath);
    git(fixture.repo, 'commit', '-m', 'bad historical edit');
    const badMain = git(fixture.repo, 'rev-parse', 'HEAD');

    fs.writeFileSync(scriptPath, canonical);
    const result = validateMigrationFreeze(fixture.repo, {
      XDT_MIGRATION_BASE_REF: badMain,
    });
    assert.deepEqual(result.fixedCheck.violations, []);
    assert.deepEqual(result.mainCheck?.violations, []);
  } finally {
    fixture.cleanup();
  }
});
