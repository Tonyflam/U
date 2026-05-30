/**
 * In-process Postgres test harness via pglite.
 *
 * Boots an empty pglite instance, runs every committed migration in journal
 * order, and returns a Drizzle client bound to our schema. Use in tests that
 * need to exercise real SQL (CHECK constraints, unique indexes, FK cascades)
 * without an external Postgres dependency.
 *
 * Not for production. The bundled WASM is ~2 MB; only loaded when a test
 * actually constructs a harness.
 */
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as schema from './schema.js';

export type TestDb = PgliteDatabase<typeof schema>;

export interface TestHarness {
  readonly db: TestDb;
  readonly pg: PGlite;
  close(): Promise<void>;
}

interface Journal {
  readonly entries: readonly { readonly tag: string }[];
}

/**
 * Locate the migrations directory.
 *
 * `testHarness.js` may run from either `src/db/` (vitest in this package)
 * or `dist/db/` (consumer packages importing the compiled output). The SQL
 * files always live in `src/db/migrations/`. Walk up to the package root
 * (`@whalepod/schema`'s package.json) and resolve from there.
 */
function findMigrationsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
        if (pkg.name === '@whalepod/schema') {
          return join(dir, 'src', 'db', 'migrations');
        }
      } catch {
        // ignore, keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('testHarness: could not locate @whalepod/schema package root');
}

function loadJournal(migrationsDir: string): Journal {
  const raw = readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf8');
  return JSON.parse(raw) as Journal;
}

/**
 * Split a migration file into statements. drizzle-kit emits a sentinel
 * comment `--> statement-breakpoint` between statements; we use that as the
 * sole delimiter so multi-statement blocks (DO $$ ... $$, multi-line CHECKs)
 * stay intact.
 */
function splitStatements(sql: string): string[] {
  return sql
    .split(/-->\s*statement-breakpoint/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function createTestDb(): Promise<TestHarness> {
  const pg = await PGlite.create({ extensions: { pgcrypto } });
  await pg.exec('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

  const migrationsDir = findMigrationsDir();
  const entries = loadJournal(migrationsDir).entries;
  for (const entry of entries) {
    const path = join(migrationsDir, `${entry.tag}.sql`);
    const sql = readFileSync(path, 'utf8');
    for (const stmt of splitStatements(sql)) {
      await pg.exec(stmt);
    }
  }

  const db = drizzle(pg, { schema });
  return {
    db,
    pg,
    async close() {
      await pg.close();
    },
  };
}
