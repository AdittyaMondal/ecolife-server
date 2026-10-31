import { bigint, bigserial, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users.ts';

/**
 * PRD-v2 §7.7.
 *
 * `actorUserId` is a real user. v1's admin was a shared PIN rather than an
 * account, so `auth()->id()` was null and every audit row it wrote had no
 * actor — a log that cannot answer "who did this" is not an audit log.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorUserId: bigint('actor_user_id', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    /** 'user' | 'admin' | 'system' */
    actorType: text('actor_type').notNull().default('user'),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    oldValues: jsonb('old_values'),
    newValues: jsonb('new_values'),
    ipAddress: text('ip_address'),
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_entity_idx').on(t.entityType, t.entityId),
    index('audit_actor_time_idx').on(t.actorUserId, t.createdAt.desc()),
  ],
);
