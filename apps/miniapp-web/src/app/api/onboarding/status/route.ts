import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
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

export async function GET(req: Request): Promise<NextResponse> {
  const tg = new URL(req.url).searchParams.get('tg');
  if (!tg) return NextResponse.json({ onboarded: false });
  let tgUserId: bigint;
  try {
    tgUserId = BigInt(tg);
  } catch {
    return NextResponse.json({ onboarded: false });
  }
  try {
    const { db } = getDb();
    const rows = await db
      .select({
        mainWallet: schema.users.mainWallet,
        agentAddress: schema.users.agentAddress,
        currentFeeTenthsBp: schema.users.currentFeeTenthsBp,
        revokedAt: schema.users.revokedAt,
      })
      .from(schema.users)
      .where(eq(schema.users.tgUserId, tgUserId))
      .limit(1);
    const row = rows[0];
    if (!row || row.revokedAt) return NextResponse.json({ onboarded: false });
    return NextResponse.json({
      onboarded: true,
      mainWallet: row.mainWallet,
      agentAddress: row.agentAddress,
      feeBps: row.currentFeeTenthsBp / 10,
    });
  } catch (err) {
    console.error('status check failed', err);
    return NextResponse.json({ onboarded: false });
  }
}
