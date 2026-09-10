import Database from 'better-sqlite3';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  checkMigrationCompatibility,
  hashMigrationFile,
  listMigrations,
  prepareMigrationRuntimeManifest,
  runMigrationReplay,
} from '../migrationRunner';

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createDrizzleDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cindy-passive-migrations-'));
  cleanupDirs.push(dir);
  writeFileSync(path.join(dir, '0000_init.sql'), 'CREATE TABLE first (id TEXT);\n', 'utf8');
  writeFileSync(path.join(dir, '0001_second.sql'), 'CREATE TABLE second (id TEXT);\n', 'utf8');
  return dir;
}

function createDb(schemaVersion: number, withHistory = true): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE migration_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
    INSERT INTO migration_meta (key, value) VALUES ('schema_version', '${schemaVersion}');
  `);
  if (withHistory) {
    db.exec(`
      CREATE TABLE migration_history (
        seq INTEGER PRIMARY KEY NOT NULL,
        file_name TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);
  }
  return db;
}

function seedExactHistory(db: Database.Database, drizzleDir: string): void {
  const insert = db.prepare(
    `INSERT INTO migration_history (seq, file_name, content_hash, applied_at)
     VALUES (?, ?, ?, ?)`,
  );
  for (const fileName of ['0000_init.sql', '0001_second.sql']) {
    insert.run(
      Number(fileName.slice(0, 4)),
      fileName,
      hashMigrationFile(path.join(drizzleDir, fileName)),
      123,
    );
  }
}

