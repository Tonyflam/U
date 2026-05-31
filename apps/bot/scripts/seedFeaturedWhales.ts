/**
 * Seed / un-seed featured whales so /whales returns useful results.
 *
 * Usage:
 *   # add a single whale (alias optional)
 *   npx tsx apps/bot/scripts/seedFeaturedWhales.ts add 0xABCD... "Alias name"
 *
 *   # remove (un-feature) a whale
 *   npx tsx apps/bot/scripts/seedFeaturedWhales.ts remove 0xABCD...
 *
 *   # un-feature ALL whales
 *   npx tsx apps/bot/scripts/seedFeaturedWhales.ts clear
 *
 *   # list current featured whales
 *   npx tsx apps/bot/scripts/seedFeaturedWhales.ts list
 *
 * Addresses are stored lowercased.
 */
import 'dotenv/config';
import { createDb, schema } from '@whalepod/schema';
import { eq, sql } from 'drizzle-orm';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u;

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL not set');
  const ssl =
    (process.env['DATABASE_SSL'] as 'require' | 'prefer' | 'disable' | undefined) ?? 'require';
  const { db, client } = createDb({ url, ssl, max: 2 });

  try {
    const [cmd, addrRaw, ...rest] = process.argv.slice(2);
    const alias = rest.join(' ').trim() || null;

    switch (cmd) {
      case 'add': {
        if (!addrRaw || !ADDRESS_RE.test(addrRaw)) {
          throw new Error('add requires a valid 0x… address');
        }
        const addr = addrRaw.toLowerCase();
        await db
          .insert(schema.whales)
          .values({ address: addr, alias, isFeatured: true, lastFillAt: sql`now()` })
          .onConflictDoUpdate({
            target: schema.whales.address,
            set: { alias, isFeatured: true, lastFillAt: sql`now()` },
          });
        console.log(`✅ featured ${addr}${alias ? `  (${alias})` : ''}`);
        break;
      }
      case 'remove': {
        if (!addrRaw || !ADDRESS_RE.test(addrRaw)) {
          throw new Error('remove requires a valid 0x… address');
        }
        const addr = addrRaw.toLowerCase();
        await db
          .update(schema.whales)
          .set({ isFeatured: false })
          .where(eq(schema.whales.address, addr));
        console.log(`✅ un-featured ${addr}`);
        break;
      }
      case 'clear': {
        await db.update(schema.whales).set({ isFeatured: false });
        console.log('✅ un-featured all whales');
        break;
      }
      case 'list':
      case undefined: {
        const rows = await db
          .select({ address: schema.whales.address, alias: schema.whales.alias })
          .from(schema.whales)
          .where(eq(schema.whales.isFeatured, true));
        console.log(`featured whales: ${rows.length.toString()}`);
        for (const r of rows) console.log(`  ${r.address}  ${r.alias ?? ''}`);
        break;
      }
      default:
        throw new Error(`unknown command: ${cmd ?? ''}\nUsage: add|remove|clear|list`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
