import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { createDb, schema } from '@whalepod/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let dbCached: ReturnType<typeof createDb> | undefined;
function getDb(): ReturnType<typeof createDb> {
  if (dbCached) return dbCached;
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL required');
  const ssl = (process.env['DATABASE_SSL'] ?? 'require') as 'require' | 'prefer' | 'disable';
  dbCached = createDb({ url, ssl, max: 1 });
  return dbCached;
}

interface Body {
  tgUserId?: string;
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (!body.tgUserId) {
    return NextResponse.json({ error: 'missing_tg' }, { status: 400 });
  }
  let tgUserId: bigint;
  try {
    tgUserId = BigInt(body.tgUserId);
  } catch {
    return NextResponse.json({ error: 'bad_tg' }, { status: 400 });
  }

  try {
    const { db } = getDb();
    await db
      .update(schema.users)
      .set({ revokedAt: sql`now()`, killSwitch: true })
      .where(eq(schema.users.tgUserId, tgUserId));
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('disconnect failed', err);
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : 'unknown';
    return NextResponse.json({ error: 'internal', detail }, { status: 500 });
  }
}
