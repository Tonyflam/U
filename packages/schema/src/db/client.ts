import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import postgres, { type Options } from 'postgres';
import * as schema from './schema.js';

/** Production Drizzle client (postgres-js). */
export type Db = PostgresJsDatabase<typeof schema>;

/**
 * Driver-agnostic Drizzle handle bound to the WhalePod schema. Repo
 * implementations accept this so both the production postgres-js client
 * and the pglite test harness are valid `db` arguments.
 */
export type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface CreateDbOptions {
  url: string;
  /** TLS mode. `require` for managed Postgres (Supabase, Neon, RDS). */
  ssl?: 'require' | 'prefer' | 'disable';
  /** Connection pool size. Default 10. Tune per service. */
  max?: number;
  /** Postgres.js extras for tests / advanced cases. */
  extra?: Omit<Options<Record<string, never>>, 'ssl' | 'max'>;
}

/**
 * Create a Drizzle client bound to the WhalePod schema.
 *
 * Returns the Drizzle client plus the underlying postgres-js connection so
 * callers can `await client.end()` on shutdown.
 */
export function createDb(options: CreateDbOptions): { db: Db; client: postgres.Sql } {
  const ssl = options.ssl ?? 'require';
  const client = postgres(options.url, {
    ssl: ssl === 'disable' ? false : ssl,
    max: options.max ?? 10,
    prepare: false, // safe default for poolers (Supabase pgbouncer)
    ...options.extra,
  });
  const db = drizzle(client, { schema });
  return { db, client };
}
