# EcoLife Backend — High-Level Overview

A plain-language map of what this backend is, who it serves, and how its main
flows work. Everything here is drawn from the code in this repository: the
database schema in `src/database/schema/`, the guards in `src/common/guards/`,
and the committed API contract in `openapi.json`.

Where something exists only as a declared contract and not yet as working
behaviour, this document says so. Nothing here is aspirational.

---

## 1. Purpose

EcoLife is a **personal carbon-footprint tracker** built around a daily habit
loop.

A person answers a short lifestyle questionnaire once, which gives the system a
**baseline** — the carbon footprint their stated lifestyle implies per day. From
then on they answer five quick questions each day, and the system computes that
day's actual footprint and compares it to the baseline. Reducing emissions earns
rewards; rewards drive a leaderboard and can be spent in an in-app marketplace of
eco-friendly products. Community events (plant drives, cleanups, workshops) give
the habit a social dimension.

This repository owns **data, domain rules, authentication and background jobs**.
It renders nothing. Two separate client repositories consume its HTTP API.

---

## 2. System Overview

### 2.1 Three repositories, not a monorepo

| Repository | Owns | Runtime |
|---|---|---|
| **`ecolife-server`** (this one) | data, domain rules, auth, jobs | Bun + Hono |
| `ecolife-web` | web rendering, admin console | Next.js |
| `ecolife-mobile` | the Android/iOS app, QR scanning, offline | Expo |

Both clients talk to this server over HTTP. **Neither queries the database
directly.**

### 2.2 Technology

- **Runtime:** Bun, with Hono as the HTTP framework
- **Database:** PostgreSQL on Neon, accessed through Drizzle ORM
- **Contract:** OpenAPI 3.1, generated from the route definitions and committed
  as `openapi.json`

### 2.3 Contract-first development

The committed `openapi.json` is treated as a product of this repository, not a
by-product. Both client repos generate their TypeScript types from the committed
file, and a mock server can serve it directly — so neither client team is ever
blocked waiting on this server to be running or finished.

### 2.4 The response envelope

Every single response, success or failure, uses the same shape:

```jsonc
// success
{ "status": true,  "data": { /* ... */ }, "error": null }

// failure
{ "status": false, "data": null, "error": { "code": "CARBON_014", "message": "…", "details": {} } }
```

Clients branch on `error.code` (a stable `DOMAIN_NNN` identifier registered in
`docs/error-codes.md`), never on the human-readable message. Internal errors and
stack traces are never sent to a client.

All routes live under the base path **`/api/v1`**.

---

## 3. Roles

This is the part most often misread, so it is worth being precise. EcoLife does
**not** have one flat list of roles. It has **four separate questions**, each
answered by its own column, and each guarded separately in
`src/common/guards/auth.guard.ts`:

| Question | Where it lives | Values | Guard |
|---|---|---|---|
| Are you signed in? | access token | — | `requireUser` → 401 |
| Are you platform staff? | `users.role` | `user`, `admin` | `requireAdmin` → 403 |
| What are you inside **your** organization? | `organization_members.role` | `owner`, `member` | `requireOrgRole` → 403 |
| May you run **this** event? | `event_hosts.role` | `host`, `co_host` | `requireEventHost` → 403 |

The last two are **membership, not identity**. Hosting one event, or belonging to
one company, grants nothing anywhere else in the system.

### 3.1 Why organizations are not values on `users.role`

A partner organization is a *thing with people in it*. Folding it into
`users.role` would make "corporate partner" mutually exclusive with "person who
logs a footprint" — which is wrong. Every partner is also an ordinary user who
tracks their own emissions, earns points and appears on the leaderboard.

Organizations have a **type**, which is a property of the organization, not of
the person:

| `organizations.type` | Platform label | Purpose |
|---|---|---|
| `industry` | Corporate | Company partners |
| `ngo` | Community | NGOs running official drives |
| `seller` | Marketplace Partner | Supplies marketplace products (`products.seller_org_id`) |

A person belongs to **at most one** organization. This is enforced by a unique
database index (`one_org_per_user`) on a join table rather than by columns on
`users`, specifically so the rule can be relaxed later by dropping one index
instead of migrating data.

### 3.2 Organizations require admin approval

An organization is created with `status = 'pending'` and is **not usable** until
a platform admin approves it. The `organizations` table records `reviewed_by`,
`reviewed_at` and `review_note` for exactly this.

