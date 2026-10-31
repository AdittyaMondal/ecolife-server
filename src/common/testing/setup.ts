import { afterAll } from 'bun:test';
import { closeDatabase } from '@database/client.ts';

/**
 * Preloaded by bunfig.toml for every `bun test` run.
 *
 * The pg Pool is a module singleton shared by every test file in the process,
 * so teardown belongs here exactly once. A per-file afterAll would close the
 * pool while a sibling file is still querying it.
 */
afterAll(async () => {
  await closeDatabase();
});
