/**
 * Writes `openapi.json` from the live route definitions.
 *
 * The output is COMMITTED. Both client repos run `openapi-typescript` against
 * the committed file, so `next build` and `eas build` never need this server on
 * disk, and a contract change shows up as a compile error in the clients rather
 * than a surprise at runtime (PRD-v2 §2.3).
 *
 *   pnpm gen:openapi     # write
 *   pnpm gen:openapi -- --check   # exit 1 if stale (used by CI)
 */
import { app } from '../src/app.ts';

const OUT = new URL('../openapi.json', import.meta.url);

const doc = app.getOpenAPI31Document({
  openapi: '3.1.0',
  info: { title: 'EcoLife API', version: '0.1.0' },
});

const next = `${JSON.stringify(doc, null, 2)}\n`;
const check = process.argv.includes('--check');

if (check) {
  const current = await Bun.file(OUT)
    .text()
    .catch(() => '');
  if (current !== next) {
    console.error('openapi.json is stale. Run `pnpm gen:openapi` and commit the result.');
    process.exit(1);
  }
  console.log('openapi.json is up to date.');
} else {
  await Bun.write(OUT, next);
  const paths = Object.keys(doc.paths ?? {}).length;
  console.log(`openapi.json written — ${paths} paths.`);
}
