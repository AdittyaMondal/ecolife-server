/**
 * Drizzle schema barrel — 28 tables (PRD-v2 §7).
 *
 * One file per table. Files in this directory use RELATIVE imports: drizzle-kit
 * loads this barrel through esbuild, which does not resolve tsconfig path
 * aliases, and an alias here breaks `pnpm migration:generate`.
 *
 * The invariants that matter are in the database, not in a service, because
 * every one of them corresponds to a defect v1 shipped:
 *   - reward_idempotency_unq        every award is replay-safe
 *   - one_active_goal_per_user      partial unique, not app bookkeeping
 *   - footprint_user_date_unq       the daily rollup is safely idempotent
 *   - orders_discount_within_cap    the 20% coin ceiling, in SQL
 *   - daily_log_client_unq          the offline queue can replay
 *   - event_pass_user_unq           registering twice returns the same pass
 *   - products_stock_non_negative   overselling fails the write
 *   - tree_rarity_rank_unq          "rarer than" is a total order
 */

export * from './addresses.ts';
export * from './audit-logs.ts';
export * from './cart-items.ts';
export * from './cities.ts';
export * from './daily-footprints.ts';
export * from './daily-logs.ts';
export * from './email-tokens.ts';
// Enums, re-exported for the client codegen that parses this tree.
export * from './enums.ts';
export * from './event-passes.ts';
// Events
export * from './events.ts';
export * from './goals.ts';
// Carbon model
export * from './lifestyle-profiles.ts';
// Supporting
export * from './notifications.ts';
export * from './orders.ts';
export * from './organization-questions.ts';
export * from './organizations.ts';
// Marketplace
export * from './products.ts';
export * from './push-tokens.ts';
export * from './rate-limits.ts';
// Reference
export * from './regions.ts';
// Economy
export * from './reward-transactions.ts';
export * from './sessions.ts';
// Gamification
export * from './tree-rarities.ts';
export * from './trees.ts';
// Identity
export * from './users.ts';
