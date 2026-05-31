/**
 * Server-side loader for the OG card font files. Reads InterDisplay TTFs
 * from `public/fonts` once per Node process, then keeps them in-memory.
 * Used by both the referral and trade share OG routes.
 *
 * The files are shipped in the deployment bundle (under `public/fonts/`),
 * so this works in both local dev and on Vercel's nodejs runtime.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface OgFont {
  readonly name: string;
  readonly data: ArrayBuffer;
  readonly weight: 400 | 700 | 900;
  readonly style: 'normal';
}

let cache: readonly OgFont[] | null = null;

export async function loadOgFonts(): Promise<readonly OgFont[]> {
  if (cache) return cache;
  const base = path.join(process.cwd(), 'public', 'fonts');
  const [reg, bold, black] = await Promise.all([
    readFile(path.join(base, 'Inter-Regular.ttf')),
    readFile(path.join(base, 'Inter-Bold.ttf')),
    readFile(path.join(base, 'Inter-Black.ttf')),
  ]);
  cache = [
    { name: 'Inter', data: bufToArrayBuf(reg), weight: 400, style: 'normal' },
    { name: 'Inter', data: bufToArrayBuf(bold), weight: 700, style: 'normal' },
    { name: 'Inter', data: bufToArrayBuf(black), weight: 900, style: 'normal' },
  ];
  return cache;
}

function bufToArrayBuf(b: Buffer): ArrayBuffer {
  const ab = new ArrayBuffer(b.byteLength);
  new Uint8Array(ab).set(b);
  return ab;
}
