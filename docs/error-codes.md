# Error codes

Every failure response carries a stable `error.code`. **Clients branch on the code, never on
the message** — messages are user-facing copy and will be reworded and translated.

```json
{ "status": false, "data": null,
  "error": { "code": "EVENT_004", "message": "…", "details": {} } }
```

Format is `DOMAIN_NNN`. Add a row here in the same PR that introduces a code, and mirror it
into the client repos' copy of this file.

## Generic

| Code | HTTP | Meaning |
|---|---|---|
| `GEN_400` | 400 | Request failed schema validation. `details.issues` lists `{ path, message }`. |
| `GEN_404` | 404 | A resource addressed by id does not exist, or is not the caller's. |
| `GEN_429` | 429 | Rate limited. See the `Retry-After` header. |
| `GEN_500` | 500 | A server-side invariant could not be satisfied — currently only slug allocation exhausting its attempts. |
| `GEN_501` | 501 | **Never returned.** No route declares it; kept so the meaning stays reserved. |
| `HTTP_404` | 404 | No such route. |
| `DOCS_001` | 404 | `/docs` is disabled, or the token was wrong. A 404 rather than a 401, so the page's existence is not confirmed. |
| `INTERNAL_001` | 500 | Unexpected. The real error is logged server-side and never returned. |
| `HEALTH_001` | 503 | Database unreachable. |

## Auth

| Code | HTTP | Meaning |
|---|---|---|
| `AUTH_001` | 401 | Invalid credentials. Deliberately identical for unknown email and wrong password. |
| `AUTH_002` | 401 | Access token expired — refresh and retry. |
| `AUTH_003` | 401 | Refresh token invalid or replayed. The whole token family is revoked. |
| `AUTH_004` | 403 | Email not verified. **Never returned.** Earning is still gated (PRD-v2 §4.4), but the gate SKIPS the award instead of failing the request: an unverified user logs a day normally and gets `reward.pointsDelta: 0`. Refusing the core action over a bonus was the old behaviour and it was wrong. Read `user.emailVerified` to explain the zero. |
| `AUTH_005` | 409 | Email already registered. |
| `AUTH_006` | 403 | Admin only. |
| `AUTH_007` | 422 | Verification or reset link invalid, already used, or expired. |
| `AUTH_008` | 409 | Already verified — nothing to resend. |

## Onboarding

| Code | HTTP | Meaning |
|---|---|---|
| `ONB_001` | 422 | Step payload incomplete or does not match the step in the path. |
| `ONB_002` | 409 | Onboarding already complete. |
| `ONB_003` | 403 | Action requires completed onboarding (no baseline exists yet). |

## Track

| Code | HTTP | Meaning |
|---|---|---|
| `TRACK_001` | 409 | A log already exists for this date under a DIFFERENT `clientLogId` — a second device, or a reinstall that lost its offline queue. `PATCH /track/logs/{id}` instead. Replaying the SAME `clientLogId` is not this: it returns the original result with no new reward. |
| `TRACK_002` | 422 | `logDate` outside the allowed window — today or yesterday in the user's timezone. |
| `TRACK_003` | 403 | Edit window closed (after 02:00 the following day). |

## Goals

