import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { DomainError } from './errors.ts';

const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

export interface MigrationFile {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

interface AppliedRow {
  id: number;
  name: string;
  checksum: string;
  applied_at: string;
}

export interface AppliedMigration {
  readonly id: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

/** Migration files are `NNN_name.sql`; the number is the version and must be unique. */
export function listMigrationFiles(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const seen = new Map<number, string>();
  const migrations: MigrationFile[] = [];
  for (const name of files) {
    const match = /^(\d+)_(.+)\.sql$/.exec(name);
    if (match === null) {
      throw new DomainError('MIGRATION_FAILED', `migration file name is not NNN_name.sql`, name);
    }
    const id = Number(match[1]);
    const previous = seen.get(id);
    if (previous !== undefined) {
      throw new DomainError('MIGRATION_FAILED', `duplicate migration version ${id}`, `${previous} and ${name}`);
    }
    seen.set(id, name);
    const sql = readFileSync(join(dir, name), 'utf8');
    migrations.push({ id, name, sql, checksum: checksum(sql) });
  }
  return migrations;
}

export function appliedMigrations(db: DatabaseSync): AppliedMigration[] {
  const rows = db
    .prepare('SELECT id, name, checksum, applied_at FROM schema_migrations ORDER BY id')
    .all() as unknown as AppliedRow[];
  return rows.map((row) => ({ id: row.id, name: row.name, checksum: row.checksum, appliedAt: row.applied_at }));
}

/**
 * Apply every pending migration, in order, each in its own transaction.
 *
 * Refuses to start when an already-applied migration's text no longer matches
 * what was run (《方案》§47.3：禁止代码启动时悄悄修改未知 schema) — the fix is a
 * new migration, never an edit of a released one.
 */
export function migrate(db: DatabaseSync, appliedAt: string, dir: string = MIGRATIONS_DIR): AppliedMigration[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const already = new Map(appliedMigrations(db).map((migration) => [migration.id, migration]));
  const newlyApplied: AppliedMigration[] = [];

  for (const migration of listMigrationFiles(dir)) {
    const previous = already.get(migration.id);
    if (previous !== undefined) {
      if (previous.checksum !== migration.checksum) {
        throw new DomainError(
          'MIGRATION_CHECKSUM_MISMATCH',
          `migration ${migration.name} was already applied with different content`,
          `applied=${previous.checksum.slice(0, 12)} file=${migration.checksum.slice(0, 12)}`,
        );
      }
      continue;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(
        migration.id,
        migration.name,
        migration.checksum,
        appliedAt,
      );
      db.exec('COMMIT');
    } catch (cause) {
      db.exec('ROLLBACK');
      throw new DomainError(
        'MIGRATION_FAILED',
        `migration ${migration.name} failed`,
        cause instanceof Error ? cause.message : String(cause),
      );
    }
    newlyApplied.push({ id: migration.id, name: migration.name, checksum: migration.checksum, appliedAt });
  }
  return newlyApplied;
}