describe('checkMigrationCompatibility', () => {
  it('accepts an exact schema version and migration history match', () => {
    const drizzleDir = createDrizzleDir();
    const db = createDb(1);
    try {
      seedExactHistory(db, drizzleDir);

      expect(checkMigrationCompatibility(db, drizzleDir)).toEqual({
        compatible: true,
        databaseVersion: 1,
        checkoutVersion: 1,
        issues: [],
      });
    } finally {
      db.close();
    }
  });

  it('rejects a database with pending checkout migrations', () => {
    const drizzleDir = createDrizzleDir();
    const db = createDb(0);
    try {
      const first = '0000_init.sql';
      db.prepare(
        `INSERT INTO migration_history (seq, file_name, content_hash, applied_at)
         VALUES (?, ?, ?, ?)`,
      ).run(0, first, hashMigrationFile(path.join(drizzleDir, first)), 123);

      const report = checkMigrationCompatibility(db, drizzleDir);
      expect(report.compatible).toBe(false);
      expect(report.issues.map((issue) => issue.kind)).toEqual([
        'schema-version-behind',
        'history-entry-missing',
      ]);
    } finally {
      db.close();
    }
  });

  it('rejects a database newer than the checkout', () => {
    const drizzleDir = createDrizzleDir();
    const db = createDb(2);
    try {
      seedExactHistory(db, drizzleDir);

      const report = checkMigrationCompatibility(db, drizzleDir);
      expect(report.compatible).toBe(false);
      expect(report.issues).toEqual([
        { kind: 'schema-version-ahead', databaseVersion: 2, checkoutVersion: 1 },
      ]);
    } finally {
      db.close();
    }
  });

  it('rejects drifted, missing, or unexpected migration history entries', () => {
    const drizzleDir = createDrizzleDir();
    const db = createDb(1);
    try {
      db.prepare(
        `INSERT INTO migration_history (seq, file_name, content_hash, applied_at)
         VALUES (?, ?, ?, ?)`,
      ).run(0, '0000_renamed.sql', 'wrong-hash', 123);
      db.prepare(
        `INSERT INTO migration_history (seq, file_name, content_hash, applied_at)
         VALUES (?, ?, ?, ?)`,
      ).run(99, '0099_future.sql', 'future-hash', 123);

      const report = checkMigrationCompatibility(db, drizzleDir);
      expect(report.compatible).toBe(false);
      expect(report.issues.map((issue) => issue.kind)).toEqual([
        'history-entry-mismatch',
        'history-entry-missing',
        'history-entry-unexpected',
      ]);
    } finally {
      db.close();
    }
  });

  it('fails closed when migration_history is unavailable', () => {
    const drizzleDir = createDrizzleDir();
    const db = createDb(1, false);
    try {
      const report = checkMigrationCompatibility(db, drizzleDir);
      expect(report.compatible).toBe(false);
      expect(report.issues[0]?.kind).toBe('history-unavailable');
    } finally {
      db.close();
    }
  });

  it.each(['abc', '1junk', '9007199254740992', '-1', '01'])(
    'fails closed for an invalid schema_version value: %s',
    (value) => {
      const drizzleDir = createDrizzleDir();
      const db = createDb(1);
      try {
        seedExactHistory(db, drizzleDir);
        db.prepare(`UPDATE migration_meta SET value=? WHERE key='schema_version'`).run(value);

        const report = checkMigrationCompatibility(db, drizzleDir);
        expect(report.compatible).toBe(false);
        expect(report.databaseVersion).toBe(-1);
        expect(report.issues.map((issue) => issue.kind)).toContain('history-unavailable');
      } finally {
        db.close();
      }
    },
  );

  it('includes companion TS scripts in the persisted runtime identity', () => {
    const drizzleDir = createDrizzleDir();
    const scriptsDir = path.join(drizzleDir, 'scripts');
    mkdirSync(scriptsDir);
    const scriptPath = path.join(scriptsDir, '0001_second.ts');
    writeFileSync(scriptPath, 'export function run() { return "first"; }\n', 'utf8');
    const dbFilePath = path.join(drizzleDir, 'shared.db');
    const db = createDb(1);
    try {
      seedExactHistory(db, drizzleDir);
      prepareMigrationRuntimeManifest(dbFilePath, drizzleDir, 1);
      expect(checkMigrationCompatibility(db, drizzleDir, dbFilePath).compatible).toBe(true);

      writeFileSync(scriptPath, 'export function run() { return "changed"; }\n', 'utf8');
      const report = checkMigrationCompatibility(db, drizzleDir, dbFilePath);
      expect(report.compatible).toBe(false);
      expect(report.issues.map((issue) => issue.kind)).toContain('runtime-manifest-mismatch');
    } finally {
      db.close();
    }
  });

  it('never overwrites the identity of an already applied companion TS migration', () => {
    const drizzleDir = createDrizzleDir();
    const scriptsDir = path.join(drizzleDir, 'scripts');
    mkdirSync(scriptsDir);
    const scriptPath = path.join(scriptsDir, '0001_second.ts');
    writeFileSync(scriptPath, 'export function run() { return "applied-a"; }\n', 'utf8');
    const dbFilePath = path.join(drizzleDir, 'shared.db');

    prepareMigrationRuntimeManifest(dbFilePath, drizzleDir, 1);
    writeFileSync(scriptPath, 'export function run() { return "checkout-b"; }\n', 'utf8');

    expect(() => prepareMigrationRuntimeManifest(dbFilePath, drizzleDir, 1)).toThrow(
      /applied migration runtime identity changed at seq 1/,
    );
  });

  it('normalizes the known bad 0062 companion identity back to canonical', () => {
    const sourceDrizzleDir = path.resolve(__dirname, '../../../../drizzle');
    const drizzleDir = mkdtempSync(path.join(tmpdir(), 'cindy-runtime-identity-repair-'));
    cleanupDirs.push(drizzleDir);
    const scriptsDir = path.join(drizzleDir, 'scripts');
    mkdirSync(scriptsDir);

    const fileName = '0062_flaky_mimic.sql';
    const sqlPath = path.join(drizzleDir, fileName);
    const scriptPath = path.join(scriptsDir, '0062_flaky_mimic.ts');
    const canonicalScript = readFileSync(
      path.join(sourceDrizzleDir, 'scripts', '0062_flaky_mimic.ts'),
      'utf8',
    );
    const badScript = canonicalScript.replace('@lizi/maker-scheduler', '@cindy/maker-scheduler');
    writeFileSync(sqlPath, readFileSync(path.join(sourceDrizzleDir, fileName), 'utf8'), 'utf8');
    writeFileSync(scriptPath, badScript, 'utf8');

    expect(hashMigrationFile(sqlPath)).toBe(
      '77b8741ac31c159eb422746c0165d102ad65693236c80d0ff055fd70cd43fe68',
    );
    expect(hashMigrationFile(scriptPath)).toBe(
      '0ea82003cac0419a4a483b0afc1743d6fdba0b50085104720d5b2561e721072d',
    );

    const dbFilePath = path.join(drizzleDir, 'shared.db');
    prepareMigrationRuntimeManifest(dbFilePath, drizzleDir, 62);
    writeFileSync(scriptPath, canonicalScript, 'utf8');
    expect(hashMigrationFile(scriptPath)).toBe(
      '0a72ba2d89237b4b7322ffbbeb644c94e01be7d159851e220f51c03edfa80b78',
    );

    const db = createDb(62);
    try {
      db.prepare(
        `INSERT INTO migration_history (seq, file_name, content_hash, applied_at)
         VALUES (?, ?, ?, ?)`,
      ).run(62, fileName, hashMigrationFile(sqlPath), 123);

      expect(checkMigrationCompatibility(db, drizzleDir, dbFilePath).compatible).toBe(true);
      expect(() => prepareMigrationRuntimeManifest(dbFilePath, drizzleDir, 62)).not.toThrow();
      const repaired = JSON.parse(readFileSync(`${dbFilePath}.migration-runtime.json`, 'utf8')) as {
        migrations: Array<{ scriptHash: string | null }>;
      };
      expect(repaired.migrations[0]?.scriptHash).toBe(
        '0a72ba2d89237b4b7322ffbbeb644c94e01be7d159851e220f51c03edfa80b78',
      );
    } finally {
      db.close();
    }
  });

  it('fails closed when the runtime identity has not been published by a primary', () => {
    const drizzleDir = createDrizzleDir();
    const db = createDb(1);
    try {
      seedExactHistory(db, drizzleDir);
      const report = checkMigrationCompatibility(
        db,
        drizzleDir,
        path.join(drizzleDir, 'missing.db'),
      );
      expect(report.compatible).toBe(false);
      expect(report.issues.map((issue) => issue.kind)).toContain('runtime-manifest-unavailable');
    } finally {
      db.close();
    }
  });

  it('upgrades a released Lex v102 runtime sidecar through the post-102 upstream chain', () => {
    const sourceDrizzleDir = path.resolve(__dirname, '../../../../drizzle');
    const legacyDrizzleDir = mkdtempSync(path.join(tmpdir(), 'lex-v102-drizzle-'));
    cleanupDirs.push(legacyDrizzleDir);
    const migrations = listMigrations(sourceDrizzleDir);
    const releasedMigrations = migrations.filter((migration) => migration.seq <= 102);
    const releasedGitWorkspaceMigration = releasedMigrations.at(-1);

    expect(releasedGitWorkspaceMigration?.fileName).toBe('0102_merge_git_workspace_tabs.sql');
    expect(hashMigrationFile(releasedGitWorkspaceMigration!.sqlPath)).toBe(
      'b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd',
    );
    expect(releasedGitWorkspaceMigration?.tsScriptPath).toBeDefined();
    expect(hashMigrationFile(releasedGitWorkspaceMigration!.tsScriptPath!)).toBe(
      '5c7356dc8b74b167a30c759dcf823047841ea0240666174282f947b7cfc8b5dc',
    );

    for (const migration of releasedMigrations) {
      copyFileSync(migration.sqlPath, path.join(legacyDrizzleDir, migration.fileName));
      if (migration.tsScriptPath) {
        const scriptsDir = path.join(legacyDrizzleDir, 'scripts');
        mkdirSync(scriptsDir, { recursive: true });
        copyFileSync(
          migration.tsScriptPath,
          path.join(scriptsDir, path.basename(migration.tsScriptPath)),
        );
      }
    }

    const dbFilePath = path.join(legacyDrizzleDir, 'lex-v102.db');
    const db = new Database(dbFilePath);
    try {
      db.exec(`
        CREATE TABLE migration_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
        CREATE TABLE migration_history (
          seq INTEGER PRIMARY KEY NOT NULL,
          file_name TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        );
        CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL);
        CREATE TABLE right_sidebar_tabs (session_id TEXT NOT NULL, kind TEXT NOT NULL);
        CREATE TABLE skill_usage_exposures (
          skill_name TEXT NOT NULL,
          analyzer_version TEXT NOT NULL,
          seen_at INTEGER NOT NULL,
          raw_file_path TEXT NOT NULL
        );
        INSERT INTO migration_meta (key, value) VALUES ('schema_version', '102');
      `);
      const insertHistory = db.prepare(
        `INSERT INTO migration_history (seq, file_name, content_hash, applied_at)
         VALUES (?, ?, ?, 1)`,
      );
      for (const migration of releasedMigrations) {
        insertHistory.run(migration.seq, migration.fileName, hashMigrationFile(migration.sqlPath));
      }

      prepareMigrationRuntimeManifest(dbFilePath, legacyDrizzleDir, 102);
      const releasedManifest = JSON.parse(
        readFileSync(`${dbFilePath}.migration-runtime.json`, 'utf8'),
      ) as {
        migrations: Array<{
          seq: number;
          fileName: string;
          sqlHash: string;
          scriptHash: string | null;
        }>;
      };
      const releasedIdentity = releasedManifest.migrations.find(
        (migration) => migration.seq === 102,
      );

      expect(releasedIdentity).toEqual({
        seq: 102,
        fileName: '0102_merge_git_workspace_tabs.sql',
        sqlHash: 'b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd',
        scriptHash: '5c7356dc8b74b167a30c759dcf823047841ea0240666174282f947b7cfc8b5dc',
      });

      prepareMigrationRuntimeManifest(dbFilePath, sourceDrizzleDir, 102);
      const replay = runMigrationReplay(db, { drizzleDir: sourceDrizzleDir });
      expect(replay.applied.map((migration) => migration.seq)).toEqual([103, 104]);
      expect(
        db
          .prepare(
            `SELECT name FROM sqlite_master
           WHERE type = 'index' AND name = 'idx_skill_usage_exposures_skill_recent'`,
          )
          .pluck()
          .get(),
      ).toBe('idx_skill_usage_exposures_skill_recent');
      expect(
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bot_profiles'`)
          .pluck()
          .get(),
      ).toBe('bot_profiles');

      const finalManifest = JSON.parse(
        readFileSync(`${dbFilePath}.migration-runtime.json`, 'utf8'),
      ) as {
        migrations: Array<{
          seq: number;
          fileName: string;
          sqlHash: string;
          scriptHash: string | null;
        }>;
      };
      expect(finalManifest.migrations.find((migration) => migration.seq === 102)).toEqual(
        releasedIdentity,
      );
      expect(finalManifest.migrations.at(-1)).toMatchObject({
        seq: 104,
        fileName: '0104_bot_mode.sql',
      });
      expect(checkMigrationCompatibility(db, sourceDrizzleDir, dbFilePath)).toEqual({
        compatible: true,
        databaseVersion: 104,
        checkoutVersion: 104,
        issues: [],
      });
    } finally {
      db.close();
    }
  });
});
