/**
 * Drizzle schema barrel.
 *
 * Intentionally empty: the core data model is being redesigned. Add one file
 * per table (PRD §9.2) and re-export it here, then run `pnpm migration:generate`.
 *
 * Conventions when the new core lands (PRD §10):
 *   - snake_case columns, `id` as bigserial, timestamptz everywhere
 *   - money-like integers are `integer` with a CHECK >= 0
 *   - soft-delete (deletedAt) only where a UI needs it
 *   - enums live in `enums.ts` and are mirrored into ecolife-app by codegen,
 *     so keep declarations literal and one value per line
 *   - use RELATIVE imports in this directory; drizzle-kit loads the barrel
 *     through esbuild, which does not resolve tsconfig path aliases
 */
export {};