The `requireOrgRole` guard reads the organization's status **live from the
database** on every request rather than trusting the access token, so a
suspension takes effect immediately instead of whenever the token happens to
expire. Anyone can sign up claiming to be a corporate partner; nobody gets to
list products or host official drives on that claim alone.

### 3.3 Role summary — who can do what

| Role | Capabilities in the backend today |
|---|---|
| **Ordinary user** | Register, verify email, onboard, log daily, set goals, view leaderboard, browse and order from the marketplace, discover and register for events, hold an event pass |
| **Event host** | Everything an ordinary user can, plus: create an event, edit it, cancel it, view its participants, add and remove co-hosts, scan passes to check attendees in |
| **Event co-host** | May view participants and scan passes. **May not** edit or cancel the event |
| **Organization member** | An ordinary user whose account is linked to an approved organization. The link is exposed on `GET /auth/me` as an `organization` object (`id`, `slug`, `name`, `type`, `status`, `role`) |
| **Organization owner** | The member who may invite and remove members and edit the organization |
| **Admin** (`users.role = 'admin'`) | Platform staff. Approves, rejects and suspends organizations; `reward_source` includes an `admin` value for manual reward grants |

---

## 4. Android Application Scope

### 4.1 What the Android app covers

The mobile app serves the **participant-facing** side of the product:

- the full ordinary-user experience — onboarding, daily tracking, goals,
  leaderboard, marketplace, event discovery and registration
- the **event host and co-host** experience, because its defining action is
  physically present and camera-based: scanning a participant's QR pass at the
  venue

The backend's own contract confirms hosting belongs in the app. The endpoint
`POST /events/{id}/manual-check-in` is documented as *"the web fallback for a
host without the app"* — meaning scanning is the app's job and the web route
exists only as a backup.

### 4.2 What is excluded: the Industry Manager role

**The Industry Manager (corporate partner / `organizations.type = 'industry'`)
role is explicitly out of scope for the Android application.**

Two reasons, both supported by what the backend actually implements:

**1. It is an administrative role, not a participant role.**
Everything that makes an industry organization meaningful in this system runs
through an approval and oversight lifecycle: an organization is created
`pending`, and a platform **admin** must approve, reject or suspend it, with the
decision recorded in `reviewed_by` / `reviewed_at` / `review_note`. The
organization-facing work that follows — managing members, managing an
organization profile, overseeing partner activity — is desk work: reviewing
records, filling longer forms, reading tables. None of it is the short,
on-the-go, one-handed interaction the daily-tracking app is designed for, and
none of it benefits from a phone's camera, location or offline cache.

**2. It is served by a website-based dashboard instead.**
The corporate partner experience is being delivered as a **web dashboard** in
`ecolife-web`, which already owns the admin console. That is the right home for
a role whose work is administrative and whose users are at a desk. Putting the
same screens into the Android app would duplicate an entire surface for a small
number of users who are not the app's audience.

**A note on the current state:** this exclusion costs the app nothing today,
because the backend has **no organization endpoints at all**. The data model
(`organizations`, `organization_members`), the type enum and the `requireOrgRole`
guard all exist and are ready, but no route in `openapi.json` creates, lists,
approves or manages an organization. The only place organization data surfaces to
a client is the read-only `organization` object on `GET /auth/me`. There is
therefore nothing for an Android screen to call, and the org API can be designed
against the web dashboard's needs when it is built.

---

## 5. Key Features

### 5.1 The baseline carbon engine

Fifteen onboarding questions across five steps produce a per-day baseline
footprint, split into five categories: **transport, food, home energy, water,
waste**.

The engine (`src/common/carbon/`) is **pure functions** — no database, no clock,
no I/O. The baseline is a function of the fifteen answers plus the user's regional
grid emission factor, and nothing else. That makes it directly unit-testable, and
it means the daily path can reuse stored components instead of recomputing
everything.

Every stored footprint records the `factor_version` it was computed with, so
changing an emission factor later does not silently rewrite history. The full
factor table with sources is public at `GET /carbon/methodology`.

### 5.2 Points and coins — two currencies, on purpose

| Currency | Behaviour |
|---|---|
| **Points** | Only ever increase. Drive leaderboard rank. Never spent. |
| **Coins** | Earned and spent. Buy discounts in the marketplace. |

They are separate because a single combined integer meant that buying something
dropped your leaderboard position.

Both are stored on `users` as a cache of the `reward_transactions` ledger,
written in the same transaction as every ledger entry and reconcilable with one
`SUM`. Database `CHECK` constraints prevent either from going negative even if
the application has a bug.

