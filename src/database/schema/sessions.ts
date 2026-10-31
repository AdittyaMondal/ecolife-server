import { bigint, bigserial, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users.ts';

/**
 * PRD-v2 §7.2 / §6.1.
 *
 * Refresh tokens are stored HASHED — a database leak must not yield live
 * sessions. `familyId` groups a rotation chain: presenting an already-rotated
 * token means it leaked, so the whole family is revoked rather than just that
 * token.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    refreshTokenHash: text('refresh_token_hash').notNull().unique(),
    familyId: text('family_id').notNull(),
    /** 'web' | 'ios' | 'android' — web keeps the token in a cookie, mobile in secure-store. */
    platform: text('platform').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_family_idx').on(t.familyId)],
);
