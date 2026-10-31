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

## Marketplace

| Code | HTTP | Meaning |
|---|---|---|
| `SHOP_001` | 422 | Out of stock. `details.productId` names the line. |
| `SHOP_002` | 422 | Discount would exceed the 20% cap. |
| `SHOP_003` | 422 | Insufficient coins. |
| `SHOP_004` | 409 | Duplicate order — same `idempotencyKey`. The original order is returned. |

## Rewards

| Code | HTTP | Meaning |
|---|---|---|
| `POINTS_001` | 422 | Coin balance would go negative. |
| `POINTS_002` | 409 | Reward already granted for this `(source, sourceId)`. Treated as a no-op, not an error. |
