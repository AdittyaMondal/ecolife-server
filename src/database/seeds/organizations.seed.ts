import { organizationMembers, organizations } from '@database/schema/index.ts';
import { sql } from 'drizzle-orm';
import type { Tx } from './support.ts';
import type { SeededUser } from './users.seed.ts';

/**
 * Partner organizations (PRD-v2 §6.9, §7.7).
 *
 * Upserts by slug rather than delete-and-reinsert: `products.seller_org_id`
 * references these rows ON DELETE RESTRICT, because once the Seller Portal
 * lands a delete would fail against a live catalogue. Membership rows are
 * rebuilt instead — they cascade from `users`, which the wipe already removed.
 *
 * Covers all three types and all four review statuses, so the admin review
 * queue, the rejected/suspended branches and the member portal all have real
 * rows to render without anyone creating them by hand.
 */

/**
 * SYNTHETIC identifiers in a well-known placeholder format, not real
 * registrations. `verification_details` is free-form jsonb — whatever a
 * partner submits at sign-up — and it is gated to admins and the
 * organization's own owner in `serialise()`, so the seed is also the fixture
 * that proves the gate.
 */
type OrgSeed = {
  slug: string;
  code: string;
  name: string;
  type: 'industry' | 'ngo' | 'seller';
  status: 'pending' | 'approved' | 'rejected' | 'suspended';
  description: string;
  websiteUrl: string;
  contactEmail: string;
  contactPhone: string;
  city: string;
  regionCode: string;
  reviewNote: string | null;
  verificationDetails: Record<string, unknown>;
  /** Seeded-user emails. The first is the owner; the rest are members. */
  people: string[];
};

/**
 * Codes are fixed in the `9001xx` range, which this seed owns.
 *
 * `uniqueOrgCode()` generates random six digits for real sign-ups, so a
 * collision is possible in principle; keeping the seed in one narrow band
 * makes "which code is seeded" answerable without querying.
 */
