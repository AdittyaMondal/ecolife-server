import { env } from '@config/env.ts';
import { closeDatabase } from '@database/client.ts';
import { app } from './app.ts';

const server = Bun.serve({
  port: env.PORT,
  fetch: app.fetch,
});

console.log(`ecolife-server listening on http://localhost:${server.port} (${env.NODE_ENV})`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await server.stop();
    await closeDatabase();
    process.exit(0);
  });
}
