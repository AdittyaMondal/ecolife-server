import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizationStatus, organizationType, orgMemberRole } from './enums.ts';
import { users } from './users.ts';

/**
 * A partner organization — an industry, an NGO or a product seller.
 *
 * Deliberately NOT values on `users.role`. An organization is a thing with
 * people in it, and the two are different questions: `users.role` is who you
 * are globally, this is what a company is. Folding them together would make
 * "corporate partner" mutually exclusive with "person who logs a footprint",
 * which is wrong — every partner is also an ordinary user who tracks, earns
 * points and appears on the leaderboard.
 *
 * `status` starts at 'pending'. An unapproved organization's portal is
 * read-only: anyone can sign up claiming to be a corporate partner, and
 * nobody gets to list products or host official drives on that claim alone.
 */
export const organizations = pgTable(
  'organizations',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    slug: text('slug').notNull().unique(),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    type: organizationType('type').notNull(),
    status: organizationStatus('status').notNull().default('pending'),
    description: text('description'),
    logoUrl: text('logo_url'),
    websiteUrl: text('website_url'),
    contactEmail: text('contact_email'),
    contactPhone: text('contact_phone'),
    city: text('city'),
    regionCode: text('region_code'),
    address: text('address'),
    /**
     * Seller sales commission override in basis points (e.g. 800 = 8.00%).
     * If NULL, platform default commission from system_settings applies.
     */
    commissionRateBps: integer('commission_rate_bps'),
    /** Who approved or rejected it, and when. Null while pending. */
    reviewedBy: bigint('reviewed_by', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewNote: text('review_note'),
    verificationDetails: jsonb('verification_details').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('orgs_type_status_idx').on(t.type, t.status),
    uniqueIndex('orgs_name_lower_unq').on(sql`lower(${t.name})`),
    check(
      'org_commission_bps_valid',
      sql`${t.commissionRateBps} IS NULL OR (${t.commissionRateBps} >= 0 AND ${t.commissionRateBps} <= 5000)`,
    ),
  ],
);

/**
 * Who belongs to which organization.
 *
 * `one_org_per_user` enforces the product rule that a person belongs to at
 * most one organization, so no client needs a portal switcher. It is a join
 * table rather than two columns on `users` precisely so that rule can be
 * relaxed later by dropping ONE INDEX, instead of migrating data out of
 * `users` into a new table.
 *
 * `owner` can invite and remove members and edit the organization; `member`
 * can only use the portal.
 */
export const organizationMembers = pgTable(
  'organization_members',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    organizationId: bigint('organization_id', { mode: 'number' })
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: orgMemberRole('role').notNull().default('member'),
    shareFootprint: boolean('share_footprint').notNull().default(true),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('one_org_per_user').on(t.userId),
    index('org_members_org_idx').on(t.organizationId, t.role),
  ],
);
