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
| `GEN_429` | 429 | Rate limited. See the `Retry-After` header. |
| `GEN_501` | 501 | Endpoint declared in the contract but not implemented yet. |
| `HTTP_404` | 404 | No such route. |
| `INTERNAL_001` | 500 | Unexpected. The real error is logged server-side and never returned. |
| `HEALTH_001` | 503 | Database unreachable. |

## Auth

| Code | HTTP | Meaning |
|---|---|---|
| `AUTH_001` | 401 | Invalid credentials. Deliberately identical for unknown email and wrong password. |
| `AUTH_002` | 401 | Access token expired — refresh and retry. |
| `AUTH_003` | 401 | Refresh token invalid or replayed. The whole token family is revoked. |
| `AUTH_004` | 403 | Email not verified. Browsing is allowed; **earning is blocked**. |
| `AUTH_005` | 409 | Email already registered. |

## Onboarding

| Code | HTTP | Meaning |
|---|---|---|
| `ONB_001` | 422 | Step payload incomplete or does not match the step in the path. |
| `ONB_002` | 409 | Onboarding already complete. |
| `ONB_003` | 403 | Action requires completed onboarding (no baseline exists yet). |

## Track

| Code | HTTP | Meaning |
|---|---|---|
| `TRACK_001` | 409 | A log already exists for this date. Use `PATCH`. |
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
| `EVENT_006` | 409 | Already registered. The existing pass is returned instead. |
| `EVENT_007` | 422 | Registration closed. |
| `EVENT_008` | 422 | An event must end after it starts. |
| `EVENT_009` | 404 | No such event. A **draft** returns this same 404 to anyone who is not running it, so its existence is never confirmed. |
| `EVENT_010` | 404/422 | No such user to add as co-host, or the user is already the host. |

## Marketplace

| Code | HTTP | Meaning |
|---|---|---|
| `SHOP_001` | 422 | Out of stock. `details.productId` names the line. |
| `SHOP_002` | 422 | Discount would exceed the 20% cap. |
| `SHOP_003` | 422 | Insufficient coins. |
| `SHOP_004` | 409 | Duplicate order — same `idempotencyKey`. The original order is returned. |
| `SHOP_005` | 404 | No such product, or it is no longer active. |
| `SHOP_006` | 422 | Cart is empty. |
| `SHOP_007` | 404 | No such delivery address **for this user**. Someone else's address returns this same 404. |
| `SHOP_008` | 404 | No such order **for this user**. |

## Rewards

| Code | HTTP | Meaning |
|---|---|---|
| `POINTS_001` | 422 | Coin balance would go negative. |
| `POINTS_002` | 409 | Reward already granted for this `(source, sourceId)`. Treated as a no-op, not an error. |
| `POINTS_003` | 403 | Email not verified. Verification gates **earning**, not browsing or logging (PRD-v2 §4.4). |

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

## Uploads

| Code | HTTP | Meaning |
|---|---|---|
| `UPLOAD_001` | 400 | Unsupported `purpose` or `contentType`. |
| `UPLOAD_002` | 503 | Object storage is not configured on this server (`S3_BUCKET` / `AWS_ENDPOINT_URL_S3` unset). Every other endpoint still works. |

## Reference and notifications

| Code | HTTP | Meaning |
|---|---|---|
| `NOTIF_001` | 404 | No such notification **for this user**. A notification belonging to someone else returns this same 404, never 403 — a 403 would confirm the id exists. |