Rewards come from a fixed set of sources: `onboarding`, `daily_log`, `streak`,
`reduction`, `goal`, `event_attend`, `event_host`, `order`, `order_refund`,
`admin`.

### 5.3 Daily tracking and streaks

Five questions a day: trips taken, meals by type, air-conditioning hours, bathing
choice, and waste actions. Categories the user did not answer are **inferred from
their baseline**, and each day's record stores a `sources` map marking every
category as `logged` or `inferred`, so the user is always told which numbers they
actually provided.

Streaks (`current_streak`, `longest_streak`) are tracked on the user.

### 5.4 Goals

A user may have **one active goal at a time**, enforced by a partial unique index
in the database rather than by a service remembering to deactivate the others.

Two kinds:
- **`reduce_percent`** — cut emissions by N% against the baseline
- **`absolute_cap`** — stay under N kg CO₂e per day

When a goal is created its target is **frozen** (`baseline_kg_total`,
`target_kg_total`), so a later baseline change cannot move the goalposts
retroactively.

### 5.5 Events with QR passes

Events have a type, a status lifecycle (`draft` → `published` → `ongoing` →
`completed`, or `cancelled`), a visibility (`public` / `invite_only`), a venue
with optional coordinates, and a capacity.

Registering mints a **pass** whose code is **stored hashed**, never in plaintext.
At the venue a host scans the code to check the attendee in.

Capacity and attendance are protected by database constraints, not by application
checks: registrations cannot exceed capacity, and check-ins cannot exceed
registrations.

### 5.6 Marketplace with a capped coin discount

Products have a category, price in paise, stock, an optional CO₂-saved figure and
an optional `seller_org_id` linking them to a marketplace-partner organization.

Coins buy a discount, but **never more than 20% of the subtotal**. That cap is a
database `CHECK` on the orders table, so it holds even if the pricing code is
wrong. Orders also carry an `idempotency_key` with a unique index, so replaying a
checkout returns the original order instead of charging twice.

### 5.7 Security model

- **Passwords** hashed with argon2id
- **Access token:** JWT, 15 minutes, returned in the response body
- **Refresh token:** opaque random bytes, 30 days, **stored hashed**, rotated on
  every use, with **reuse detection** — replaying an old token revokes the whole
  session family
- **Web** receives the refresh token in an httpOnly cookie; **mobile** receives
  it in the body for secure device storage. One endpoint serves both.
- **Rate limiting** is shared across replicas through Postgres, and is keyed on
  the socket address — never on a client-supplied `X-Forwarded-For`, which is
  attacker-controlled

---

## 6. Modules

Every module follows the same five-file convention: `routes` (HTTP and
validation), `service` (business rules, framework-free), `repository` (all
database queries for that module), `schema` (the wire contract) and a colocated
spec.

| Module | Responsibility |
|---|---|
| `health` | Liveness and readiness probes |
| `auth` | Registration, login, token rotation, email verification, password reset |
| `profile` | The 15-question onboarding wizard, own profile, reward ledger, data export, account deletion |
| `home` | The entire Home screen assembled in one request |
| `track` | The 5 daily questions, log submission and edits, footprint history |
| `goals` | Create, edit, cancel and track reduction goals |
| `leaderboard` | Points ranking, plus own rank without paging to it |
| `marketplace` | Products, cart, coin-discount quoting, orders, delivery addresses |
| `events` | Discovery, creation, registration, passes, QR check-in, co-host management |
| `reference` | Notifications, upload presigning, cities, regions, carbon methodology |
| `gamification` | The tree catalogue and rarity tiers; badges, reward rules and the user's forest as they land |

---

## 7. Important Workflows

### 7.1 Sign-up and session

```
POST /auth/register
  → account created, verification email token issued
  → access token (15 min) + refresh token returned
POST /auth/verify-email
  → email confirmed; required before any reward can be earned
POST /auth/refresh
  → old refresh token rotated out; reuse of an old one burns the family
```

Email verification gates **rewards**, not browsing.

### 7.2 Onboarding → baseline

```
PATCH /profile/onboarding/step/{1..5}   ← saved one step at a time, resumable
GET   /profile/onboarding               ← resume a half-finished wizard
POST  /profile/onboarding/complete      ← validates all 15 answers,
                                           computes the baseline,
                                           awards the completion reward
```

Returns the baseline breakdown, the updated wallet, and the points and coins
awarded.

