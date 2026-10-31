# Enums

Every Postgres enum lives in one file: [`src/database/schema/enums.ts`](../src/database/schema/enums.ts).
Nothing else may declare one.

Adding a value is a **migration**. `ALTER TYPE … ADD VALUE` cannot run inside a transaction
block in Postgres, and it cannot be reversed — so generate the migration, read it, and expect
the new value to be permanent. Removing or renaming a value means a new type and a column
rewrite; treat it as a breaking contract change and announce it.

Keep the declarations literal, one value per line. PRD-v2 §9.4 plans to mirror this file into
both client repos by parsing it, so a clever refactor here would break that parser.
**That codegen does not exist yet** — today the clients get these values as string unions from
`openapi.json` via their own `scripts/gen-api.mjs`.

## Identity and organizations

| Enum | Values | Used by |
|---|---|---|
| `user_role` | `user`, `admin` | `users.role` |
| `organization_type` | `industry`, `ngo`, `seller` | `organizations.type` |
| `organization_status` | `pending`, `approved`, `rejected`, `suspended` | `organizations.status` |
| `org_member_role` | `owner`, `member` | `organization_members.role` |

These are four separate questions, not one role list. `requireOrgRole` reads status live on
every request, so a suspension takes effect immediately — see [`error-codes.md`](error-codes.md)
`ORG_001`–`ORG_004`. Organizations start `pending`: anyone can claim to be a corporate partner,
nobody gets a portal until a human approves it.

## Onboarding answers

All fifteen onboarding questions land on `lifestyle_profiles`, and every one of these feeds a
number in the baseline formula (PRD-v2 §3.2).

| Enum | Values | Used by |
|---|---|---|
| `diet_type` | `vegan`, `vegetarian`, `eggetarian`, `non_veg_weekly`, `non_veg_daily` | `lifestyle_profiles.diet_type` |
| `level3` | `low`, `medium`, `high` | `food_waste_level`, `water_usage_level` |
| `freq3` | `rarely`, `sometimes`, `often` | `packaged_food_freq` |
| `cooling_usage` | `none`, `fan_only`, `ac_occasional`, `ac_daily` | `cooling_usage` |
| `commute_mode` | `walk`, `cycle`, `bus`, `metro_train`, `two_wheeler`, `car`, `cab`, `auto_rickshaw`, `work_from_home` | `primary_commute_mode` |
| `vehicle_fuel` | `petrol`, `diesel`, `cng`, `electric`, `not_applicable` | `vehicle_fuel` |
| `cooking_fuel` | `lpg`, `png`, `electric_induction`, `firewood` | `cooking_fuel` |
| `waste_habit` | `segregate_and_compost`, `segregate_only`, `none` | `waste_habit` |
| `kwh_source` | `reported`, `from_bill`, `estimated` | `kwh_source` |

`kwh_source` is what lets the UI label an estimated footprint as an estimate: most people do
not know their monthly kWh, so the client offers exact kWh, the bill (divided by the region's
seeded tariff), or "I don't know".

## Daily log

| Enum | Values | Used by |
|---|---|---|
| `ac_hours_bucket` | `0`, `1_3`, `4_8`, `8_plus` | `daily_logs.ac_hours_bucket` |
| `bath_choice` | `bucket`, `short_shower`, `long_shower` | `daily_logs.bath_choice` |

`daily_logs.trips` and `daily_logs.waste_actions` are **jsonb, not enums**. A trip's `mode` is
free text, so a stored row can hold a value `commute_mode` does not have — `ride_sharing` is
the live example, and `factors.ts` already prices it. That is why the contract has a separate
`StoredDailyAnswers` for reads.

## Goals and rewards

| Enum | Values | Used by |
|---|---|---|
| `goal_type` | `reduce_percent`, `absolute_cap` | `goals.type` |
| `goal_period` | `week`, `month`, `quarter` | `goals.period` |
| `goal_status` | `active`, `achieved`, `missed`, `cancelled` | `goals.status` |
| `reward_source` | `onboarding`, `daily_log`, `streak`, `reduction`, `goal`, `event_attend`, `event_host`, `order`, `order_refund`, `admin` | `reward_transactions.source` |

`reward_source` is half of the idempotency key. Every grant is unique on
`(user_id, source, source_id)` — see `reward_idempotency_unq` — so adding a value here means
adding an earn path, and that path needs a stable `source_id` format (`goal:7`, never a random
id).

## Events and marketplace

| Enum | Values | Used by |
|---|---|---|
| `event_type` | `plant_drive`, `cleanup_drive`, `awareness`, `recycling_drive`, `workshop`, `other` | `events.type` |
| `event_status` | `draft`, `published`, `ongoing`, `completed`, `cancelled` | `events.status` |
| `event_visibility` | `public`, `invite_only` | `events.visibility` |
| `pass_status` | `registered`, `checked_in`, `cancelled`, `no_show` | `event_passes.status` |
| `product_category` | `plants`, `household`, `personal_care`, `kitchen`, `stationery` | `products.category` |
| `order_status` | `placed`, `confirmed`, `shipped`, `delivered`, `cancelled` | `orders.status` |

## Declared but not on any column

Two enums exist in `enums.ts` with no column using them. Both are live inconsistencies, not
spare parts:

| Enum | Values | Status |
|---|---|---|
| `event_role` | `host`, `co_host` | **`event_hosts.role` is `text` with a `'co_host'` default, not this enum.** The column is unconstrained — any string inserts. Worth a migration. |
| `emission_category` | `transport`, `food`, `home_energy`, `water`, `waste` | No column uses it. The same five values are hand-written as a zod enum in `src/common/openapi/shared-schemas.ts`, and as the keys of `daily_footprints.sources` (jsonb). |