const ORGANIZATIONS: OrgSeed[] = [
  {
    slug: 'greencore-industries',
    code: '900101',
    name: 'GreenCore Industries',
    type: 'industry',
    status: 'approved',
    description:
      'Mid-sized packaging manufacturer running an employee carbon-reduction programme ' +
      'across three plants.',
    websiteUrl: 'https://greencore.example.com',
    contactEmail: 'sustainability@greencore.example.com',
    contactPhone: '+912226001101',
    city: 'Mumbai',
    regionCode: 'MH',
    reviewNote: null,
    verificationDetails: {
      cin: 'U21010MH2012PLC000111',
      gstin: '27ABCDE1234F1Z5',
      incorporationYear: 2012,
      employeeCount: 480,
      plants: ['Mumbai', 'Pune', 'Nashik'],
      contactPerson: { name: 'R. Sharma', designation: 'Head of Sustainability' },
      complianceCertificates: ['ISO 14001:2015', 'ISO 50001:2018'],
    },
    people: ['aarav.sharma@ecolife.app', 'isha.verma@ecolife.app', 'rohan.mehta@ecolife.app'],
  },
  {
    slug: 'vanashakti-foundation',
    code: '900102',
    name: 'Vanashakti Foundation',
    type: 'ngo',
    status: 'approved',
    description: 'Urban reforestation and lake restoration across Bengaluru and Mysuru.',
    websiteUrl: 'https://vanashakti.example.org',
    contactEmail: 'drives@vanashakti.example.org',
    contactPhone: '+918026001102',
    city: 'Bengaluru',
    regionCode: 'KA',
    reviewNote: null,
    verificationDetails: {
      registrationNumber: 'KA/BLR/2009/0004521',
      registrationAct: 'Karnataka Societies Registration Act, 1960',
      darpanId: 'KA/2019/0231145',
      panNumber: 'AABTV1234C',
      fcraRegistered: false,
      focusAreas: ['reforestation', 'lake restoration', 'school outreach'],
      contactPerson: { name: 'A. Iyer', designation: 'Programme Director' },
    },
    people: ['ananya.iyer@ecolife.app', 'kabir.singh@ecolife.app'],
  },
  {
    slug: 'earthkind-store',
    code: '900103',
    name: 'EarthKind Store',
    type: 'seller',
    status: 'approved',
    description: 'Zero-waste household and kitchen goods, shipped plastic-free.',
    websiteUrl: 'https://earthkind.example.com',
    contactEmail: 'orders@earthkind.example.com',
    contactPhone: '+914424001103',
    city: 'Chennai',
    regionCode: 'TN',
    reviewNote: null,
    verificationDetails: {
      gstin: '33ABCDE1234F1Z5',
      storeCategory: 'household',
      warehouseCity: 'Chennai',
      returnPolicyDays: 14,
      fssaiLicence: '12422010000123',
      contactPerson: { name: 'M. Nair', designation: 'Founder' },
    },
    people: ['meera.nair@ecolife.app'],
  },
  {
    slug: 'nirmal-textiles',
    code: '900104',
    name: 'Nirmal Textiles',
    type: 'industry',
    status: 'pending',
    description: 'Cotton processing unit applying to run an employee commute programme.',
    websiteUrl: 'https://nirmaltextiles.example.com',
    contactEmail: 'hr@nirmaltextiles.example.com',
    contactPhone: '+919127001104',
    city: 'Ahmedabad',
    regionCode: 'GJ',
    reviewNote: null,
    verificationDetails: {
      cin: 'U17110GJ2016PTC000222',
      gstin: '24ABCDE1234F1Z5',
      incorporationYear: 2016,
      employeeCount: 150,
      contactPerson: { name: 'A. Rao', designation: 'HR Manager' },
      complianceCertificates: [],
    },
    people: ['arjun.rao@ecolife.app'],
  },
  {
    slug: 'clean-coast-collective',
    code: '900105',
    name: 'Clean Coast Collective',
    type: 'ngo',
    status: 'pending',
    description: 'Volunteer-run beach cleanups along the Konkan coast. Awaiting review.',
    websiteUrl: 'https://cleancoast.example.org',
    contactEmail: 'volunteer@cleancoast.example.org',
    contactPhone: '+912226001105',
    city: 'Mumbai',
    regionCode: 'MH',
    reviewNote: null,
    verificationDetails: {
      registrationNumber: 'MH/MUM/2021/0009812',
      registrationAct: 'Societies Registration Act, 1860',
      darpanId: null,
      panNumber: 'AABTC5678D',
      fcraRegistered: false,
      focusAreas: ['beach cleanup', 'plastic audit'],
      contactPerson: { name: 'D. Kapoor', designation: 'Coordinator' },
    },
    people: ['diya.kapoor@ecolife.app'],
  },
  {
    slug: 'bharatbulk-traders',
    code: '900106',
    name: 'BharatBulk Traders',
    type: 'seller',
    status: 'rejected',
    description: 'Bulk commodity reseller. Application rejected — see the review note.',
    websiteUrl: 'https://bharatbulk.example.com',
    contactEmail: 'sales@bharatbulk.example.com',
    contactPhone: '+911126001106',
    city: 'Delhi',
    regionCode: 'DL',
    // ORG_010: a rejection requires a note. A decision a human defends later
    // should be explained while they still remember why.
    reviewNote: 'GSTIN does not match the registered trade name. Asked to resubmit.',
    verificationDetails: {
      gstin: '07ABCDE9999F1Z5',
      storeCategory: 'kitchen',
      warehouseCity: 'Delhi',
      returnPolicyDays: 0,
      contactPerson: { name: 'V. Patel', designation: 'Proprietor' },
    },
    people: ['vivaan.patel@ecolife.app'],
  },
  {
    slug: 'shakti-cements',
    code: '900107',
    name: 'Shakti Cements',
    type: 'industry',
    status: 'suspended',
    description: 'Previously approved, suspended pending an emissions audit.',
    websiteUrl: 'https://shakticements.example.com',
    contactEmail: 'contact@shakticements.example.com',
    contactPhone: '+914026001107',
    city: 'Hyderabad',
    regionCode: 'TG',
    reviewNote: 'Suspended while the 2026 stack-emissions audit is outstanding.',
    verificationDetails: {
      cin: 'U26940TG2004PLC000333',
      gstin: '36ABCDE1234F1Z5',
      incorporationYear: 2004,
      employeeCount: 1200,
      contactPerson: { name: 'S. Joshi', designation: 'Compliance Lead' },
      complianceCertificates: ['ISO 14001:2015'],
    },
    people: ['saanvi.joshi@ecolife.app'],
  },
];

