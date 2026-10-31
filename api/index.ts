/**
 * Vercel entrypoint.
 *
 * Vercel Functions run **Node**, not Bun, so `src/main.ts` (which calls
 * `Bun.serve`) is never used here — that file stays the local dev server.
 * Hono's own Vercel adapter turns the same `app` into a Node handler, so
 * neither runtime forks the application code.
 *
 * Read `vercel.json` alongside this: the install step must skip devDependencies
 * or `drizzle-kit` pulls in esbuild, whose postinstall shells out to `node`
 * and fails on the build image.
 */
import { handle } from 'hono/vercel';
import { app } from '../src/app.ts';

export const config = {
  // Node, not edge: the `pg` driver needs TCP sockets, which edge has no access to.
  runtime: 'nodejs22.x',
};

export default handle(app);
