/**
 * Seed a small set of featured whales so /whales returns useful results.
 *
 * Run: `cd apps/bot && node --import tsx scripts/seedFeaturedWhales.ts`
 *      (or via the workspace: `npx tsx apps/bot/scripts/seedFeaturedWhales.ts`)
 *
 * Pass `--clear` to first un-feature every existing whale.
 */
import 'dotenv/config';
import { createDb, schema } from '@whalepod/schema';
import { eq, sql } from 'drizzle-orm';

interface Seed {
  readonly address: string;
  readonly alias: string;
}

// Replace these with addresses you actually want curated. Lowercase only.
// (Schema stores addresses lowercased; the repo lookup lowercases first.)
const SEEDS: readonly Seed[] = [
  { address: '0xf3f496c9486be5924a93d67e98298733bb47057c', alias: 'Hyperliquid Whale A' },
  { address: '0x31ca8395cf837de08b24da3f660e77761dfb974b', alias: 'Hyperliquid Whale B' },
  { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', alias: 'Smart Money C' },
];

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL not set');
  const ssl = (process.env['DATABASE_SSL'] as 'require' | 'prefer' | 'disable' | undefined) ?? 'require';
  const { db, client } = createDb({ url, ssl, max: 2 });

  try {
    if (process.argv.includes('--clear')) {
      await db.update(schema.whales).set({ isFeatured: false });
      console.log('un-featured all existing whales');
    }

    for (const s of SEEDS) {
      const addr = s.address.toLowerCase();
      await db
        .insert(schema.whales)
        .values({ address: addr, alias: s.alias, isFeatured: true, lastFillAt: sql`now()` })
        .onConflictDoUpdate({
          target: schema.whales.address,
          set: { alias: s.alias, isFeatured: true, lastFillAt: sql`now()` },
        });
      console.log(`seeded ${addr}  (${s.alias})`);
    }

    const rows = await db
      .select({ address: schema.whales.address, alias: schema.whales.alias })
      .from(schema.whales)
      .where(eq(schema.whales.isFeatured, true));
    console.log(`\nfeatured whales now in DB: ${rows.length.toString()}`);
    for (const r of rows) console.log(`  ${r.address}  ${r.alias ?? ''}`);
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