export type OrganizationSeedResult = { organizations: number; members: number };

/**
 * Upserts the organizations and rebuilds their membership.
 *
 * `adminUserId` becomes `reviewed_by` on everything already decided, so the
 * audit trail names a real actor rather than NULL — PRD-v2 §6.9.
 */
export async function seedOrganizations(
  tx: Tx,
  seededUsers: SeededUser[],
  adminUserId: number | null,
): Promise<OrganizationSeedResult> {
  const byEmail = new Map(seededUsers.map((u) => [u.email.toLowerCase(), u.id]));

  const now = new Date();
  const rows = ORGANIZATIONS.map((o) => ({
    slug: o.slug,
    code: o.code,
    name: o.name,
    type: o.type,
    status: o.status,
    description: o.description,
    logoUrl: null,
    websiteUrl: o.websiteUrl,
    contactEmail: o.contactEmail,
    contactPhone: o.contactPhone,
    city: o.city,
    regionCode: o.regionCode,
    // Only a decided application has a reviewer. Pending stays NULL, which is
    // what the admin queue filters on.
    reviewedBy: o.status === 'pending' ? null : adminUserId,
    reviewedAt: o.status === 'pending' ? null : now,
    reviewNote: o.reviewNote,
    verificationDetails: o.verificationDetails,
  }));

  const inserted = await tx
    .insert(organizations)
    .values(rows)
    .onConflictDoUpdate({
      target: organizations.slug,
      set: {
        code: sql`excluded.code`,
        name: sql`excluded.name`,
        type: sql`excluded.type`,
        status: sql`excluded.status`,
        description: sql`excluded.description`,
        websiteUrl: sql`excluded.website_url`,
        contactEmail: sql`excluded.contact_email`,
        contactPhone: sql`excluded.contact_phone`,
        city: sql`excluded.city`,
        regionCode: sql`excluded.region_code`,
        reviewedBy: sql`excluded.reviewed_by`,
        reviewedAt: sql`excluded.reviewed_at`,
        reviewNote: sql`excluded.review_note`,
        verificationDetails: sql`excluded.verification_details`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: organizations.id, slug: organizations.slug });

  const orgIdBySlug = new Map(inserted.map((r) => [r.slug, r.id]));

  const memberRows: (typeof organizationMembers.$inferInsert)[] = [];
  for (const o of ORGANIZATIONS) {
    const organizationId = orgIdBySlug.get(o.slug);
    if (organizationId === undefined) continue;
    o.people.forEach((email, i) => {
      const userId = byEmail.get(email.toLowerCase());
      // A renamed seeded account should not take the whole seed down; the
      // organization still exists, it just has one fewer member.
      if (userId === undefined) {
        console.warn(`  organizations.seed: no seeded user '${email}' for ${o.slug}`);
        return;
      }
      memberRows.push({
        organizationId,
        userId,
        role: i === 0 ? 'owner' : 'member',
        shareFootprint: true,
      });
    });
  }

  // `one_org_per_user` is a unique index on user_id. The wipe cascaded these
  // rows away with their accounts, so this is an insert; DO NOTHING is the
  // belt for a user who somehow still belongs somewhere.
  const members =
    memberRows.length === 0
      ? []
      : await tx
          .insert(organizationMembers)
          .values(memberRows)
          .onConflictDoNothing({ target: organizationMembers.userId })
          .returning({ id: organizationMembers.id });

  return { organizations: inserted.length, members: members.length };
}
