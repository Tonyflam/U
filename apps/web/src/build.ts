/**
 * Build script: emits dist/index.html from the renderer.
 *
 * Run with: `npm run build -w @whalepod/web` (after the tsc -b step that
 * compiles this file). The output is a single static file — deploy by
 * copying dist/index.html behind any HTTP server / CDN.
 *
 * BOT_URL environment variable controls the CTA. Defaults to the production
 * bot handle.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLandingHtml } from './landing.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public');
const outPath = join(outDir, 'index.html');

const botUrl = process.env['BOT_URL'] ?? 'https://t.me/whalepod_bot';
const html = buildLandingHtml({ botUrl });

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, html, 'utf8');
console.log(`wrote ${outPath} (${String(html.length)} bytes)`);
