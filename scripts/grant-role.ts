import { closeDatabase, db } from '@database/client.ts';
import { organizationMembers, organizations, users } from '@database/schema/index.ts';
import { eq, sql } from 'drizzle-orm';

/**
 * Grants the roles that have no HTTP route yet.
 *
 * EcoLife has four separate role systems (docs/enums.md). Two are reachable
 * over the API and two are not:
 *
 *   users.role                 admin      -> NO route. This script.
 *   organizations.type         industry   -> NO route. This script.
 *   organization_members.role  owner      -> NO route. This script.
 *   event_hosts.role           host       -> POST /events makes you the host
 *                              co_host    -> POST /events/{id}/co-hosts
 *
 * The organization module was never specified in PRD-v2, so its tables,
 * enums, guard (`requireOrgRole`) and error codes all exist while no
 * endpoint does. Until that module ships, this is the supported way to
 * create a corporate/community/seller account — deliberately a script and
 * not a hidden endpoint, because "anyone can self-serve an approved
 * organization" is exactly what the pending/approved workflow exists to
 * prevent.
 *
 *   bun scripts/grant-role.ts --email a@b.c --admin
 *   bun scripts/grant-role.ts --email a@b.c --org "Acme Ltd" --type industry
 *   bun scripts/grant-role.ts --email a@b.c --org "Acme Ltd" --type seller \
 *                             --status pending --member-role member
 *
 * `--status` defaults to `approved`, because the usual reason to run this is
 * to get a working account for testing. Pass `pending` to exercise the
 * approval path that `requireOrgRole` enforces.
 */

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token?.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

const ORG_TYPES = ['industry', 'ngo', 'seller'] as const;
const ORG_STATUSES = ['pending', 'approved', 'rejected', 'suspended'] as const;
const MEMBER_ROLES = ['owner', 'member'] as const;

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const email = typeof args.email === 'string' ? args.email.toLowerCase() : null;
if (!email) {
  fail(
    'Usage:\n' +
      '  bun scripts/grant-role.ts --email <address> --admin\n' +
      '  bun scripts/grant-role.ts --email <address> --org "<name>" --type industry|ngo|seller\n' +
      '                            [--status approved|pending|rejected|suspended]\n' +
      '                            [--member-role owner|member]',
  );
}

// lower(email) is how the unique index is built; matching it any other way
// misses the row that exists.
const [user] = await db
  .select({ id: users.id, name: users.name, role: users.role })
  .from(users)
  .where(sql`lower(${users.email}) = ${email}`);
if (!user) fail(`No user with email ${email}. Register them first.`);

if (args.admin) {
  await db.update(users).set({ role: 'admin', updatedAt: new Date() }).where(eq(users.id, user.id));
  console.log(`${user.name} <${email}> is now role=admin`);
}

if (args.org) {
  const name = typeof args.org === 'string' ? args.org : null;
  if (!name) fail('--org needs a name, e.g. --org "Acme Ltd"');

  const type = String(args.type ?? '');
  if (!ORG_TYPES.includes(type as (typeof ORG_TYPES)[number])) {
    fail(`--type must be one of: ${ORG_TYPES.join(', ')}`);
  }
  const status = String(args.status ?? 'approved');
  if (!ORG_STATUSES.includes(status as (typeof ORG_STATUSES)[number])) {
    fail(`--status must be one of: ${ORG_STATUSES.join(', ')}`);
  }
  const memberRole = String(args['member-role'] ?? 'owner');
  if (!MEMBER_ROLES.includes(memberRole as (typeof MEMBER_ROLES)[number])) {
    fail(`--member-role must be one of: ${MEMBER_ROLES.join(', ')}`);
  }

  // `organizations.slug` is NOT NULL and has no default, so it is generated
  // here. A short random suffix rather than a counter: two people creating
  // "Acme Ltd" must not collide, and `slug` is unique.
  const slug = `${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'org'
  }-${crypto.randomUUID().slice(0, 6)}`;

  // One transaction: an organization with no owner, or an owner pointing at
  // no organization, is worse than neither.
  await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({
        slug,
        name,
        type: type as (typeof ORG_TYPES)[number],
        status: status as (typeof ORG_STATUSES)[number],
        // An approved org needs a reviewer on record; the schema keeps these
        // columns for exactly that, and leaving them null would make an
        // approval untraceable.
        ...(status === 'approved' ? { reviewedBy: user.id, reviewedAt: new Date() } : {}),
      })
      .returning({ id: organizations.id });
    if (!org) throw new Error('organization insert returned nothing');

    await tx.insert(organizationMembers).values({
      organizationId: org.id,
      userId: user.id,
      role: memberRole as (typeof MEMBER_ROLES)[number],
    });

    console.log(
      `${user.name} <${email}> is now ${memberRole} of "${name}" ` +
        `(type=${type}, status=${status}, org id=${org.id})`,
    );
  });
}

if (!args.admin && !args.org) {
  fail('Nothing to do. Pass --admin and/or --org.');
}

// `one_org_per_user` means a second --org for the same person fails loudly
// rather than quietly giving them two.
console.log('\nCheck it with GET /api/v1/auth/me — the `organization` field reflects this.');
await closeDatabase();