| Code | HTTP | Meaning |
|---|---|---|
| `GOAL_001` | 409 | An active goal already exists. One per user, enforced by a partial unique index. |
| `GOAL_002` | 422 | `endDate` must be after `startDate`. |
| `GOAL_003` | 422 | `reducePercent` required for `reduce_percent`; `capKgPerDay` for `absolute_cap`. |
| `GOAL_004` | 404 | No goal with that id **for this user**. A goal belonging to someone else returns this same 404, never 403.
| `GOAL_005` | 422 | `startDate` is outside the allowed window (yesterday to 14 days ahead, in the user's timezone). A goal starting in the past has already ended, and settling it would pay out immediately. |
| `GOAL_006` | 422 | The target is at or above the user's own baseline. Unlogged days are charged at baseline, so such a goal is met by doing nothing. |

## Events

| Code | HTTP | Meaning |
|---|---|---|
| `EVENT_001` | 403 | Caller is not the host or a co-host. |
| `EVENT_002` | 404 | No pass with that code for this event. |
| `EVENT_003` | 422 | Scan outside the check-in window (`start − 1h` to `end + 2h`). |
| `EVENT_004` | 200 | **Not an error.** Already checked in — returns the prior result, grants nothing. |
| `EVENT_005` | 422 | Capacity reached. |
| `EVENT_006` | 409 | **Never returned.** Registering twice is not an error: the existing pass comes back, with a freshly rotated `passCode` while it is still `registered`. |
| `EVENT_007` | 422 | Registration closed. |
| `EVENT_008` | 422 | An event must end after it starts. |
| `EVENT_009` | 404 | No such event. A **draft** returns this same 404 to anyone who is not running it, so its existence is never confirmed. |
| `EVENT_010` | 404/422 | No such user to add as co-host, or the user is already the host. |

## Marketplace

| Code | HTTP | Meaning |
|---|---|---|
| `SHOP_001` | 422 | Out of stock. `details.productId` names the line. |
| `SHOP_002` | 422 | **Never returned.** A request to spend more coins than the cap allows is CLAMPED to the cap, not refused — the server is authoritative on price and the client's number was only ever a preview. |
| `SHOP_003` | 422 | Insufficient coins. |
| `SHOP_004` | 409 | **Never returned.** A replayed `idempotencyKey` returns the original order, address included, with 201. |
| `SHOP_005` | 404 | No such product, or it is no longer active. |
| `SHOP_006` | 422 | Cart is empty. |
| `SHOP_007` | 404 | No such delivery address **for this user**. Someone else's address returns this same 404. |
| `SHOP_008` | 404 | No such order **for this user**. |

## Rewards

| Code | HTTP | Meaning |
|---|---|---|
| `POINTS_001` | 422 | Coin balance would go negative. |
| `POINTS_002` | 409 | **Never returned.** A repeated `(source, sourceId)` is a no-op at the ledger, not an error. |
| `POINTS_003` | 403 | Email not verified. **Never returned today.** `assertCanEarn` would throw it but has no call sites: every earning path goes through `award()`, which SKIPS a positive grant for an unverified user rather than failing the request. Branch on `reward.pointsDelta === 0` plus `user.emailVerified`, not on this code. |

## Organizations

Thrown by `requireOrgRole` (`src/common/guards/auth.guard.ts`). Status is read live
from the database on every request, so a suspension takes effect immediately
rather than when the caller's access token happens to expire.

| Code | HTTP | Meaning |
|---|---|---|
| `ORG_001` | 403 | Caller belongs to no organization. |
| `ORG_002` | 403 | The organization is not `approved`. `details.status` carries `pending`, `rejected` or `suspended`. |
| `ORG_003` | 403 | Wrong organization type for this action. |
| `ORG_004` | 403 | Organization owner only. |
| `ORG_005` | 409 | Already belongs to an organization. Enforced by `one_org_per_user`; relaxing the rule is `DROP INDEX`. |
| `ORG_006` | 409 | An organization with that name already exists (`orgs_name_lower_unq`). |
| `ORG_007` | 404 | No such organization. |
| `ORG_008` | 404 | No account with that email, or that person is not a member. Both answer the same so the endpoint cannot be used to test whether an address is registered. |
| `ORG_009` | 422 | An organization must keep at least one owner. Removing the last one leaves it unadministrable. |
| `ORG_010` | 422 | A rejection or suspension requires a note. |
| `ORG_011` | 422 | Use `DELETE /organizations/me/membership` to remove yourself. |
| `ORG_012` | 409 | The organization's identity (name, logo or website) changed between opening the review queue and deciding. `details.expected` / `details.actual`. Re-read it before approving. |

## Uploads

| Code | HTTP | Meaning |
|---|---|---|
| `UPLOAD_001` | 400 | Unsupported `purpose` or `contentType`. |
| `UPLOAD_002` | 503 | Object storage is not configured on this server (`S3_BUCKET` / `AWS_ENDPOINT_URL_S3` unset). Every other endpoint still works. |

## Reference and notifications

| Code | HTTP | Meaning |
|---|---|---|
| `NOTIF_001` | 404 | No such notification **for this user**. A notification belonging to someone else returns this same 404, never 403 — a 403 would confirm the id exists. |

## Gamification

| Code | HTTP | Meaning |
|---|---|---|
| `GAME_001` | 404 | No tree in the catalogue with that slug. A **disabled** tree answers this too: it is retired, not deleted, and still sits in the forests of everyone who owns one. |

A `?rarity=` filter naming an unknown rarity slug is **not** an error — it returns an empty page.
A stale client filter should not read as a broken catalogue.