### 7.3 The daily loop — the core of the product

```
GET  /track/today      ← today's log if any, the question set, prefill defaults
POST /track/logs       ← submit the day's answers
PATCH /track/logs/{id} ← editable until 02:00 the next day
```

Submitting returns, in one response: the five-category breakdown, the baseline it
was measured against, the delta and reduction percentage, which categories were
logged versus inferred, the reward granted, the new wallet, and the updated
streak.

Each submission carries a **client-generated log id**. A unique index on
`(user_id, client_log_id)` makes the submission idempotent, so a phone retrying
on a flaky connection cannot double-log or double-reward. A second unique index
on `(user_id, log_date)` makes the resulting footprint row safely upsertable.

### 7.4 Home screen in one request

`GET /home` returns everything the Home screen needs in a single round trip:
greeting, wallet, today's footprint, streak, the week's trend, a 30-day category
breakdown, the active goal, a leaderboard peek and the next event.

### 7.5 Events and check-in

```
POST   /events                      ← creator automatically becomes host
POST   /events/{id}/co-hosts        ← host only; co-hosts may scan, not edit
POST   /events/{id}/register        ← mints a pass (hashed code)
GET    /events/{id}/pass            ← own pass, with the code for the QR
POST   /events/{id}/scan            ← host/co-host scans at the venue
POST   /events/{id}/manual-check-in ← web fallback for a host without the app
```

A scan returns whether the attendee was already checked in, who they are, the
running check-in count against capacity, and the reward granted to the attendee.

### 7.6 Marketplace checkout

```
GET  /marketplace/cart            ← priced with zero coins applied
POST /marketplace/cart/preview    ← server-priced quote for a coin offer
POST /marketplace/orders          ← place the order
```

The preview is **server-priced**. The client proposes how many coins to spend; the
server returns the authoritative quote including the maximum allowed discount,
the discount actually applied, the resulting total, the coin balance afterwards
and whether the 20% cap was reached. Clients only ever *preview* a price — they
never compute one.

---

## 8. Invariants Enforced by the Database

A deliberate design principle: rules that matter are enforced by Postgres, not
only by a service that might forget to check.

| Constraint | Guarantees |
|---|---|
| `reward_idempotency_unq` | A reward can never be granted twice for the same source event |
| `one_active_goal_per_user` | At most one active goal per person |
| `footprint_user_date_unq` | One footprint row per user per day; makes the rollup idempotent |
| `daily_log_client_unq` | A retried submission cannot double-log |
| `order_idempotency_unq` | A replayed checkout returns the original order |
| `orders_discount_within_cap` | Coin discount can never exceed 20% of subtotal |
| `orders_total_is_consistent` | Total always equals subtotal minus discount |
| `products_stock_non_negative` | Overselling fails the write instead of succeeding |
| `users_coins_non_negative` / `users_points_non_negative` | Balances cannot go negative |
| `users_email_lower_unq` | Case-different emails are the same account; blocks multi-account farming |
| `events_registrations_within_capacity` | Cannot over-register an event |
| `events_checkins_within_registrations` | Cannot check in more people than registered |
| `event_pass_user_unq` | Registering twice returns the existing pass |
| `one_org_per_user` | A person belongs to at most one organization |
| `tree_rarity_rank_unq` | One tier per rank, so "rarer than" is a total order and pity has something to compare |
| `tree_rarity_weight_positive` | A tier in the roll pool always has a real chance of being drawn |
| `trees_rarity_id_tree_rarities_id_fk` (RESTRICT) | A rarity cannot be deleted out from under the trees that reference it; retire it with `is_active` |

---

## 9. Implementation Status

Being explicit, because the API contract is complete while the behaviour behind
it is not.

- **65 operations** across 55 paths are declared, typed, documented and mocked.
- **11 are implemented:** the 2 health probes and the 9 `auth` operations.
- **54 remain stubs.** Each returns a `501` and declares that `501` in its
  contract; the declaration is removed as each one is implemented.

> Counting `501` declarations in `openapi.json` gives 55, not 54.
> `POST /auth/logout` is implemented but still declares a `501` it can no longer
> return — a stale declaration to clear on the next contract regeneration.

Also complete and tested: the full database schema and migrations, the carbon
baseline engine, the authentication and session layer, the guards, the rate
limiter, and a seed dataset.

Not yet built: scheduled jobs (`src/jobs/` is empty), WebSocket support
(`src/ws/` is empty), and every domain service outside `auth`.
