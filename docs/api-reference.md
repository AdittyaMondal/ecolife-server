# EcoLife API reference

> **Generated from `openapi.json` — do not edit by hand.**
> Run `pnpm gen:apidocs` after any contract change. `pnpm gen:apidocs -- --check`
> fails CI when this file is stale.

**Version** 0.1.0 · **Base path** `/api/v1` · **93 paths** · **116 operations** · **132 schemas**

---

## Before you read this

**Every endpoint below is implemented.** All 116 operations run against the real
database; none returns `GEN_501` any more. Point your client at the server, not
at the mock — the mock serves the *examples* in this document, so it will happily
return a plausible shape for a request the real server would reject.

```bash
cd ecolife-server && pnpm dev       # :4000, the real thing
pnpm mock                           # :4010, examples only — shapes, not behaviour
```

Point a client at one or the other with a single env var — `NEXT_PUBLIC_API_URL`
on web, `EXPO_PUBLIC_API_URL` on mobile. No code change.

The mock remains useful for one thing: building a screen before the endpoint it
needs exists. That is no longer the case for anything in this document.

### The envelope

Every response, success or failure, uses one shape:

```json
{ "status": true,  "data": { }, "error": null }
{ "status": false, "data": null, "error": { "code": "GOAL_001", "message": "…", "details": {} } }
```

The tables below describe the **`data`** payload. `status` and `error` are always present.

**Branch on `error.code`, never on `error.message`.** Messages are user-facing copy and
will be reworded and translated; codes are stable. The registry is
[`docs/error-codes.md`](./error-codes.md).

### Auth

Endpoints marked 🔒 require `Authorization: Bearer <accessToken>`. The access token is a
15-minute JWT from `POST /auth/login`; refresh rotates it. Web keeps the refresh token in
an httpOnly cookie, mobile in `expo-secure-store`, and `POST /auth/refresh` accepts either.

### Conventions

- All money is an integer in **paise**. No float ever touches a price.
- All emissions are **kg CO₂e**, `double precision`.
- Dates are `YYYY-MM-DD` and mean the **user's local date**, resolved from their timezone.
- Timestamps are ISO 8601 UTC.
- Lists are **keyset paginated**: `?cursor=&limit=` in, `{ items, pageInfo }` out.
- Mutations accept an `Idempotency-Key` header; some take an explicit idempotency field.

---

## Contents

- [health](#health) — 2 operations
- [auth](#auth) — 10 operations
- [profile](#profile) — 9 operations
- [home](#home) — 1 operation
- [track](#track) — 4 operations
- [goals](#goals) — 5 operations
- [garden](#garden) — 2 operations
- [gamification](#gamification) — 3 operations
- [leaderboard](#leaderboard) — 2 operations
- [marketplace](#marketplace) — 14 operations
- [seller](#seller) — 8 operations
- [events](#events) — 14 operations
- [organizations](#organizations) — 22 operations
- [admin-revenue](#admin-revenue) — 9 operations
- [notifications](#notifications) — 6 operations
- [reference](#reference) — 3 operations
- [carbon](#carbon) — 1 operation
- [ai](#ai) — 1 operation
- [Schemas](#schemas)

---

## health

| | Endpoint | Summary |
|---|---|---|
| `GET` | [`/api/v1/health`](#get-api-v1-health)  | Liveness probe |
| `GET` | [`/api/v1/health/ready`](#get-api-v1-health-ready)  | Readiness probe — verifies the database is reachable |

### `GET` `/api/v1/health`

**Liveness probe**

🔓 No authentication.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Service is up | [`Liveness`](#liveness) |

### `GET` `/api/v1/health/ready`

**Readiness probe — verifies the database is reachable**

🔓 No authentication.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Database reachable | [`Readiness`](#readiness) |
| `503` | Database unreachable | null |

---

## auth

| | Endpoint | Summary |
|---|---|---|
| `POST` | [`/api/v1/auth/forgot-password`](#post-api-v1-auth-forgot-password)  | Request a password reset link |
| `POST` | [`/api/v1/auth/google`](#post-api-v1-auth-google)  | Sign in with Google |
| `POST` | [`/api/v1/auth/login`](#post-api-v1-auth-login)  | Exchange credentials for a session |
| `POST` | [`/api/v1/auth/logout`](#post-api-v1-auth-logout) 🔒 | Revoke the current session family |
| `GET` | [`/api/v1/auth/me`](#get-api-v1-auth-me) 🔒 | Current user, onboarding state and wallet |
| `POST` | [`/api/v1/auth/refresh`](#post-api-v1-auth-refresh)  | Rotate the refresh token |
| `POST` | [`/api/v1/auth/register`](#post-api-v1-auth-register)  | Create an account and start a session |
| `POST` | [`/api/v1/auth/resend-verification`](#post-api-v1-auth-resend-verification) 🔒 | Resend the verification email |
| `POST` | [`/api/v1/auth/reset-password`](#post-api-v1-auth-reset-password)  | Set a new password from a reset token |
| `POST` | [`/api/v1/auth/verify-email`](#post-api-v1-auth-verify-email)  | Consume an email verification token |

### `POST` `/api/v1/auth/forgot-password`

**Request a password reset link**

🔓 No authentication.

Always 200, whether or not the address exists — it must not leak registration.

**Request body** (required) — [`ForgotPasswordBody`](#forgotpasswordbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `email` | string (email) | yes | e.g. `"yusuf@example.com"` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Accepted | [`OkMessage`](#okmessage) |
| `429` | Rate limited — see Retry-After | null |

### `POST` `/api/v1/auth/google`

**Sign in with Google**

🔓 No authentication.

Send the Google ACCESS token obtained natively. The server verifies it with Google and pins the token audience to GOOGLE_OAUTH_CLIENT_IDS before trusting the email, so a token minted by another app is refused. Matches on the verified, lowercased email: an existing account is signed in (and its email marked verified if it was not), otherwise one is created with no usable password — set one later via forgot-password. Session delivery is identical to /auth/login: send `x-ecolife-platform: ios|android` for `session.refreshToken` in the body, otherwise it is an httpOnly cookie.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `x-ecolife-platform` | header | no | `ios` \| `android` \| `web` | e.g. `"android"` |

**Request body** (required) — [`GoogleSignInBody`](#googlesigninbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `accessToken` | string | yes | Google OAuth access token. e.g. `"ya29.a0AfB_byC..."` |
| `timezone` | string | no | e.g. `"Asia/Kolkata"`. default `"Asia/Kolkata"` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Signed in | [`AuthResult`](#authresult) |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |
| `429` | Rate limited — see Retry-After | null |

### `POST` `/api/v1/auth/login`

**Exchange credentials for a session**

🔓 No authentication.

Failures are deliberately indistinguishable between unknown and wrong-password. Send `x-ecolife-platform: ios|android` to get `session.refreshToken` in the body.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `x-ecolife-platform` | header | no | `ios` \| `android` \| `web` | e.g. `"android"` |

**Request body** (required) — [`LoginBody`](#loginbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `email` | string (email) | yes | e.g. `"yusuf@example.com"` |
| `password` | string | yes |  |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Signed in | [`AuthResult`](#authresult) |
| `401` | Not authenticated | null |
| `429` | Rate limited — see Retry-After | null |

### `POST` `/api/v1/auth/logout`

**Revoke the current session family**

🔒 Requires a bearer token.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Signed out | [`OkMessage`](#okmessage) |
| `401` | Not authenticated | null |

### `GET` `/api/v1/auth/me`

**Current user, onboarding state and wallet**

🔒 Requires a bearer token.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | The authenticated user | [`Me`](#me) |
| `401` | Not authenticated | null |

### `POST` `/api/v1/auth/refresh`

**Rotate the refresh token**

🔓 No authentication.

Accepts the token from the httpOnly cookie (web) or the body (mobile). Rotates on every use; a replayed token revokes the whole family. A 409 (AUTH_009) means another context refreshed the same token moments ago — the session is alive, so RETRY rather than signing the user out. Two browser tabs reach this routinely.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `x-ecolife-platform` | header | no | `ios` \| `android` \| `web` | e.g. `"android"` |

**Request body** — [`RefreshBody`](#refreshbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `refreshToken` | string | no | Mobile sends this. Web sends the httpOnly cookie instead. |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Rotated | [`Session`](#session) |
| `401` | Not authenticated | null |
| `409` | Conflict | null |

### `POST` `/api/v1/auth/register`

**Create an account and start a session**

🔓 No authentication.

Rate limited to 10 per 15 minutes per IP and per email. Email verification is required before any reward can be earned (PRD-v2 §4.4). Send `x-ecolife-platform: ios|android` to get `session.refreshToken` in the body; without it you are treated as a browser and the token is set as an httpOnly cookie with the body field null.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `x-ecolife-platform` | header | no | `ios` \| `android` \| `web` | e.g. `"android"` |

**Request body** (required) — [`RegisterBody`](#registerbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | e.g. `"Yusuf"` |
| `email` | string (email) | yes | e.g. `"yusuf@example.com"` |
| `password` | string | yes | e.g. `"correct horse battery"` |
| `phone` | string | no | e.g. `"+919876543210"` |
| `timezone` | string | no | e.g. `"Asia/Kolkata"`. default `"Asia/Kolkata"` |
| `organizationCode` | string | no | Optional 6-digit organization code to link user upon signup. e.g. `"482910"` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `201` | Account created | [`AuthResult`](#authresult) |
| `400` | Validation failed | null |
| `403` | Not authorised | null |
| `404` | Not found | null |
| `409` | Conflict | null |
| `429` | Rate limited — see Retry-After | null |

### `POST` `/api/v1/auth/resend-verification`

**Resend the verification email**

🔒 Requires a bearer token.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Sent | [`OkMessage`](#okmessage) |
| `429` | Rate limited — see Retry-After | null |

### `POST` `/api/v1/auth/reset-password`

**Set a new password from a reset token**

🔓 No authentication.

Revokes every existing session for the user on success.

**Request body** (required) — [`ResetPasswordBody`](#resetpasswordbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `token` | string | yes |  |
| `password` | string | yes | e.g. `"correct horse battery"` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Password changed | [`OkMessage`](#okmessage) |
| `422` | Domain rule violation | null |

### `POST` `/api/v1/auth/verify-email`

**Consume an email verification token**

🔓 No authentication.

**Request body** (required) — [`VerifyEmailBody`](#verifyemailbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `token` | string | yes | e.g. `"a1b2c3…"` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Verified | [`OkMessage`](#okmessage) |
| `422` | Domain rule violation | null |

---

## profile

| | Endpoint | Summary |
|---|---|---|
| `DELETE` | [`/api/v1/profile`](#delete-api-v1-profile) 🔒 | Delete account |
| `GET` | [`/api/v1/profile`](#get-api-v1-profile) 🔒 | Own profile |
| `PATCH` | [`/api/v1/profile`](#patch-api-v1-profile) 🔒 | Edit lifestyle answers or settings |
| `GET` | [`/api/v1/profile/export`](#get-api-v1-profile-export) 🔒 | Full data export |
| `GET` | [`/api/v1/profile/onboarding`](#get-api-v1-profile-onboarding) 🔒 | Partial onboarding answers, for resuming |
| `POST` | [`/api/v1/profile/onboarding/complete`](#post-api-v1-profile-onboarding-complete) 🔒 | Validate all 15 answers, compute the baseline, award the completion reward |
| `PATCH` | [`/api/v1/profile/onboarding/step/{n}`](#patch-api-v1-profile-onboarding-step-n) 🔒 | Persist one wizard step (1–5) |
| `GET` | [`/api/v1/profile/rewards`](#get-api-v1-profile-rewards) 🔒 | Points and coins ledger |
| `GET` | [`/api/v1/users/{id}`](#get-api-v1-users-id) 🔒 | Another user's public profile |

### `DELETE` `/api/v1/profile`

**Delete account**

🔒 Requires a bearer token.

Soft-deletes, anonymises PII, and hard-deletes uploads within 30 days.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Scheduled for deletion | object |
| `401` | Not authenticated | null |

### `GET` `/api/v1/profile`

**Own profile**

🔒 Requires a bearer token.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Own profile | [`OwnProfile`](#ownprofile) |
| `401` | Not authenticated | null |

### `PATCH` `/api/v1/profile`

**Edit lifestyle answers or settings**

🔒 Requires a bearer token.

Recomputes the baseline forward only. Past daily_footprints rows carry their own baseline snapshot, so history never changes retroactively (PRD-v2 §3.3).

**Request body** — [`ProfilePatchBody`](#profilepatchbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `timezone` | string | no | e.g. `"Asia/Kolkata"` |
| `avatarUrl` | string,null (uri) | no | Any https URL the caller controls, or one returned by POST /uploads/presign.. e.g. `"https://images.unsplash.com/photo-1607346256330-dee7af15f7c5?auto=format&fit=facearea&facepad=3&w=256&h=256&q=70"` |
| `answers` | [`OnboardingAnswers`](#onboardinganswers) | no |  |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Updated | [`OwnProfile`](#ownprofile) |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |

### `GET` `/api/v1/profile/export`

**Full data export**

🔒 Requires a bearer token.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Everything we hold | [`DataExport`](#dataexport) |
| `401` | Not authenticated | null |

### `GET` `/api/v1/profile/onboarding`

**Partial onboarding answers, for resuming**

🔒 Requires a bearer token.

Any device resumes where another left off — the wizard is server-persisted.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Current onboarding state | [`OnboardingState`](#onboardingstate) |
| `401` | Not authenticated | null |

### `POST` `/api/v1/profile/onboarding/complete`

**Validate all 15 answers, compute the baseline, award the completion reward**

🔒 Requires a bearer token.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Baseline computed | [`OnboardingCompleteResult`](#onboardingcompleteresult) |
| `401` | Not authenticated | null |
| `409` | Conflict | null |
| `422` | Domain rule violation | null |

### `PATCH` `/api/v1/profile/onboarding/step/{n}`

**Persist one wizard step (1–5)**

🔒 Requires a bearer token.

Each step is its own request so a dropped connection never loses the whole form. v1 kept all 32 inputs in one DOM form and persisted nothing until final submit.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `n` | path | yes | integer | e.g. `3` |

**Request body** (required) — [`OnboardingStepBody`](#onboardingstepbody)

_See the schema._

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Step saved | [`OnboardingState`](#onboardingstate) |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |

### `GET` `/api/v1/profile/rewards`

**Points and coins ledger**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `cursor` | query | no | string |  |
| `limit` | query | no | integer | e.g. `20`. default `20` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Ledger page | object |
| `401` | Not authenticated | null |

### `GET` `/api/v1/users/{id}`

**Another user's public profile**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Public profile | [`PublicProfile`](#publicprofile) |
| `404` | Not found | null |

---

## home

| | Endpoint | Summary |
|---|---|---|
| `GET` | [`/api/v1/home`](#get-api-v1-home) 🔒 | The entire Home screen in one request |

### `GET` `/api/v1/home`

**The entire Home screen in one request**

🔒 Requires a bearer token.

Budget: under 250 ms p95. One round trip, one payload, no client-side fan-out.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Home payload | [`Home`](#home) |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |

---

## track

| | Endpoint | Summary |
|---|---|---|
| `GET` | [`/api/v1/track/history`](#get-api-v1-track-history) 🔒 | Footprint time series |
| `POST` | [`/api/v1/track/logs`](#post-api-v1-track-logs) 🔒 | Submit the daily log — the core loop |
| `PATCH` | [`/api/v1/track/logs/{id}`](#patch-api-v1-track-logs-id) 🔒 | Edit a log until 02:00 the next day |
| `GET` | [`/api/v1/track/today`](#get-api-v1-track-today) 🔒 | Today's log if it exists, plus the question set and prefill defaults |

### `GET` `/api/v1/track/history`

**Footprint time series**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `from` | query | yes | string | e.g. `"2026-10-01"` |
| `to` | query | yes | string | e.g. `"2026-10-31"` |
| `granularity` | query | no | `day` \| `week` \| `month` | default `"day"` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Series | object |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |

### `POST` `/api/v1/track/logs`

**Submit the daily log — the core loop**

🔒 Requires a bearer token.

One transaction: validate, compute 5 categories, upsert the footprint, update the streak, evaluate the active goal, award rewards. Idempotent on (user, clientLogId), so an offline queue can replay safely. The response carries everything the result sheet needs — no refetch required. Replaying the SAME clientLogId returns the first result and awards nothing twice; a DIFFERENT clientLogId for a date that is already logged is TRACK_001 (409) — edit that log instead.

**Request body** (required) — [`SubmitLogBody`](#submitlogbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `clientLogId` | string (uuid) | yes | e.g. `"0193f0a2-7c31-7b4e-9a51-6b2e0f3c4d55"` |
| `logDate` | string | yes | The user's LOCAL date. Must be today or yesterday in their timezone.. e.g. `"2026-10-31"` |
| `answers` | [`DailyAnswers`](#dailyanswers) | yes |  |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Footprint computed and rewards granted | [`LogResult`](#logresult) |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |
| `409` | Conflict | null |
| `422` | Domain rule violation | null |
| `429` | Rate limited — see Retry-After | null |

### `PATCH` `/api/v1/track/logs/{id}`

**Edit a log until 02:00 the next day**

🔒 Requires a bearer token.

The reduction bonus is computed once, on first submit, and is NOT re-granted on edit.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Request body** (required)

| Field | Type | Required | Notes |
|---|---|---|---|
| `answers` | [`DailyAnswers`](#dailyanswers) | yes |  |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Recomputed | [`LogResult`](#logresult) |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |
| `404` | Not found | null |

### `GET` `/api/v1/track/today`

**Today's log if it exists, plus the question set and prefill defaults**

🔒 Requires a bearer token.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Today's state | [`TrackToday`](#tracktoday) |
| `401` | Not authenticated | null |

---

## goals

| | Endpoint | Summary |
|---|---|---|
| `GET` | [`/api/v1/goals`](#get-api-v1-goals) 🔒 | Active goal and settled history |
| `POST` | [`/api/v1/goals`](#post-api-v1-goals) 🔒 | Create a goal, freezing its target |
| `DELETE` | [`/api/v1/goals/{id}`](#delete-api-v1-goals-id) 🔒 | Cancel a goal |
| `PATCH` | [`/api/v1/goals/{id}`](#patch-api-v1-goals-id) 🔒 | Edit an active goal |
| `GET` | [`/api/v1/goals/{id}/progress`](#get-api-v1-goals-id-progress) 🔒 | Actual vs frozen target, with a projection |

### `GET` `/api/v1/goals`

**Active goal and settled history**

🔒 Requires a bearer token.

Goals are never deleted — they settle to achieved or missed and stay visible.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Goals | [`GoalsList`](#goalslist) |
| `401` | Not authenticated | null |

### `POST` `/api/v1/goals`

**Create a goal, freezing its target**

🔒 Requires a bearer token.

409 when an active goal already exists — one per user, enforced by the database.

**Request body** (required) — [`CreateGoalBody`](#creategoalbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `reduce_percent` \| `absolute_cap` | yes | e.g. `"reduce_percent"` |
| `period` | `week` \| `month` \| `quarter` | yes | e.g. `"month"` |
| `reducePercent` | number | no | Required when type is reduce_percent. e.g. `15`. range 1…90 |
| `capKgPerDay` | number | no | Required when type is absolute_cap. range 0.5…100 |
| `startDate` | string | yes | e.g. `"2026-11-01"` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `201` | Created | [`Goal`](#goal) |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |
| `409` | Conflict | null |
| `422` | Domain rule violation | null |

### `DELETE` `/api/v1/goals/{id}`

**Cancel a goal**

🔒 Requires a bearer token.

Sets status to 'cancelled'. The row is kept.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Cancelled | [`Goal`](#goal) |
| `401` | Not authenticated | null |
| `404` | Not found | null |

### `PATCH` `/api/v1/goals/{id}`

**Edit an active goal**

🔒 Requires a bearer token.

Recomputes and re-freezes the target.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `reduce_percent` \| `absolute_cap` | no | e.g. `"reduce_percent"` |
| `period` | `week` \| `month` \| `quarter` | no | e.g. `"month"` |
| `reducePercent` | number | no | Required when type is reduce_percent. e.g. `15`. range 1…90 |
| `capKgPerDay` | number | no | Required when type is absolute_cap. range 0.5…100 |
| `startDate` | string | no | e.g. `"2026-11-01"` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Updated | [`Goal`](#goal) |
| `401` | Not authenticated | null |
| `404` | Not found | null |
| `422` | Domain rule violation | null |

### `GET` `/api/v1/goals/{id}/progress`

**Actual vs frozen target, with a projection**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Progress | [`GoalProgress`](#goalprogress) |
| `401` | Not authenticated | null |
| `404` | Not found | null |

---

## garden

| | Endpoint | Summary |
|---|---|---|
| `GET` | [`/api/v1/garden`](#get-api-v1-garden) 🔒 | Get user's saved garden arrangement and layout from DB |
| `PUT` | [`/api/v1/garden`](#put-api-v1-garden) 🔒 | Save user's garden arrangement and layout to DB |

### `GET` `/api/v1/garden`

**Get user's saved garden arrangement and layout from DB**

🔒 Requires a bearer token.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | User garden state | object |

### `PUT` `/api/v1/garden`

**Save user's garden arrangement and layout to DB**

🔒 Requires a bearer token.

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `gardenState` | object | yes |  |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Garden saved successfully | object |

---

## gamification

| | Endpoint | Summary |
|---|---|---|
| `GET` | [`/api/v1/trees`](#get-api-v1-trees)  | The tree catalogue — public |
| `GET` | [`/api/v1/trees/{slug}`](#get-api-v1-trees-slug)  | One catalogue entry — public |
| `GET` | [`/api/v1/trees/rarities`](#get-api-v1-trees-rarities)  | Rarity tiers and their drop weights — public |

### `GET` `/api/v1/trees`

**The tree catalogue — public**

🔓 No authentication.

Every tree a user can be rewarded with. `rarity` filters by rarity slug; an unknown slug is an empty page rather than a 404, so a stale filter does not look like an outage.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `rarity` | query | no | string | e.g. `"rare"` |
| `cursor` | query | no | string |  |
| `limit` | query | no | integer | e.g. `20`. default `20` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Catalogue, newest first | object |
| `400` | Validation failed | null |

### `GET` `/api/v1/trees/{slug}`

**One catalogue entry — public**

🔓 No authentication.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `slug` | path | yes | string | e.g. `"neem"` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Tree | [`Tree`](#tree) |
| `404` | Not found | null |

### `GET` `/api/v1/trees/rarities`

**Rarity tiers and their drop weights — public**

🔓 No authentication.

Weights are relative, not percentages: divide one by the sum of the active tiers. Published deliberately — the roll is server-side, so the odds cost nothing to disclose.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Rarity tiers, rarest last | object |

---

## leaderboard

| | Endpoint | Summary |
|---|---|---|
| `GET` | [`/api/v1/leaderboard`](#get-api-v1-leaderboard) 🔒 | Points ranking |
| `GET` | [`/api/v1/leaderboard/me`](#get-api-v1-leaderboard-me) 🔒 | Own rank, without paging to it |

### `GET` `/api/v1/leaderboard`

**Points ranking**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `period` | query | no | `all` \| `month` \| `week` | default `"all"` |
| `scope` | query | no | `global` \| `city` | default `"global"` |
| `cursor` | query | no | string |  |
| `limit` | query | no | integer | default `20` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Ranked page | object |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |

### `GET` `/api/v1/leaderboard/me`

**Own rank, without paging to it**

🔒 Requires a bearer token.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Own rank | [`MyRank`](#myrank) |
| `401` | Not authenticated | null |

---

## marketplace

| | Endpoint | Summary |
|---|---|---|
| `GET` | [`/api/v1/addresses`](#get-api-v1-addresses) 🔒 | Own delivery addresses |
| `POST` | [`/api/v1/addresses`](#post-api-v1-addresses) 🔒 | Add an address |
| `DELETE` | [`/api/v1/addresses/{id}`](#delete-api-v1-addresses-id) 🔒 | Delete an address |
| `PATCH` | [`/api/v1/addresses/{id}`](#patch-api-v1-addresses-id) 🔒 | Edit an address |
| `GET` | [`/api/v1/marketplace/cart`](#get-api-v1-marketplace-cart) 🔒 | Current cart, priced with zero coins applied |
| `POST` | [`/api/v1/marketplace/cart/items`](#post-api-v1-marketplace-cart-items) 🔒 | Add an item to the cart |
| `DELETE` | [`/api/v1/marketplace/cart/items/{id}`](#delete-api-v1-marketplace-cart-items-id) 🔒 | Remove a line |
| `PATCH` | [`/api/v1/marketplace/cart/items/{id}`](#patch-api-v1-marketplace-cart-items-id) 🔒 | Change a line quantity (id is the product id) |
| `POST` | [`/api/v1/marketplace/cart/preview`](#post-api-v1-marketplace-cart-preview) 🔒 | Server-priced quote for a coin offer |
| `GET` | [`/api/v1/marketplace/orders`](#get-api-v1-marketplace-orders) 🔒 | Own orders |
| `POST` | [`/api/v1/marketplace/orders`](#post-api-v1-marketplace-orders) 🔒 | Place an order |
| `GET` | [`/api/v1/marketplace/orders/{id}`](#get-api-v1-marketplace-orders-id) 🔒 | Order detail |
| `GET` | [`/api/v1/marketplace/products`](#get-api-v1-marketplace-products) 🔒 | Browse eco products |
| `GET` | [`/api/v1/marketplace/products/{slug}`](#get-api-v1-marketplace-products-slug) 🔒 | Product detail |

### `GET` `/api/v1/addresses`

**Own delivery addresses**

🔒 Requires a bearer token.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Addresses | object |
| `401` | Not authenticated | null |

### `POST` `/api/v1/addresses`

**Add an address**

🔒 Requires a bearer token.

**Request body** (required) — [`AddressBody`](#addressbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | e.g. `"Adittya"` |
| `phone` | string | yes | e.g. `"+919876543210"` |
| `line1` | string | yes | e.g. `"12 Hill Road"` |
| `line2` | string,null | no |  |
| `city` | string | yes | e.g. `"Mumbai"` |
| `state` | string | yes | e.g. `"Maharashtra"` |
| `pincode` | string | yes | e.g. `"400050"` |
| `isDefault` | boolean | yes | e.g. `true` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `201` | Created | [`Address`](#address) |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |

### `DELETE` `/api/v1/addresses/{id}`

**Delete an address**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Deleted | object |
| `401` | Not authenticated | null |
| `404` | Not found | null |

### `PATCH` `/api/v1/addresses/{id}`

**Edit an address**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no | e.g. `"Adittya"` |
| `phone` | string | no | e.g. `"+919876543210"` |
| `line1` | string | no | e.g. `"12 Hill Road"` |
| `line2` | string,null | no |  |
| `city` | string | no | e.g. `"Mumbai"` |
| `state` | string | no | e.g. `"Maharashtra"` |
| `pincode` | string | no | e.g. `"400050"` |
| `isDefault` | boolean | no | e.g. `true` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Updated | [`Address`](#address) |
| `401` | Not authenticated | null |
| `404` | Not found | null |

### `GET` `/api/v1/marketplace/cart`

**Current cart, priced with zero coins applied**

🔒 Requires a bearer token.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Cart | [`CartQuote`](#cartquote) |
| `401` | Not authenticated | null |

### `POST` `/api/v1/marketplace/cart/items`

**Add an item to the cart**

🔒 Requires a bearer token.

**Request body** (required) — [`AddCartItemBody`](#addcartitembody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `productId` | integer | yes | e.g. `12` |
| `quantity` | integer | no | e.g. `1`. range 1…20. default `1` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Cart | [`CartQuote`](#cartquote) |
| `401` | Not authenticated | null |
| `404` | Not found | null |
| `422` | Domain rule violation | null |

### `DELETE` `/api/v1/marketplace/cart/items/{id}`

**Remove a line**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Cart | [`CartQuote`](#cartquote) |
| `401` | Not authenticated | null |

### `PATCH` `/api/v1/marketplace/cart/items/{id}`

**Change a line quantity (id is the product id)**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Request body** (required)

| Field | Type | Required | Notes |
|---|---|---|---|
| `quantity` | integer | yes | range 0…20 |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Cart | [`CartQuote`](#cartquote) |
| `401` | Not authenticated | null |
| `404` | Not found | null |

### `POST` `/api/v1/marketplace/cart/preview`

**Server-priced quote for a coin offer**

🔒 Requires a bearer token.

Drives the coin slider. discount = min(offered/10 x 100, 20% of subtotal, wallet). The client never computes the price it pays.

**Request body** (required) — [`CartPreviewBody`](#cartpreviewbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `offeredCoins` | integer | yes | e.g. `2000`. range 0…∞ |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Quote | [`CartQuote`](#cartquote) |
| `401` | Not authenticated | null |
| `422` | Domain rule violation | null |

### `GET` `/api/v1/marketplace/orders`

**Own orders**

🔒 Requires a bearer token.

Each row carries its full `address`, so a list does not have to be followed by one GET per order to render a delivery line.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `cursor` | query | no | string |  |
| `limit` | query | no | integer | e.g. `20`. default `20` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Orders | object |
| `401` | Not authenticated | null |

### `POST` `/api/v1/marketplace/orders`

**Place an order**

🔒 Requires a bearer token.

One transaction: decrement stock, insert the order with price snapshots, debit coins through the ledger. Replaying the same idempotencyKey returns the original order rather than charging twice — and returns it with its `address`, exactly as the first call did.

THERE IS NO PAYMENT STEP, and this is the design, not an omission: PRD-v2 §6.5 says "No real-money payment in v2". Coins buy a DISCOUNT (capped at MAX_DISCOUNT_PCT of the subtotal); the remaining `totalPaise` is settled offline and fulfilment is manual. The order therefore goes straight to `placed` with no payment-method field, no gateway redirect and no webhook to wait for. Clients should present it as "order placed, pay on delivery", never as "paid".

**Request body** (required) — [`PlaceOrderBody`](#placeorderbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `offeredCoins` | integer | yes | e.g. `480`. range 0…∞ |
| `addressId` | integer | yes | e.g. `2` |
| `idempotencyKey` | string (uuid) | yes | e.g. `"0193f0b1-55aa-7c3d-8e21-9f0a1b2c3d4e"` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `201` | Order placed | [`Order`](#order) |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |
| `409` | Conflict | null |
| `422` | Domain rule violation | null |
| `429` | Rate limited — see Retry-After | null |

### `GET` `/api/v1/marketplace/orders/{id}`

**Order detail**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Order | [`Order`](#order) |
| `401` | Not authenticated | null |
| `404` | Not found | null |

### `GET` `/api/v1/marketplace/products`

**Browse eco products**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `category` | query | no | `plants` \| `household` \| `personal_care` \| `kitchen` \| `stationery` | e.g. `"plants"` |
| `q` | query | no | string |  |
| `sort` | query | no | `newest` \| `price_asc` \| `price_desc` \| `co2_desc` | default `"newest"` |
| `cursor` | query | no | string |  |
| `limit` | query | no | integer | default `20` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Products | object |
| `401` | Not authenticated | null |

### `GET` `/api/v1/marketplace/products/{slug}`

**Product detail**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `slug` | path | yes | string | e.g. `"tulsi-sapling"` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Product | [`Product`](#product) |
| `404` | Not found | null |

---

## seller

| | Endpoint | Summary |
|---|---|---|
| `GET` | [`/api/v1/seller/analytics`](#get-api-v1-seller-analytics) 🔒 | Seller sales and earnings reports |
| `GET` | [`/api/v1/seller/orders`](#get-api-v1-seller-orders) 🔒 | List orders containing seller items |
| `PATCH` | [`/api/v1/seller/orders/{id}/status`](#patch-api-v1-seller-orders-id-status) 🔒 | Update fulfillment status of an order |
| `GET` | [`/api/v1/seller/products`](#get-api-v1-seller-products) 🔒 | List own products |
| `POST` | [`/api/v1/seller/products`](#post-api-v1-seller-products) 🔒 | Create a product |
| `DELETE` | [`/api/v1/seller/products/{id}`](#delete-api-v1-seller-products-id) 🔒 | Delete or deactivate product |
| `GET` | [`/api/v1/seller/products/{id}`](#get-api-v1-seller-products-id) 🔒 | Get seller product detail |
| `PATCH` | [`/api/v1/seller/products/{id}`](#patch-api-v1-seller-products-id) 🔒 | Update seller product |

### `GET` `/api/v1/seller/analytics`

**Seller sales and earnings reports**

🔒 Requires a bearer token.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Seller analytics | [`SellerAnalytics`](#selleranalytics) |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |

### `GET` `/api/v1/seller/orders`

**List orders containing seller items**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `status` | query | no | `placed` \| `confirmed` \| `shipped` \| `delivered` \| `cancelled` | e.g. `"placed"` |
| `onlyRedemptions` | query | no | boolean,null |  |
| `cursor` | query | no | string |  |
| `limit` | query | no | integer | default `20` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Seller orders | object |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |

### `PATCH` `/api/v1/seller/orders/{id}/status`

**Update fulfillment status of an order**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Request body** (required) — [`UpdateSellerOrderStatusBody`](#updatesellerorderstatusbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `status` | `placed` \| `confirmed` \| `shipped` \| `delivered` \| `cancelled` | yes | e.g. `"placed"` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Status updated | object |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |
| `404` | Not found | null |
| `422` | Domain rule violation | null |

### `GET` `/api/v1/seller/products`

**List own products**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `category` | query | no | `plants` \| `household` \| `personal_care` \| `kitchen` \| `stationery` | e.g. `"plants"` |
| `status` | query | no | `all` \| `active` \| `inactive` | default `"all"` |
| `q` | query | no | string |  |
| `cursor` | query | no | string |  |
| `limit` | query | no | integer | default `20` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Seller products | object |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |

### `POST` `/api/v1/seller/products`

**Create a product**

🔒 Requires a bearer token.

**Request body** (required) — [`CreateSellerProductBody`](#createsellerproductbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | e.g. `"Eco Bamboo Toothbrush"` |
| `slug` | string | no | e.g. `"eco-bamboo-toothbrush"` |
| `description` | string | no | e.g. `"100% biodegradable handle with charcoal bristles."` |
| `category` | `plants` \| `household` \| `personal_care` \| `kitchen` \| `stationery` | yes | e.g. `"plants"` |
| `pricePaise` | integer | yes | Base price in paise. e.g. `19900`. range 0…∞ |
| `imageUrl` | string,null (uri) | no | e.g. `"https://images.unsplash.com/photo-1592150621744"` |
| `images` | string[] | no | default `[]` |
| `stock` | integer | no | e.g. `50`. range 0…∞. default `0` |
| `co2SavedKg` | number,null | no | e.g. `0.5`. range 0…∞ |
| `discountType` | `none` \| `percentage` \| `fixed` | no | e.g. `"percentage"` |
| `discountValue` | integer | no | range 0…∞ |
| `discountStartDate` | string,null | no | e.g. `"2026-11-01T00:00:00.000Z"` |
| `discountEndDate` | string,null | no | e.g. `"2026-11-30T23:59:59.000Z"` |
| `allowCoinRedemption` | boolean | no |  |
| `maxCoinRedemptionPercent` | integer | no | range 0…100 |
| `isActive` | boolean | no |  |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `201` | Product created | [`Product`](#product) |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |

### `DELETE` `/api/v1/seller/products/{id}`

**Delete or deactivate product**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Deleted | object |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |
| `404` | Not found | null |

### `GET` `/api/v1/seller/products/{id}`

**Get seller product detail**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Product detail | [`Product`](#product) |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |
| `404` | Not found | null |

### `PATCH` `/api/v1/seller/products/{id}`

**Update seller product**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Request body** (required) — [`UpdateSellerProductBody`](#updatesellerproductbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no | e.g. `"Eco Bamboo Toothbrush"` |
| `slug` | string | no | e.g. `"eco-bamboo-toothbrush"` |
| `description` | string | no | e.g. `"100% biodegradable handle with charcoal bristles."` |
| `category` | `plants` \| `household` \| `personal_care` \| `kitchen` \| `stationery` | no | e.g. `"plants"` |
| `pricePaise` | integer | no | Base price in paise. e.g. `19900`. range 0…∞ |
| `imageUrl` | string,null (uri) | no | e.g. `"https://images.unsplash.com/photo-1592150621744"` |
| `images` | string[] | no | default `[]` |
| `stock` | integer | no | e.g. `50`. range 0…∞. default `0` |
| `co2SavedKg` | number,null | no | e.g. `0.5`. range 0…∞ |
| `discountType` | `none` \| `percentage` \| `fixed` | no | e.g. `"percentage"` |
| `discountValue` | integer | no | range 0…∞ |
| `discountStartDate` | string,null | no | e.g. `"2026-11-01T00:00:00.000Z"` |
| `discountEndDate` | string,null | no | e.g. `"2026-11-30T23:59:59.000Z"` |
| `allowCoinRedemption` | boolean | no |  |
| `maxCoinRedemptionPercent` | integer | no | range 0…100 |
| `isActive` | boolean | no |  |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Product updated | [`Product`](#product) |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |
| `404` | Not found | null |

---

## events

| | Endpoint | Summary |
|---|---|---|
| `GET` | [`/api/v1/events`](#get-api-v1-events) 🔒 | Discover events |
| `POST` | [`/api/v1/events`](#post-api-v1-events) 🔒 | Create an event — the creator becomes its host |
| `PATCH` | [`/api/v1/events/{id}`](#patch-api-v1-events-id) 🔒 | Edit an event (host only) |
| `POST` | [`/api/v1/events/{id}/cancel`](#post-api-v1-events-id-cancel) 🔒 | Cancel an event (host only) |
| `POST` | [`/api/v1/events/{id}/co-hosts`](#post-api-v1-events-id-co-hosts) 🔒 | Add a co-host (host only). Co-hosts may scan but not edit or cancel. |
| `DELETE` | [`/api/v1/events/{id}/co-hosts/{userId}`](#delete-api-v1-events-id-co-hosts-userid) 🔒 | Remove a co-host (host only) |
| `POST` | [`/api/v1/events/{id}/manual-check-in`](#post-api-v1-events-id-manual-check-in) 🔒 | Check in by participant id — the web fallback for a host without the app |
| `GET` | [`/api/v1/events/{id}/participants`](#get-api-v1-events-id-participants) 🔒 | Participant list (host and co-hosts only) |
| `GET` | [`/api/v1/events/{id}/participants/export`](#get-api-v1-events-id-participants-export) 🔒 | Export participant list as CSV (host only) |
| `GET` | [`/api/v1/events/{id}/pass`](#get-api-v1-events-id-pass) 🔒 | Own pass, including the code for the QR |
| `DELETE` | [`/api/v1/events/{id}/register`](#delete-api-v1-events-id-register) 🔒 | Cancel own registration |
| `POST` | [`/api/v1/events/{id}/register`](#post-api-v1-events-id-register) 🔒 | Register and receive a pass |
| `POST` | [`/api/v1/events/{id}/scan`](#post-api-v1-events-id-scan) 🔒 | Check in a pass by its code (host and co-hosts only) |
| `GET` | [`/api/v1/events/{slug}`](#get-api-v1-events-slug) 🔒 | Event detail with viewer-relative state |

### `GET` `/api/v1/events`

**Discover events**

🔒 Requires a bearer token.

The `nearby` filter requires lat/lng and ranks by Haversine distance in SQL.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `filter` | query | no | `upcoming` \| `nearby` \| `registered` \| `hosting` \| `past` | default `"upcoming"` |
| `type` | query | no | `plant_drive` \| `cleanup_drive` \| `awareness` \| `recycling_drive` \| `workshop` \| `other` | e.g. `"cleanup_drive"` |
| `search` | query | no | string |  |
| `organizationId` | query | no | integer,null |  |
| `lat` | query | no | number,null |  |
| `lng` | query | no | number,null |  |
| `radiusKm` | query | no | number | default `25` |
| `cursor` | query | no | string |  |
| `limit` | query | no | integer | default `20` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Events | object |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |

### `POST` `/api/v1/events`

**Create an event — the creator becomes its host**

🔒 Requires a bearer token.

**Request body** (required) — [`CreateEventBody`](#createeventbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `title` | string | yes | e.g. `"Beach clean-up, Versova"` |
| `description` | string | yes |  |
| `type` | `plant_drive` \| `cleanup_drive` \| `awareness` \| `recycling_drive` \| `workshop` \| `other` | yes | e.g. `"cleanup_drive"` |
| `visibility` | `public` \| `invite_only` \| `organization_only` | no | e.g. `"public"`. default `"public"` |
| `organizationId` | integer,null | no |  |
| `coverUrl` | string,null | no |  |
| `startAt` | string | yes | e.g. `"2026-11-02T01:30:00.000Z"` |
| `endAt` | string | yes | e.g. `"2026-11-02T04:00:00.000Z"` |
| `venueName` | string | yes |  |
| `venueAddress` | string | no |  |
| `venueMapUrl` | string,null | no |  |
| `latitude` | number | no | range -90…90 |
| `longitude` | number | no | range -180…180 |
| `capacity` | integer | no | range 1…10000. default `100` |
| `publish` | boolean | no | False leaves it as a draft, invisible to others. default `false` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `201` | Created | [`Event`](#event) |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |
| `422` | Domain rule violation | null |

### `PATCH` `/api/v1/events/{id}`

**Edit an event (host only)**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `title` | string | no | e.g. `"Beach clean-up, Versova"` |
| `description` | string | no |  |
| `type` | `plant_drive` \| `cleanup_drive` \| `awareness` \| `recycling_drive` \| `workshop` \| `other` | no | e.g. `"cleanup_drive"` |
| `visibility` | `public` \| `invite_only` \| `organization_only` | no | e.g. `"public"`. default `"public"` |
| `organizationId` | integer,null | no |  |
| `coverUrl` | string,null | no |  |
| `startAt` | string | no | e.g. `"2026-11-02T01:30:00.000Z"` |
| `endAt` | string | no | e.g. `"2026-11-02T04:00:00.000Z"` |
| `venueName` | string | no |  |
| `venueAddress` | string | no |  |
| `venueMapUrl` | string,null | no |  |
| `latitude` | number | no | range -90…90 |
| `longitude` | number | no | range -180…180 |
| `capacity` | integer | no | range 1…10000. default `100` |
| `publish` | boolean | no | False leaves it as a draft, invisible to others. default `false` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Updated | [`Event`](#event) |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |
| `404` | Not found | null |

### `POST` `/api/v1/events/{id}/cancel`

**Cancel an event (host only)**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Cancelled | [`Event`](#event) |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |

### `POST` `/api/v1/events/{id}/co-hosts`

**Add a co-host (host only). Co-hosts may scan but not edit or cancel.**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Request body** (required) — [`CoHostBody`](#cohostbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `userId` | integer | yes | e.g. `9` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Added | [`Event`](#event) |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |
| `404` | Not found | null |

### `DELETE` `/api/v1/events/{id}/co-hosts/{userId}`

**Remove a co-host (host only)**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer |  |
| `userId` | path | yes | integer |  |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Removed | [`Event`](#event) |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |

### `POST` `/api/v1/events/{id}/manual-check-in`

**Check in by participant id — the web fallback for a host without the app**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Request body** (required)

| Field | Type | Required | Notes |
|---|---|---|---|
| `passId` | integer | yes |  |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Checked in | [`ScanResult`](#scanresult) |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |
| `404` | Not found | null |
| `422` | Domain rule violation | null |

### `GET` `/api/v1/events/{id}/participants`

**Participant list (host and co-hosts only)**

🔒 Requires a bearer token.

A participant list is personal data. Non-hosts get 403 — it is never public.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Participants | [`EventParticipantList`](#eventparticipantlist) |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |

### `GET` `/api/v1/events/{id}/participants/export`

**Export participant list as CSV (host only)**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | CSV file download | — |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |
| `404` | Not found | null |

### `GET` `/api/v1/events/{id}/pass`

**Own pass, including the code for the QR**

🔒 Requires a bearer token.

Only ever returns the caller's own pass. `passCode` and `qrPayload` are ALWAYS empty here: the code is stored as a SHA-256 hash and cannot be reproduced. Cache them on device from the register response, and POST /events/{id}/register again to rotate to a fresh code if the cache is lost.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Pass | [`EventPass`](#eventpass) |
| `401` | Not authenticated | null |
| `404` | Not found | null |

### `DELETE` `/api/v1/events/{id}/register`

**Cancel own registration**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Cancelled | object |
| `401` | Not authenticated | null |
| `404` | Not found | null |

### `POST` `/api/v1/events/{id}/register`

**Register and receive a pass**

🔒 Requires a bearer token.

Idempotent: registering twice claims no second seat and pays no second reward. It DOES mint a fresh `passCode` while the pass is still `registered`, which is how a reinstall or a second device recovers a QR — the code is stored only as a hash and can never be read back, so rotation is the only recovery. The previous code stops working. A `checked_in` or `no_show` pass is spent and comes back with an empty code. Registration itself closes at start + 1h or when capacity is reached; that window is not re-checked for someone who already holds a pass.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `201` | Registered | [`RegisterResult`](#registerresult) |
| `401` | Not authenticated | null |
| `404` | Not found | null |
| `409` | Conflict | null |
| `422` | Domain rule violation | null |

### `POST` `/api/v1/events/{id}/scan`

**Check in a pass by its code (host and co-hosts only)**

🔒 Requires a bearer token.

Seven ordered checks (PRD-v2 §6.6.4):
1. caller is host or co-host  -> 403 EVENT_001
2. pass exists for this event -> 404 EVENT_002
3. now within [start-1h, end+2h] -> 422 EVENT_003
4. not already checked in     -> 200 with alreadyCheckedIn: true, no second reward
5. under capacity             -> 422 EVENT_005
6. mark checked in + award the attendee, in one transaction
7. flag for review when check-ins exceed 3x this host's median

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Request body** (required) — [`ScanBody`](#scanbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `passCode` | string | yes | e.g. `"yJ8kQ2mXp..."` |
| `scanClientId` | string (uuid) | yes | e.g. `"0193f0c4-11bb-7a2e-9d31-4e5f6a7b8c9d"` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Checked in, or already checked in | [`ScanResult`](#scanresult) |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |
| `404` | Not found | null |
| `422` | Domain rule violation | null |
| `429` | Rate limited — see Retry-After | null |

### `GET` `/api/v1/events/{slug}`

**Event detail with viewer-relative state**

🔒 Requires a bearer token.

The path segment accepts the slug OR the numeric id, so an event reached from a notification payload, a deep link or a pass — all of which carry the id, as every mutation below is keyed by id — can be read back without first resolving a slug. A purely numeric slug is still matched as an id, so do not mint one.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `slug` | path | yes | string | e.g. `"versova-beach-cleanup"` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Event | [`Event`](#event) |
| `403` | Not authorised | null |
| `404` | Not found | null |

---

## organizations

| | Endpoint | Summary |
|---|---|---|
| `GET` | [`/api/v1/admin/organizations`](#get-api-v1-admin-organizations) 🔒 | Review queue (admin only) |
| `POST` | [`/api/v1/admin/organizations/{id}/review`](#post-api-v1-admin-organizations-id-review) 🔒 | Approve, reject, suspend or reinstate (admin only) |
| `POST` | [`/api/v1/organizations`](#post-api-v1-organizations) 🔒 | Register an organization |
| `PATCH` | [`/api/v1/organizations/{id}`](#patch-api-v1-organizations-id) 🔒 | Edit an organization (owner only) |
| `GET` | [`/api/v1/organizations/{id}/analytics`](#get-api-v1-organizations-id-analytics) 🔒 | Cumulative organization carbon footprint analytics (owner only) |
| `GET` | [`/api/v1/organizations/{id}/members`](#get-api-v1-organizations-id-members) 🔒 | Roster — any member may read it; insights filtered by privacy and role |
| `POST` | [`/api/v1/organizations/{id}/members`](#post-api-v1-organizations-id-members) 🔒 | Add a member by email (owner only) |
| `DELETE` | [`/api/v1/organizations/{id}/members/{userId}`](#delete-api-v1-organizations-id-members-userid) 🔒 | Remove another member (owner only) |
| `GET` | [`/api/v1/organizations/{id}/members/{userId}/answers`](#get-api-v1-organizations-id-members-userid-answers) 🔒 | View a member's custom onboarding answers (owner only) |
| `GET` | [`/api/v1/organizations/{id}/questions`](#get-api-v1-organizations-id-questions) 🔒 | List custom onboarding questions for an organization |
| `POST` | [`/api/v1/organizations/{id}/questions`](#post-api-v1-organizations-id-questions) 🔒 | Create a custom onboarding question (owner only) |
| `DELETE` | [`/api/v1/organizations/{id}/questions/{questionId}`](#delete-api-v1-organizations-id-questions-questionid) 🔒 | Delete (archive) a custom onboarding question (owner only) |
| `PUT` | [`/api/v1/organizations/{id}/questions/{questionId}`](#put-api-v1-organizations-id-questions-questionid) 🔒 | Update a custom onboarding question (owner only) |
| `POST` | [`/api/v1/organizations/{id}/questions/reorder`](#post-api-v1-organizations-id-questions-reorder) 🔒 | Reorder custom onboarding questions (owner only) |
| `POST` | [`/api/v1/organizations/join`](#post-api-v1-organizations-join) 🔒 | Join an organization using its code or slug |
| `GET` | [`/api/v1/organizations/lookup`](#get-api-v1-organizations-lookup)  | Validate organization code before signup |
| `GET` | [`/api/v1/organizations/me`](#get-api-v1-organizations-me) 🔒 | The caller's own organization, if any |
| `POST` | [`/api/v1/organizations/me/code/regenerate`](#post-api-v1-organizations-me-code-regenerate) 🔒 | Regenerate organization 6-digit code (owner only) |
| `DELETE` | [`/api/v1/organizations/me/membership`](#delete-api-v1-organizations-me-membership) 🔒 | Leave your organization |
| `PATCH` | [`/api/v1/organizations/me/membership`](#patch-api-v1-organizations-me-membership) 🔒 | Update membership preferences (e.g. carbon footprint privacy sharing) |
| `GET` | [`/api/v1/organizations/me/onboarding`](#get-api-v1-organizations-me-onboarding) 🔒 | Get custom onboarding questions and current answers for the caller |
| `POST` | [`/api/v1/organizations/me/onboarding`](#post-api-v1-organizations-me-onboarding) 🔒 | Submit answers for custom onboarding questions |

### `GET` `/api/v1/admin/organizations`

**Review queue (admin only)**

🔒 Requires a bearer token.

Filter by `status=pending` for the queue. `reviewNote` is visible here only.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `status` | query | no | `pending` \| `approved` \| `rejected` \| `suspended` | e.g. `"pending"` |
| `type` | query | no | `industry` \| `ngo` \| `seller` | e.g. `"industry"` |
| `cursor` | query | no | string |  |
| `limit` | query | no | integer | default `20` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Organizations | object |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |

### `POST` `/api/v1/admin/organizations/{id}/review`

**Approve, reject, suspend or reinstate (admin only)**

🔒 Requires a bearer token.

A rejection or suspension requires a note — a decision a human has to defend later should be explained while they still remember why.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Request body** (required) — [`ReviewOrganizationBody`](#revieworganizationbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `decision` | `approve` \| `reject` \| `suspend` \| `reinstate` | yes | e.g. `"approve"` |
| `note` | string | no | e.g. `"GST certificate checked."` |
| `expected` | object | yes | The identity fields exactly as the review queue showed them. Compared inside the UPDATE, so an edit landing mid-decision is refused rather than approved unseen. |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Reviewed | [`Organization`](#organization) |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |
| `404` | Not found | null |
| `422` | Domain rule violation | null |

### `POST` `/api/v1/organizations`

**Register an organization**

🔒 Requires a bearer token.

Creates it as `pending` and makes the caller its owner. It stays unusable until an admin approves it — anyone can claim to be a corporate partner at signup.

**Request body** (required) — [`CreateOrganizationBody`](#createorganizationbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | e.g. `"Acme Industries"` |
| `type` | `industry` \| `ngo` \| `seller` | yes | Corporate · Community · Seller portal. e.g. `"industry"` |
| `description` | string | no |  |
| `websiteUrl` | string (uri) | no |  |
| `contactEmail` | string (email) | no |  |
| `contactPhone` | string | no |  |
| `city` | string | no |  |
| `regionCode` | string | no |  |
| `address` | string | no |  |
| `verificationDetails` | object | no |  |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `201` | Created, pending review | [`Organization`](#organization) |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |
| `409` | Conflict | null |

### `PATCH` `/api/v1/organizations/{id}`

**Edit an organization (owner only)**

🔒 Requires a bearer token.

`type` and `status` are deliberately not editable: a seller must not re-badge itself as an NGO after approval, and nobody approves themselves.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Request body** — [`UpdateOrganizationBody`](#updateorganizationbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no | e.g. `"Acme Industries"` |
| `description` | string | no |  |
| `websiteUrl` | string (uri) | no |  |
| `contactEmail` | string (email) | no |  |
| `contactPhone` | string | no |  |
| `city` | string | no |  |
| `regionCode` | string | no |  |
| `address` | string | no |  |
| `verificationDetails` | object | no |  |
| `logoUrl` | string,null (uri) | no | Any https URL the caller controls, or one returned by POST /uploads/presign.. e.g. `"https://images.unsplash.com/photo-1607346256330-dee7af15f7c5?auto=format&fit=facearea&facepad=3&w=256&h=256&q=70"` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Updated | [`Organization`](#organization) |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |
| `404` | Not found | null |
| `409` | Conflict | null |

### `GET` `/api/v1/organizations/{id}/analytics`

**Cumulative organization carbon footprint analytics (owner only)**

🔒 Requires a bearer token.

Aggregated organization-level footprint: total emissions, per-month trend, category breakdown, and average per employee.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Organization Analytics | [`OrganizationAnalytics`](#organizationanalytics) |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |
| `404` | Not found | null |

### `GET` `/api/v1/organizations/{id}/members`

**Roster — any member may read it; insights filtered by privacy and role**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |
| `search` | query | no | string | e.g. `"Alice"` |
| `role` | query | no | `owner` \| `member` | e.g. `"member"` |
| `onboardingStatus` | query | no | `completed` \| `pending` | e.g. `"completed"` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Members | [`OrganizationMemberList`](#organizationmemberlist) |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |
| `404` | Not found | null |

### `POST` `/api/v1/organizations/{id}/members`

**Add a member by email (owner only)**

🔒 Requires a bearer token.

The person must already have an account. One organization per user.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Request body** (required) — [`AddOrganizationMemberBody`](#addorganizationmemberbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `email` | string (email) | yes | Must already have an account. e.g. `"colleague@acme.example.com"` |
| `role` | `owner` \| `member` | no | e.g. `"owner"`. default `"member"` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Members after the change | [`OrganizationMemberList`](#organizationmemberlist) |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |
| `404` | Not found | null |
| `409` | Conflict | null |

### `DELETE` `/api/v1/organizations/{id}/members/{userId}`

**Remove another member (owner only)**

🔒 Requires a bearer token.

To remove yourself, use DELETE /organizations/me/membership — the answer differs, because someone who has just left cannot read the roster they are no longer on. The last owner cannot be removed either way.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `7` |
| `userId` | path | yes | integer | e.g. `9` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Members after the change | [`OrganizationMemberList`](#organizationmemberlist) |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |
| `404` | Not found | null |
| `422` | Domain rule violation | null |

### `GET` `/api/v1/organizations/{id}/members/{userId}/answers`

**View a member's custom onboarding answers (owner only)**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |
| `userId` | path | yes | integer | e.g. `7` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Member answers | [`OrgEmployeeAnswers`](#orgemployeeanswers) |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |
| `404` | Not found | null |

### `GET` `/api/v1/organizations/{id}/questions`

**List custom onboarding questions for an organization**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Questions list | [`OrgOnboardingQuestion`](#orgonboardingquestion)[] |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |
| `404` | Not found | null |

### `POST` `/api/v1/organizations/{id}/questions`

**Create a custom onboarding question (owner only)**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Request body** (required) — [`CreateOrgQuestionBody`](#createorgquestionbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | yes | e.g. `"What department do you work in?"` |
| `description` | string | no | e.g. `"Used for team impact reports"` |
| `type` | [`OrgQuestionType`](#orgquestiontype) | yes |  |
| `options` | string[] | no |  |
| `required` | boolean | no | e.g. `false`. default `false` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `201` | Question created | [`OrgOnboardingQuestion`](#orgonboardingquestion) |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |
| `404` | Not found | null |

### `DELETE` `/api/v1/organizations/{id}/questions/{questionId}`

**Delete (archive) a custom onboarding question (owner only)**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |
| `questionId` | path | yes | integer | e.g. `1` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Deleted | object |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |
| `404` | Not found | null |

### `PUT` `/api/v1/organizations/{id}/questions/{questionId}`

**Update a custom onboarding question (owner only)**

🔒 Requires a bearer token.

Updating the prompt or type increments the question version so previous answers remain faithful snapshots.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |
| `questionId` | path | yes | integer | e.g. `1` |

**Request body** (required) — [`UpdateOrgQuestionBody`](#updateorgquestionbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | no |  |
| `description` | string,null | no |  |
| `type` | [`OrgQuestionType`](#orgquestiontype) | no |  |
| `options` | array,null | no |  |
| `required` | boolean | no |  |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Question updated | [`OrgOnboardingQuestion`](#orgonboardingquestion) |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |
| `404` | Not found | null |

### `POST` `/api/v1/organizations/{id}/questions/reorder`

**Reorder custom onboarding questions (owner only)**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Request body** (required) — [`ReorderOrgQuestionsBody`](#reorderorgquestionsbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `questionIds` | integer[] | yes |  |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Reordered | object |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |
| `404` | Not found | null |

### `POST` `/api/v1/organizations/join`

**Join an organization using its code or slug**

🔒 Requires a bearer token.

**Request body** (required) — [`JoinOrganizationBody`](#joinorganizationbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `code` | string | yes | Organization code or slug. e.g. `"acme-industries"` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Joined successfully | [`JoinOrganizationResult`](#joinorganizationresult) |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |
| `404` | Not found | null |
| `409` | Conflict | null |

### `GET` `/api/v1/organizations/lookup`

**Validate organization code before signup**

🔓 No authentication.

Public endpoint to check if an organization code exists and is approved to accept members.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `code` | query | yes | string | e.g. `"482910"` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Organization found and active | [`OrganizationLookupResult`](#organizationlookupresult) |
| `400` | Validation failed | null |
| `403` | Not authorised | null |
| `404` | Not found | null |
| `429` | Rate limited — see Retry-After | null |

### `GET` `/api/v1/organizations/me`

**The caller's own organization, if any**

🔒 Requires a bearer token.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Own organization, or nulls | [`MyOrganization`](#myorganization) |
| `401` | Not authenticated | null |

### `POST` `/api/v1/organizations/me/code/regenerate`

**Regenerate organization 6-digit code (owner only)**

🔒 Requires a bearer token.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | New 6-digit code generated | [`RegenerateCodeResult`](#regeneratecoderesult) |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |
| `404` | Not found | null |

### `DELETE` `/api/v1/organizations/me/membership`

**Leave your organization**

🔒 Requires a bearer token.

Anyone may leave, except the last owner. Members are ADDED by an owner rather than invited, so this is how someone who did not ask to be enrolled gets out — and since a person may belong to only one organization, being enrolled also blocks them from creating their own until they do.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Left | [`LeaveOrganizationResult`](#leaveorganizationresult) |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |
| `422` | Domain rule violation | null |

### `PATCH` `/api/v1/organizations/me/membership`

**Update membership preferences (e.g. carbon footprint privacy sharing)**

🔒 Requires a bearer token.

**Request body** (required) — [`UpdateMembershipPreferencesBody`](#updatemembershippreferencesbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `shareFootprint` | boolean | yes | e.g. `true` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Preferences updated | [`UpdateMembershipPreferencesResult`](#updatemembershippreferencesresult) |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |

### `GET` `/api/v1/organizations/me/onboarding`

**Get custom onboarding questions and current answers for the caller**

🔒 Requires a bearer token.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Custom onboarding questions and answers | [`OrgOnboardingStatus`](#orgonboardingstatus) |
| `401` | Not authenticated | null |
| `404` | Not found | null |

### `POST` `/api/v1/organizations/me/onboarding`

**Submit answers for custom onboarding questions**

🔒 Requires a bearer token.

**Request body** (required) — [`SubmitOrgOnboardingAnswersBody`](#submitorgonboardinganswersbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `answers` | [`OrgAnswerInput`](#organswerinput)[] | yes |  |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Answers submitted | object |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |
| `404` | Not found | null |

---

## admin-revenue

| | Endpoint | Summary |
|---|---|---|
| `GET` | [`/api/v1/admin/revenue/analytics`](#get-api-v1-admin-revenue-analytics) 🔒 | Platform revenue, GMV, coin liability, and payout summary |
| `GET` | [`/api/v1/admin/revenue/ledger`](#get-api-v1-admin-revenue-ledger) 🔒 | Immutable transaction ledger journal |
| `GET` | [`/api/v1/admin/revenue/payouts`](#get-api-v1-admin-revenue-payouts) 🔒 | List seller payout records |
| `POST` | [`/api/v1/admin/revenue/payouts`](#post-api-v1-admin-revenue-payouts) 🔒 | Disburse pending settlements to seller |
| `GET` | [`/api/v1/admin/revenue/settlements`](#get-api-v1-admin-revenue-settlements) 🔒 | List order settlements |
| `GET` | [`/api/v1/admin/settings`](#get-api-v1-admin-settings) 🔒 | Get global economy and commission settings |
| `PATCH` | [`/api/v1/admin/settings`](#patch-api-v1-admin-settings) 🔒 | Update global economy and commission settings |
| `GET` | [`/api/v1/admin/settings/sellers/{id}/commission`](#get-api-v1-admin-settings-sellers-id-commission) 🔒 | Get seller commission override |
| `PUT` | [`/api/v1/admin/settings/sellers/{id}/commission`](#put-api-v1-admin-settings-sellers-id-commission) 🔒 | Set or clear seller commission override |

### `GET` `/api/v1/admin/revenue/analytics`

**Platform revenue, GMV, coin liability, and payout summary**

🔒 Requires a bearer token.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Revenue analytics summary | [`RevenueAnalytics`](#revenueanalytics) |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |

### `GET` `/api/v1/admin/revenue/ledger`

**Immutable transaction ledger journal**

🔒 Requires a bearer token.

Double-entry style audit log for commissions, coin subsidies, fees, and payouts.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `sellerOrgId` | query | no | string | e.g. `"12"` |
| `transactionType` | query | no | `sale_commission` \| `coin_subsidy` \| `coin_fee` \| `seller_payout` | e.g. `"sale_commission"` |
| `orderId` | query | no | string |  |
| `cursor` | query | no | string |  |
| `limit` | query | no | integer | default `50` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Settlement ledger entries | object |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |

### `GET` `/api/v1/admin/revenue/payouts`

**List seller payout records**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `sellerOrgId` | query | no | string | e.g. `"12"` |
| `cursor` | query | no | string |  |
| `limit` | query | no | integer | default `20` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Seller payouts | object |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |

### `POST` `/api/v1/admin/revenue/payouts`

**Disburse pending settlements to seller**

🔒 Requires a bearer token.

Creates a payout batch and marks associated settlements as settled.

**Request body** — [`CreatePayoutBody`](#createpayoutbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `sellerOrgId` | integer | yes | e.g. `12` |
| `settlementIds` | integer[] | no |  |
| `referenceNote` | string | no | e.g. `"Monthly disbursement via UPI/NEFT"` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `201` | Payout disbursed | [`SellerPayout`](#sellerpayout) |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |

### `GET` `/api/v1/admin/revenue/settlements`

**List order settlements**

🔒 Requires a bearer token.

Line-item breakdown of sales, coin subsidies, platform commissions, and seller payouts.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `sellerOrgId` | query | no | string | e.g. `"12"` |
| `status` | query | no | `pending` \| `settled` \| `cancelled` | e.g. `"pending"` |
| `cursor` | query | no | string |  |
| `limit` | query | no | integer | default `20` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Order settlements | object |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |

### `GET` `/api/v1/admin/settings`

**Get global economy and commission settings**

🔒 Requires a bearer token.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Global system settings | [`SystemSettings`](#systemsettings) |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |

### `PATCH` `/api/v1/admin/settings`

**Update global economy and commission settings**

🔒 Requires a bearer token.

Configures sales commission %, coin fee %, coin-to-rupee rate, and max coin redemption discount %.

**Request body** — [`UpdateSystemSettingsBody`](#updatesystemsettingsbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `defaultCommissionRateBps` | integer | no | range 0…5000 |
| `coinRedemptionFeeBps` | integer | no | range 0…2000 |
| `coinsPerRupee` | integer | no |  |
| `coinValuePaise` | integer | no |  |
| `maxDiscountPercent` | integer | no | range 0…100 |
| `payoutHoldDays` | integer | no | range 0…∞ |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Updated system settings | [`SystemSettings`](#systemsettings) |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |

### `GET` `/api/v1/admin/settings/sellers/{id}/commission`

**Get seller commission override**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Seller commission override | [`SellerCommissionOverride`](#sellercommissionoverride) |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |
| `404` | Not found | null |

### `PUT` `/api/v1/admin/settings/sellers/{id}/commission`

**Set or clear seller commission override**

🔒 Requires a bearer token.

Set `commissionRateBps: null` to revert to global platform default.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Request body** — [`SellerCommissionOverrideBody`](#sellercommissionoverridebody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `commissionRateBps` | integer,null | yes | Seller override in basis points (800 = 8%), or null to inherit global default. e.g. `800`. range 0…5000 |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Updated seller commission override | [`SellerCommissionOverride`](#sellercommissionoverride) |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |
| `403` | Not authorised | null |
| `404` | Not found | null |

---

## notifications

| | Endpoint | Summary |
|---|---|---|
| `GET` | [`/api/v1/notifications`](#get-api-v1-notifications) 🔒 | In-app notifications |
| `PATCH` | [`/api/v1/notifications/{id}/read`](#patch-api-v1-notifications-id-read) 🔒 | Mark one notification read |
| `DELETE` | [`/api/v1/notifications/push-token`](#delete-api-v1-notifications-push-token) 🔒 | Unregister FCM push token |
| `POST` | [`/api/v1/notifications/push-token`](#post-api-v1-notifications-push-token) 🔒 | Register FCM device push token |
| `POST` | [`/api/v1/notifications/read-all`](#post-api-v1-notifications-read-all) 🔒 | Mark all notifications read |
| `POST` | [`/api/v1/notifications/send-predefined`](#post-api-v1-notifications-send-predefined) 🔒 | Send a predefined notification |

### `GET` `/api/v1/notifications`

**In-app notifications**

🔒 Requires a bearer token.

Paginated list of in-app notifications for the authenticated user.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `cursor` | query | no | string |  |
| `limit` | query | no | integer | e.g. `20`. default `20` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Notifications | object |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |

### `PATCH` `/api/v1/notifications/{id}/read`

**Mark one notification read**

🔒 Requires a bearer token.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `id` | path | yes | integer | e.g. `42` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Marked read | [`Notification`](#notification) |
| `401` | Not authenticated | null |
| `404` | Not found | null |

### `DELETE` `/api/v1/notifications/push-token`

**Unregister FCM push token**

🔒 Requires a bearer token.

Removes the device FCM push token on user logout.

**Request body** (required) — [`DeletePushTokenBody`](#deletepushtokenbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `token` | string | yes | e.g. `"f-abc123xyz..."` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Token unregistered | object |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |

### `POST` `/api/v1/notifications/push-token`

**Register FCM device push token**

🔒 Requires a bearer token.

Registers or updates the FCM push token for the authenticated user.

**Request body** (required) — [`PushTokenBody`](#pushtokenbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `token` | string | yes | FCM device token. e.g. `"f-abc123xyz..."` |
| `platform` | `android` \| `ios` | no | Device OS platform. e.g. `"android"`. default `"android"` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Token registered | object |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |

### `POST` `/api/v1/notifications/read-all`

**Mark all notifications read**

🔒 Requires a bearer token.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | All marked read | object |
| `401` | Not authenticated | null |

### `POST` `/api/v1/notifications/send-predefined`

**Send a predefined notification**

🔒 Requires a bearer token.

Dispatches one of the predefined notifications (DAILY_REMINDER, GOAL_COMPLETED, COINS_EARNED, EVENT_REMINDER, TREE_MILESTONE) with automatic FCM delivery.

**Request body** (required) — [`PredefinedNotificationBody`](#predefinednotificationbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `DAILY_REMINDER` \| `GOAL_COMPLETED` \| `COINS_EARNED` \| `EVENT_REMINDER` \| `TREE_MILESTONE` | yes | Predefined notification type. e.g. `"DAILY_REMINDER"` |
| `params` | object | no | Template parameter substitutions |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Notification dispatched | object |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |

---

## reference

| | Endpoint | Summary |
|---|---|---|
| `GET` | [`/api/v1/cities`](#get-api-v1-cities)  | City autocomplete for onboarding |
| `GET` | [`/api/v1/regions`](#get-api-v1-regions)  | Regions with their grid emission factor and tariff |
| `POST` | [`/api/v1/uploads/presign`](#post-api-v1-uploads-presign) 🔒 | Presigned PUT for a direct-to-storage upload |

### `GET` `/api/v1/cities`

**City autocomplete for onboarding**

🔓 No authentication.

**Parameters**

| Name | In | Required | Type | Notes |
|---|---|---|---|---|
| `q` | query | yes | string | e.g. `"mum"` |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Matching cities | object |
| `400` | Validation failed | null |

### `GET` `/api/v1/regions`

**Regions with their grid emission factor and tariff**

🔓 No authentication.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Regions | object |

### `POST` `/api/v1/uploads/presign`

**Presigned PUT for a direct-to-storage upload**

🔒 Requires a bearer token.

Images never transit the API. The server verifies magic bytes and strips EXIF asynchronously after upload.

**Request body** (required) — [`PresignBody`](#presignbody)

| Field | Type | Required | Notes |
|---|---|---|---|
| `purpose` | `avatar` \| `event_cover` | yes | e.g. `"event_cover"` |
| `contentType` | `image/jpeg` \| `image/png` \| `image/webp` | yes | e.g. `"image/jpeg"` |
| `sizeBytes` | integer | yes | e.g. `840122`. range 1…5242880 |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Presigned | [`PresignResult`](#presignresult) |
| `400` | Validation failed | null |
| `401` | Not authenticated | null |
| `429` | Rate limited — see Retry-After | null |
| `503` | Uploads are not configured on this server | null |

---

## carbon

| | Endpoint | Summary |
|---|---|---|
| `GET` | [`/api/v1/carbon/methodology`](#get-api-v1-carbon-methodology)  | Every emission factor, with its source — public |

### `GET` `/api/v1/carbon/methodology`

**Every emission factor, with its source — public**

🔓 No authentication.

Rendered at /methodology on web. No auth: it is the credibility surface.

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | Factor table | [`Methodology`](#methodology) |

---

## ai

| | Endpoint | Summary |
|---|---|---|
| `POST` | [`/api/v1/ai/chat`](#post-api-v1-ai-chat)  | AI Advisor Chatbot powered by Google Gemini |

### `POST` `/api/v1/ai/chat`

**AI Advisor Chatbot powered by Google Gemini**

🔓 No authentication.

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `messages` | object[] | yes |  |
| `context` | object | no |  |

**Responses**

| Code | Meaning | `data` |
|---|---|---|
| `200` | AI response generated successfully | object |

---

## Schemas

132 named components.

### ActiveGoalSummary

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | yes | e.g. `3` |
| `label` | string | yes | e.g. `"Cut 15% this month"` |
| `progressPct` | number | yes | e.g. `64` |
| `daysLeft` | integer | yes | e.g. `11` |
| `onTrack` | boolean | yes | e.g. `true` |

### AddCartItemBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `productId` | integer | yes | e.g. `12` |
| `quantity` | integer | no | e.g. `1`. range 1…20. default `1` |

### AddOrganizationMemberBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `email` | string (email) | yes | Must already have an account. e.g. `"colleague@acme.example.com"` |
| `role` | `owner` \| `member` | no | e.g. `"owner"`. default `"member"` |

### Address

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | yes | e.g. `2` |
| `name` | string | yes | e.g. `"Adittya"` |
| `phone` | string | yes | e.g. `"+919876543210"` |
| `line1` | string | yes | e.g. `"12 Hill Road"` |
| `line2` | string,null | no |  |
| `city` | string | yes | e.g. `"Mumbai"` |
| `state` | string | yes | e.g. `"Maharashtra"` |
| `pincode` | string | yes | e.g. `"400050"` |
| `isDefault` | boolean | yes | e.g. `true` |

### AddressBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | e.g. `"Adittya"` |
| `phone` | string | yes | e.g. `"+919876543210"` |
| `line1` | string | yes | e.g. `"12 Hill Road"` |
| `line2` | string,null | no |  |
| `city` | string | yes | e.g. `"Mumbai"` |
| `state` | string | yes | e.g. `"Maharashtra"` |
| `pincode` | string | yes | e.g. `"400050"` |
| `isDefault` | boolean | yes | e.g. `true` |

### ApiError

| Field | Type | Required | Notes |
|---|---|---|---|
| `code` | string | yes | e.g. `"AUTH_001"` |
| `message` | string | yes | e.g. `"Invalid email or password."` |
| `details` | object | yes |  |

### AuthResult

| Field | Type | Required | Notes |
|---|---|---|---|
| `session` | [`Session`](#session) | yes |  |
| `user` | [`Me`](#me) | yes |  |

### Baseline

| Field | Type | Required | Notes |
|---|---|---|---|
| `transportKg` | number | yes | e.g. `2.74` |
| `foodKg` | number | yes | e.g. `1.27` |
| `homeEnergyKg` | number | yes | e.g. `1.83` |
| `waterKg` | number | yes | e.g. `0.05` |
| `wasteKg` | number | yes | e.g. `0.16` |
| `totalKg` | number | yes | e.g. `6.05` |

### Breakdown

| Field | Type | Required | Notes |
|---|---|---|---|
| `transportKg` | number | yes | e.g. `2.74` |
| `foodKg` | number | yes | e.g. `1.27` |
| `homeEnergyKg` | number | yes | e.g. `1.83` |
| `waterKg` | number | yes | e.g. `0.05` |
| `wasteKg` | number | yes | e.g. `0.16` |
| `totalKg` | number | yes | e.g. `6.05` |

### CartItem

| Field | Type | Required | Notes |
|---|---|---|---|
| `productId` | integer | yes | e.g. `12` |
| `product` | [`Product`](#product) | yes |  |
| `quantity` | integer | yes | e.g. `2`. range 1…∞ |
| `lineTotalPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |

### CartPreviewBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `offeredCoins` | integer | yes | e.g. `2000`. range 0…∞ |

### CartQuote

| Field | Type | Required | Notes |
|---|---|---|---|
| `items` | [`CartItem`](#cartitem)[] | yes |  |
| `subtotalPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `maxDiscountPaise` | integer | yes | 20% of subtotal, floored. e.g. `24000` |
| `discountPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `totalPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `coinsSpent` | integer | yes | e.g. `480` |
| `coinsBalanceAfter` | integer | yes | e.g. `0` |
| `coinsPerRupee` | integer | yes | e.g. `10` |
| `capReached` | boolean | yes | True when the 20% cap bound the discount. e.g. `true` |

### City

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | yes | e.g. `1` |
| `name` | string | yes | e.g. `"Mumbai"` |
| `regionCode` | string | yes | e.g. `"IN-MH"` |

### CoHostBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `userId` | integer | yes | e.g. `9` |

### CreateEventBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `title` | string | yes | e.g. `"Beach clean-up, Versova"` |
| `description` | string | yes |  |
| `type` | `plant_drive` \| `cleanup_drive` \| `awareness` \| `recycling_drive` \| `workshop` \| `other` | yes | e.g. `"cleanup_drive"` |
| `visibility` | `public` \| `invite_only` \| `organization_only` | no | e.g. `"public"`. default `"public"` |
| `organizationId` | integer,null | no |  |
| `coverUrl` | string,null | no |  |
| `startAt` | string | yes | e.g. `"2026-11-02T01:30:00.000Z"` |
| `endAt` | string | yes | e.g. `"2026-11-02T04:00:00.000Z"` |
| `venueName` | string | yes |  |
| `venueAddress` | string | no |  |
| `venueMapUrl` | string,null | no |  |
| `latitude` | number | no | range -90…90 |
| `longitude` | number | no | range -180…180 |
| `capacity` | integer | no | range 1…10000. default `100` |
| `publish` | boolean | no | False leaves it as a draft, invisible to others. default `false` |

### CreateGoalBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `reduce_percent` \| `absolute_cap` | yes | e.g. `"reduce_percent"` |
| `period` | `week` \| `month` \| `quarter` | yes | e.g. `"month"` |
| `reducePercent` | number | no | Required when type is reduce_percent. e.g. `15`. range 1…90 |
| `capKgPerDay` | number | no | Required when type is absolute_cap. range 0.5…100 |
| `startDate` | string | yes | e.g. `"2026-11-01"` |

### CreateOrganizationBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | e.g. `"Acme Industries"` |
| `type` | `industry` \| `ngo` \| `seller` | yes | Corporate · Community · Seller portal. e.g. `"industry"` |
| `description` | string | no |  |
| `websiteUrl` | string (uri) | no |  |
| `contactEmail` | string (email) | no |  |
| `contactPhone` | string | no |  |
| `city` | string | no |  |
| `regionCode` | string | no |  |
| `address` | string | no |  |
| `verificationDetails` | object | no |  |

### CreateOrgQuestionBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | yes | e.g. `"What department do you work in?"` |
| `description` | string | no | e.g. `"Used for team impact reports"` |
| `type` | [`OrgQuestionType`](#orgquestiontype) | yes |  |
| `options` | string[] | no |  |
| `required` | boolean | no | e.g. `false`. default `false` |

### CreatePayoutBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `sellerOrgId` | integer | yes | e.g. `12` |
| `settlementIds` | integer[] | no |  |
| `referenceNote` | string | no | e.g. `"Monthly disbursement via UPI/NEFT"` |

### CreateSellerProductBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | e.g. `"Eco Bamboo Toothbrush"` |
| `slug` | string | no | e.g. `"eco-bamboo-toothbrush"` |
| `description` | string | no | e.g. `"100% biodegradable handle with charcoal bristles."` |
| `category` | `plants` \| `household` \| `personal_care` \| `kitchen` \| `stationery` | yes | e.g. `"plants"` |
| `pricePaise` | integer | yes | Base price in paise. e.g. `19900`. range 0…∞ |
| `imageUrl` | string,null (uri) | no | e.g. `"https://images.unsplash.com/photo-1592150621744"` |
| `images` | string[] | no | default `[]` |
| `stock` | integer | no | e.g. `50`. range 0…∞. default `0` |
| `co2SavedKg` | number,null | no | e.g. `0.5`. range 0…∞ |
| `discountType` | `none` \| `percentage` \| `fixed` | no | e.g. `"percentage"` |
| `discountValue` | integer | no | range 0…∞ |
| `discountStartDate` | string,null | no | e.g. `"2026-11-01T00:00:00.000Z"` |
| `discountEndDate` | string,null | no | e.g. `"2026-11-30T23:59:59.000Z"` |
| `allowCoinRedemption` | boolean | no |  |
| `maxCoinRedemptionPercent` | integer | no | range 0…100 |
| `isActive` | boolean | no |  |

### DailyAnswers

| Field | Type | Required | Notes |
|---|---|---|---|
| `trips` | [`Trip`](#trip)[] | no |  |
| `vegMeals` | integer | no | e.g. `2`. range 0…10 |
| `nonVegMeals` | integer | no | e.g. `0`. range 0…10 |
| `veganMeals` | integer | no | e.g. `1`. range 0…10 |
| `acHoursBucket` | `0` \| `1_3` \| `4_8` \| `8_plus` | no | e.g. `"1_3"` |
| `bathChoice` | `bucket` \| `short_shower` \| `long_shower` | no | e.g. `"bucket"` |
| `wasteActions` | `segregated` \| `composted` \| `refused_plastic` \| `none_of_these`[] | no |  |

### DataExport

`object`

### DeletePushTokenBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `token` | string | yes | e.g. `"f-abc123xyz..."` |

### EmissionFactor

| Field | Type | Required | Notes |
|---|---|---|---|
| `key` | string | yes | e.g. `"transport.car_petrol"` |
| `value` | number | yes | e.g. `0.171` |
| `unit` | string | yes | e.g. `"kg CO2e/km"` |
| `basis` | string | yes | e.g. `"13.5 km/l x 2.31 kg CO2/l petrol"` |
| `source` | string | yes | e.g. `"IPCC default + Indian fleet average"` |

### Event

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | yes | e.g. `5` |
| `slug` | string | yes | e.g. `"beach-cleanup-versova"` |
| `title` | string | yes | e.g. `"Beach clean-up, Versova"` |
| `description` | string | yes | e.g. `"Gloves and bags provided. Two hours, then chai."` |
| `type` | `plant_drive` \| `cleanup_drive` \| `awareness` \| `recycling_drive` \| `workshop` \| `other` | yes | e.g. `"cleanup_drive"` |
| `status` | `draft` \| `published` \| `ongoing` \| `completed` \| `cancelled` | yes | e.g. `"published"` |
| `visibility` | `public` \| `invite_only` \| `organization_only` | yes | e.g. `"public"` |
| `organizationId` | integer,null | no | e.g. `42` |
| `organizationName` | string,null | no | e.g. `"TerraCorp"` |
| `coverUrl` | string,null | yes | e.g. `"https://images.unsplash.com/photo-1585320806297-9794b3e4eeae?auto=format&fit=crop&w=1200&q=80"` |
| `host` | [`UserSummary`](#usersummary) | yes |  |
| `startAt` | string | yes | e.g. `"2026-11-02T01:30:00.000Z"` |
| `endAt` | string | yes | e.g. `"2026-11-02T04:00:00.000Z"` |
| `venueName` | string | yes | e.g. `"Versova Beach"` |
| `venueAddress` | string,null | yes | e.g. `"Versova, Andheri West, Mumbai"` |
| `venueMapUrl` | string,null | no | e.g. `"https://maps.google.com/?q=Versova+Beach"` |
| `latitude` | number,null | yes | e.g. `19.1351` |
| `longitude` | number,null | yes | e.g. `72.8126` |
| `capacity` | integer | yes | e.g. `100` |
| `registeredCount` | integer | yes | e.g. `38` |
| `checkedInCount` | integer | yes | e.g. `0` |
| `distanceKm` | number,null | no | Only when the nearby filter was used. e.g. `2.4` |
| `viewer` | [`EventViewerState`](#eventviewerstate) | yes |  |

### EventParticipant

| Field | Type | Required | Notes |
|---|---|---|---|
| `passId` | integer | yes | e.g. `77` |
| `user` | [`UserSummary`](#usersummary) | yes |  |
| `email` | string | no | e.g. `"attendee@example.com"` |
| `status` | `registered` \| `checked_in` \| `cancelled` \| `no_show` | yes | e.g. `"registered"` |
| `registeredAt` | string | yes | e.g. `"2026-10-29T12:00:00.000Z"` |
| `checkedInAt` | string,null | yes |  |

### EventParticipantList

| Field | Type | Required | Notes |
|---|---|---|---|
| `registeredCount` | integer | yes | e.g. `38` |
| `checkedInCount` | integer | yes | e.g. `12` |
| `capacity` | integer | yes | e.g. `100` |
| `items` | [`EventParticipant`](#eventparticipant)[] | yes |  |

### EventPass

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | yes | e.g. `77` |
| `eventId` | integer | yes | e.g. `5` |
| `eventTitle` | string | yes | e.g. `"Beach clean-up, Versova"` |
| `eventStartAt` | string | yes | e.g. `"2026-11-02T01:30:00.000Z"` |
| `venueName` | string | yes | e.g. `"Versova Beach"` |
| `status` | `registered` \| `checked_in` \| `cancelled` \| `no_show` | yes | e.g. `"registered"` |
| `passCode` | string | yes | Owner only. Encode this in the QR.. e.g. `"yJ8kQ2mXp..."` |
| `qrPayload` | string | yes | e.g. `"ecolife://pass/yJ8kQ2mXp..."` |
| `checkedInAt` | string,null | yes |  |

### EventViewerState

| Field | Type | Required | Notes |
|---|---|---|---|
| `isHost` | boolean | yes | e.g. `false` |
| `isCoHost` | boolean | yes | e.g. `false` |
| `registered` | boolean | yes | e.g. `true` |
| `passStatus` | `registered` \| `checked_in` \| `cancelled` \| `no_show` \| null | yes |  |

### Failure

| Field | Type | Required | Notes |
|---|---|---|---|
| `status` | `false` | yes |  |
| `data` | null | yes |  |
| `error` | [`ApiError`](#apierror) | yes |  |

### ForgotPasswordBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `email` | string (email) | yes | e.g. `"yusuf@example.com"` |

### Goal

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | yes | e.g. `3` |
| `type` | `reduce_percent` \| `absolute_cap` | yes |  |
| `period` | `week` \| `month` \| `quarter` | yes |  |
| `reducePercent` | number,null | yes | e.g. `15` |
| `capKgPerDay` | number,null | yes |  |
| `startDate` | string | yes | e.g. `"2026-11-01"` |
| `endDate` | string | yes | e.g. `"2026-11-30"` |
| `baselineKgTotal` | number | yes | e.g. `246` |
| `targetKgTotal` | number | yes | e.g. `209.1` |
| `status` | `active` \| `achieved` \| `missed` \| `cancelled` | yes | e.g. `"active"` |
| `actualKgTotal` | number,null | yes | e.g. `134.2` |
| `settledAt` | string,null | yes |  |
| `createdAt` | string | yes | e.g. `"2026-10-31T09:00:00.000Z"` |

### GoalProgress

| Field | Type | Required | Notes |
|---|---|---|---|
| `goal` | [`Goal`](#goal) | yes |  |
| `actualKgTotal` | number | yes | e.g. `134.2` |
| `targetKgTotal` | number | yes | e.g. `209.1` |
| `progressPct` | number | yes | actual / target, as a percentage. e.g. `64.2` |
| `daysElapsed` | integer | yes | e.g. `19` |
| `daysLeft` | integer | yes | e.g. `11` |
| `projectedKgTotal` | number | yes | Linear projection at the current daily rate. e.g. `211.9` |
| `onTrack` | boolean | yes | e.g. `true` |

### GoalsList

| Field | Type | Required | Notes |
|---|---|---|---|
| `active` | [`Goal`](#goal) \| null | yes |  |
| `past` | [`Goal`](#goal)[] | yes |  |

### GoogleSignInBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `accessToken` | string | yes | Google OAuth access token. e.g. `"ya29.a0AfB_byC..."` |
| `timezone` | string | no | e.g. `"Asia/Kolkata"`. default `"Asia/Kolkata"` |

### GrowthStage

| Field | Type | Required | Notes |
|---|---|---|---|
| `stage` | integer | yes | e.g. `2` |
| `label` | string | yes | e.g. `"Sapling"` |
| `imageUrl` | string | yes | e.g. `"https://images.unsplash.com/photo-1416879595882-3373a0480b5b?auto=format&fit=crop&w=1200&q=80"` |

### HistoryPoint

| Field | Type | Required | Notes |
|---|---|---|---|
| `date` | string | yes | e.g. `"2026-10-31"` |
| `totalKg` | number | yes | e.g. `6.05` |
| `baselineTotalKg` | number | yes | e.g. `8.2` |
| `logged` | boolean | yes | e.g. `true` |

### Home

| Field | Type | Required | Notes |
|---|---|---|---|
| `greetingName` | string | yes | e.g. `"Adittya"` |
| `wallet` | [`Wallet`](#wallet) | yes |  |
| `today` | [`HomeToday`](#hometoday) | yes |  |
| `streak` | [`Streak`](#streak) | yes |  |
| `week` | [`HomeWeek`](#homeweek) | yes |  |
| `breakdown30d` | [`Breakdown`](#breakdown) | yes |  |
| `activeGoal` | [`ActiveGoalSummary`](#activegoalsummary) \| null | yes |  |
| `leaderboard` | [`LeaderboardPeek`](#leaderboardpeek) | yes |  |
| `nextEvent` | [`NextEvent`](#nextevent) \| null | yes |  |

### HomeToday

| Field | Type | Required | Notes |
|---|---|---|---|
| `date` | string | yes | e.g. `"2026-10-31"` |
| `logged` | boolean | yes | False drives the "Log today" CTA. e.g. `true` |
| `breakdown` | [`Breakdown`](#breakdown) | yes |  |
| `baselineTotalKg` | number | yes | e.g. `8.2` |
| `deltaKg` | number | yes | Negative is an improvement. e.g. `-2.15` |
| `percentOfBaseline` | number | yes | e.g. `73.8` |
| `sources` | object | yes |  |
| `inferredCount` | integer | yes | Categories that fell back to baseline. e.g. `2` |

### HomeWeek

| Field | Type | Required | Notes |
|---|---|---|---|
| `sparkline` | object[] | yes |  |
| `avgKgPerDay` | number | yes | e.g. `7.18` |
| `changeVsLastWeekPct` | number | yes | e.g. `-8.9` |

### JoinOrganizationBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `code` | string | yes | Organization code or slug. e.g. `"acme-industries"` |

### JoinOrganizationResult

| Field | Type | Required | Notes |
|---|---|---|---|
| `joined` | `true` | yes |  |
| `organization` | [`Organization`](#organization) | yes |  |
| `role` | `owner` \| `member` | yes | e.g. `"owner"` |

### LeaderboardPeek

| Field | Type | Required | Notes |
|---|---|---|---|
| `top` | unknown[] | yes | Top 3 |
| `me` | object | yes |  |

### LeaderboardRow

`unknown`

### LeaveOrganizationResult

| Field | Type | Required | Notes |
|---|---|---|---|
| `left` | `true` | yes |  |

### Liveness

| Field | Type | Required | Notes |
|---|---|---|---|
| `service` | string | yes | e.g. `"ecolife-server"` |
| `status` | `up` | yes |  |

### LoginBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `email` | string (email) | yes | e.g. `"yusuf@example.com"` |
| `password` | string | yes |  |

### LogResult

| Field | Type | Required | Notes |
|---|---|---|---|
| `logId` | integer | yes | e.g. `812` |
| `breakdown` | [`Breakdown`](#breakdown) | yes |  |
| `baselineTotalKg` | number | yes | e.g. `8.2` |
| `deltaKg` | number | yes | e.g. `-2.15` |
| `reductionPct` | number | yes | e.g. `26.2` |
| `sources` | object | yes |  |
| `clamped` | boolean | yes | True when the day fell below MIN_PLAUSIBLE_KG. e.g. `false` |
| `reward` | [`RewardGrant`](#rewardgrant) | yes |  |
| `wallet` | [`Wallet`](#wallet) | yes |  |
| `streak` | [`Streak`](#streak) | yes |  |

### Me

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | yes | e.g. `7` |
| `name` | string | yes | e.g. `"Yusuf"` |
| `email` | string (email) | yes | e.g. `"yusuf@example.com"` |
| `role` | `user` \| `admin` | yes | e.g. `"user"` |
| `avatarUrl` | string,null | yes |  |
| `city` | string,null | yes | e.g. `"Mumbai"` |
| `timezone` | string | yes | e.g. `"Asia/Kolkata"` |
| `emailVerified` | boolean | yes | False blocks every reward (PRD-v2 §4.4). e.g. `true` |
| `onboardingComplete` | boolean | yes | e.g. `true` |
| `completedSteps` | integer | yes | e.g. `5`. range 0…5 |
| `wallet` | [`Wallet`](#wallet) | yes |  |
| `unreadNotifications` | integer | yes | e.g. `2` |
| `organization` | [`MemberOrganization`](#memberorganization) \| null | yes |  |

### MemberOrganization

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | yes | e.g. `12` |
| `slug` | string | yes | e.g. `"acme-industries"` |
| `code` | string | yes | e.g. `"482910"` |
| `name` | string | yes | e.g. `"Acme Industries"` |
| `type` | `industry` \| `ngo` \| `seller` | yes | e.g. `"industry"` |
| `status` | `pending` \| `approved` \| `rejected` \| `suspended` | yes | e.g. `"approved"` |
| `role` | `owner` \| `member` | yes | e.g. `"owner"` |

### Methodology

| Field | Type | Required | Notes |
|---|---|---|---|
| `factorVersion` | integer | yes | e.g. `1` |
| `updatedAt` | string | yes | e.g. `"2026-10-31T00:00:00.000Z"` |
| `caveat` | string | yes | e.g. `"Published averages, not measurements. India-weighted where India-specific data exists."` |
| `factors` | [`EmissionFactor`](#emissionfactor)[] | yes |  |

### MyOrganization

| Field | Type | Required | Notes |
|---|---|---|---|
| `organization` | [`Organization`](#organization) \| null | yes |  |
| `role` | `owner` \| `member` \| null | yes |  |

### MyRank

| Field | Type | Required | Notes |
|---|---|---|---|
| `rank` | integer,null | yes | e.g. `12` |
| `pointsTotal` | integer | yes | e.g. `1240` |
| `totalRanked` | integer | yes | e.g. `318` |
| `percentile` | number | yes | e.g. `96.2` |

### NextEvent

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | yes | e.g. `5` |
| `slug` | string | yes | e.g. `"beach-cleanup-versova"` |
| `title` | string | yes | e.g. `"Beach clean-up, Versova"` |
| `startAt` | string | yes | e.g. `"2026-11-02T01:30:00.000Z"` |
| `venueName` | string | yes | e.g. `"Versova Beach"` |
| `passReady` | boolean | yes | e.g. `true` |

### Notification

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | yes | e.g. `42` |
| `type` | string | yes | e.g. `"DAILY_REMINDER"` |
| `title` | string | yes | e.g. `"Time to Log Your Day! 🌱"` |
| `body` | string,null | yes | e.g. `"Keep your eco-streak alive. Log your habits today."` |
| `linkPath` | string,null | yes | e.g. `"/track"` |
| `readAt` | string,null | yes | e.g. `"2026-11-01T10:00:00.000Z"` |
| `createdAt` | string | yes | e.g. `"2026-11-01T09:00:00.000Z"` |

### OkMessage

| Field | Type | Required | Notes |
|---|---|---|---|
| `message` | string | yes | e.g. `"If that address exists, a link is on its way."` |

### OnboardingAnswers

| Field | Type | Required | Notes |
|---|---|---|---|
| `householdSize` | integer | no | e.g. `4`. range 1…15 |
| `city` | string | no | e.g. `"Mumbai"` |
| `regionCode` | string | no | e.g. `"IN-MH"` |
| `coolingUsage` | `none` \| `fan_only` \| `ac_occasional` \| `ac_daily` | no | e.g. `"ac_occasional"` |
| `dietType` | `vegan` \| `vegetarian` \| `eggetarian` \| `non_veg_weekly` \| `non_veg_daily` | no | e.g. `"vegetarian"` |
| `foodWasteLevel` | `low` \| `medium` \| `high` | no | e.g. `"low"` |
| `packagedFoodFreq` | `rarely` \| `sometimes` \| `often` | no | e.g. `"sometimes"` |
| `primaryCommuteMode` | `walk` \| `cycle` \| `bus` \| `metro_train` \| `two_wheeler` \| `car` \| `cab` \| `auto_rickshaw` \| `work_from_home` | no | e.g. `"metro_train"` |
| `vehicleFuel` | `petrol` \| `diesel` \| `cng` \| `electric` \| `not_applicable` | no | e.g. `"not_applicable"` |
| `commuteDistanceKm` | number | no | One way. Doubled and weighted 5/7 for the baseline.. e.g. `14.5`. range 0…200 |
| `flightsPerYear` | integer | no | e.g. `2`. range 0…50 |
| `electricityKwhMonth` | number,null | no | e.g. `240`. range 0…2000 |
| `electricityBillInr` | integer,null | no | range 0…∞ |
| `kwhSource` | `reported` \| `from_bill` \| `estimated` | no | e.g. `"reported"` |
| `cookingFuel` | `lpg` \| `png` \| `electric_induction` \| `firewood` | no | e.g. `"lpg"` |
| `hasSolar` | boolean | no | e.g. `false` |
| `waterUsageLevel` | `low` \| `medium` \| `high` | no | e.g. `"medium"` |
| `wasteHabit` | `segregate_and_compost` \| `segregate_only` \| `none` | no | e.g. `"segregate_only"` |

### OnboardingCompleteResult

| Field | Type | Required | Notes |
|---|---|---|---|
| `baseline` | [`Baseline`](#baseline) | yes |  |
| `wallet` | [`Wallet`](#wallet) | yes |  |
| `pointsAwarded` | integer | yes | e.g. `100` |
| `coinsAwarded` | integer | yes | e.g. `50` |

### OnboardingState

| Field | Type | Required | Notes |
|---|---|---|---|
| `completedSteps` | integer | yes | e.g. `3`. range 0…5 |
| `complete` | boolean | yes | e.g. `false` |
| `answers` | [`OnboardingAnswers`](#onboardinganswers) | yes |  |

### OnboardingStep1

| Field | Type | Required | Notes |
|---|---|---|---|
| `householdSize` | integer | yes | e.g. `4`. range 1…15 |
| `city` | string | yes | e.g. `"Mumbai"` |
| `regionCode` | string | yes | e.g. `"IN-MH"` |
| `coolingUsage` | `none` \| `fan_only` \| `ac_occasional` \| `ac_daily` | yes | e.g. `"ac_occasional"` |

### OnboardingStep2

| Field | Type | Required | Notes |
|---|---|---|---|
| `dietType` | `vegan` \| `vegetarian` \| `eggetarian` \| `non_veg_weekly` \| `non_veg_daily` | yes | e.g. `"vegetarian"` |
| `foodWasteLevel` | `low` \| `medium` \| `high` | yes | e.g. `"low"` |
| `packagedFoodFreq` | `rarely` \| `sometimes` \| `often` | yes | e.g. `"sometimes"` |

### OnboardingStep3

| Field | Type | Required | Notes |
|---|---|---|---|
| `primaryCommuteMode` | `walk` \| `cycle` \| `bus` \| `metro_train` \| `two_wheeler` \| `car` \| `cab` \| `auto_rickshaw` \| `work_from_home` | yes | e.g. `"metro_train"` |
| `vehicleFuel` | `petrol` \| `diesel` \| `cng` \| `electric` \| `not_applicable` | yes | e.g. `"not_applicable"` |
| `commuteDistanceKm` | number | yes | One way. Doubled and weighted 5/7 for the baseline.. e.g. `14.5`. range 0…200 |
| `flightsPerYear` | integer | yes | e.g. `2`. range 0…50 |

### OnboardingStep4

| Field | Type | Required | Notes |
|---|---|---|---|
| `electricityKwhMonth` | number,null | yes | e.g. `240`. range 0…2000 |
| `electricityBillInr` | integer,null | no | range 0…∞ |
| `kwhSource` | `reported` \| `from_bill` \| `estimated` | yes | e.g. `"reported"` |
| `cookingFuel` | `lpg` \| `png` \| `electric_induction` \| `firewood` | yes | e.g. `"lpg"` |
| `hasSolar` | boolean | yes | e.g. `false` |

### OnboardingStep5

| Field | Type | Required | Notes |
|---|---|---|---|
| `waterUsageLevel` | `low` \| `medium` \| `high` | yes | e.g. `"medium"` |
| `wasteHabit` | `segregate_and_compost` \| `segregate_only` \| `none` | yes | e.g. `"segregate_only"` |

### OnboardingStepBody

`[`OnboardingStep1`](#onboardingstep1) \| [`OnboardingStep2`](#onboardingstep2) \| [`OnboardingStep3`](#onboardingstep3) \| [`OnboardingStep4`](#onboardingstep4) \| [`OnboardingStep5`](#onboardingstep5)`

### Order

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | yes | e.g. `101` |
| `orderNumber` | string | yes | e.g. `"ECO-2026-00042"` |
| `items` | object[] | yes | Name and price are snapshots — a later rename never rewrites history |
| `subtotalPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `discountPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `totalPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `coinsSpent` | integer | yes | e.g. `480` |
| `status` | `placed` \| `confirmed` \| `shipped` \| `delivered` \| `cancelled` | yes | e.g. `"placed"` |
| `address` | [`Address`](#address) \| null | yes |  |
| `createdAt` | string | yes | e.g. `"2026-10-31T10:02:00.000Z"` |

### OrderSettlement

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | yes | e.g. `101` |
| `orderId` | integer | yes | e.g. `55` |
| `orderNumber` | string | yes | e.g. `"ECO-2026-00042"` |
| `orderItemId` | integer | yes | e.g. `72` |
| `productName` | string | yes | e.g. `"Bamboo Toothbrush (Pack of 4)"` |
| `sellerOrgId` | integer | yes | e.g. `12` |
| `sellerName` | string | yes | e.g. `"EcoLiving India"` |
| `saleAmountPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `coinsUsed` | integer | yes | e.g. `100` |
| `coinValuePaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `cashPaidPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `commissionRateBps` | integer | yes | e.g. `1000` |
| `salesCommissionPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `coinFeeRateBps` | integer | yes | e.g. `200` |
| `coinFeePaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `platformCommissionPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `sellerPayoutPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `status` | `pending` \| `settled` \| `cancelled` | yes | e.g. `"pending"` |
| `payoutId` | integer,null | yes |  |
| `settledAt` | string,null | yes |  |
| `createdAt` | string | yes | e.g. `"2026-11-01T10:00:00.000Z"` |

### Organization

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | yes | e.g. `7` |
| `slug` | string | yes | e.g. `"acme-industries"` |
| `code` | string | yes | e.g. `"482910"` |
| `name` | string | yes | e.g. `"Acme Industries"` |
| `type` | `industry` \| `ngo` \| `seller` | yes | Corporate · Community · Seller portal. e.g. `"industry"` |
| `status` | `pending` \| `approved` \| `rejected` \| `suspended` | yes | e.g. `"pending"` |
| `description` | string,null | yes | e.g. `"Packaging, 400 staff in Pune."` |
| `logoUrl` | string,null | yes |  |
| `websiteUrl` | string,null | yes | e.g. `"https://acme.example.com"` |
| `contactEmail` | string,null | yes | e.g. `"green@acme.example.com"` |
| `contactPhone` | string,null | yes | e.g. `"+912012345678"` |
| `city` | string,null | yes | e.g. `"Pune"` |
| `regionCode` | string,null | yes | e.g. `"IN-MH"` |
| `address` | string,null | no | e.g. `"Plot 42, MIDC, Pune"` |
| `memberCount` | integer | yes | e.g. `12` |
| `reviewNote` | string,null | yes |  |
| `verificationDetails` | object,null | no |  |
| `reviewedAt` | string,null | yes |  |
| `createdAt` | string | yes | e.g. `"2026-11-01T09:00:00.000Z"` |

### OrganizationAnalytics

| Field | Type | Required | Notes |
|---|---|---|---|
| `organizationId` | integer | yes |  |
| `totalFootprintKg` | number | yes | e.g. `1440.6` |
| `annualProjectedTonnes` | number | yes | e.g. `17.5` |
| `totalMembers` | integer | yes | e.g. `25` |
| `activeLoggers` | integer | yes | e.g. `18` |
| `avgPerEmployeeKg` | number | yes | e.g. `57.6` |
| `dailyPerCapitaKg` | number | yes | e.g. `5.8` |
| `urbanBenchmarkDailyKg` | number | yes | e.g. `7.2` |
| `reductionVsUrbanPct` | number | yes | e.g. `19.4` |
| `categories` | [`OrgCategoryBreakdown`](#orgcategorybreakdown) | yes |  |
| `monthlyTrend` | [`OrgMonthlyTrendItem`](#orgmonthlytrenditem)[] | yes |  |

### OrganizationLookupResult

| Field | Type | Required | Notes |
|---|---|---|---|
| `valid` | boolean | yes | e.g. `true` |
| `name` | string | yes | e.g. `"Acme Industries"` |
| `type` | `industry` \| `ngo` \| `seller` | yes | Corporate · Community · Seller portal. e.g. `"industry"` |
| `slug` | string | yes | e.g. `"acme-industries"` |
| `code` | string | yes | e.g. `"482910"` |

### OrganizationMember

| Field | Type | Required | Notes |
|---|---|---|---|
| `user` | [`UserSummary`](#usersummary) | yes |  |
| `email` | string (email) | no | e.g. `"colleague@acme.example.com"` |
| `role` | `owner` \| `member` | yes | e.g. `"owner"` |
| `joinedAt` | string | yes | e.g. `"2026-11-01T09:00:00.000Z"` |
| `shareFootprint` | boolean | no | e.g. `true`. default `true` |
| `onboardingStatus` | `completed` \| `pending` | yes | e.g. `"completed"` |
| `pointsTotal` | integer | no | e.g. `450` |
| `currentStreak` | integer | no | e.g. `5` |
| `baselineTotalKg` | number,null | no | e.g. `6.8` |
| `last30DaysTotalKg` | number,null | no | e.g. `142.5` |
| `avgDailyKg` | number,null | no | e.g. `4.75` |
| `reductionPct` | number,null | no | e.g. `12.5` |
| `lastActiveAt` | string,null | no | e.g. `"2026-10-31T18:30:00.000Z"` |

### OrganizationMemberList

| Field | Type | Required | Notes |
|---|---|---|---|
| `organization` | [`Organization`](#organization) | yes |  |
| `items` | [`OrganizationMember`](#organizationmember)[] | yes |  |

### OrgAnswerInput

| Field | Type | Required | Notes |
|---|---|---|---|
| `questionId` | integer | yes | e.g. `1` |
| `answer` | unknown | no | e.g. `"Engineering"` |

### OrgAnswerItem

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | yes | e.g. `10` |
| `questionId` | integer | yes | e.g. `1` |
| `questionPrompt` | string | yes | e.g. `"What department do you work in?"` |
| `questionType` | string | yes | e.g. `"single_choice"` |
| `questionVersion` | integer | yes | e.g. `1` |
| `answer` | unknown | no | e.g. `"Engineering"` |
| `answeredAt` | string | yes | e.g. `"2026-11-01T00:00:00.000Z"` |

### OrgCategoryBreakdown

| Field | Type | Required | Notes |
|---|---|---|---|
| `transportKg` | number | yes | e.g. `450.2` |
| `foodKg` | number | yes | e.g. `320.5` |
| `homeEnergyKg` | number | yes | e.g. `510` |
| `waterKg` | number | yes | e.g. `95.8` |
| `wasteKg` | number | yes | e.g. `64.1` |
| `transportPct` | number | yes | e.g. `31.3` |
| `foodPct` | number | yes | e.g. `22.2` |
| `homeEnergyPct` | number | yes | e.g. `35.4` |
| `waterPct` | number | yes | e.g. `6.7` |
| `wastePct` | number | yes | e.g. `4.4` |

### OrgEmployeeAnswers

| Field | Type | Required | Notes |
|---|---|---|---|
| `userId` | integer | yes | e.g. `7` |
| `organizationId` | integer | yes | e.g. `42` |
| `answers` | [`OrgAnswerItem`](#organsweritem)[] | yes |  |

### OrgMonthlyTrendItem

| Field | Type | Required | Notes |
|---|---|---|---|
| `month` | string | yes | e.g. `"2026-10"` |
| `totalKg` | number | yes | e.g. `1240.5` |
| `avgPerEmployeeKg` | number | yes | e.g. `62` |
| `activeLoggers` | integer | yes | e.g. `20` |

### OrgOnboardingQuestion

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | yes | e.g. `1` |
| `organizationId` | integer | yes | e.g. `42` |
| `prompt` | string | yes | e.g. `"What department do you work in?"` |
| `description` | string,null | no | e.g. `"Used for team impact reports"` |
| `type` | [`OrgQuestionType`](#orgquestiontype) | yes |  |
| `options` | array,null | no |  |
| `required` | boolean | yes | e.g. `true` |
| `sortOrder` | integer | yes | e.g. `0` |
| `version` | integer | yes | e.g. `1` |
| `active` | boolean | yes | e.g. `true` |
| `createdAt` | string | yes | e.g. `"2026-11-01T00:00:00.000Z"` |
| `updatedAt` | string | yes | e.g. `"2026-11-01T00:00:00.000Z"` |

### OrgOnboardingStatus

| Field | Type | Required | Notes |
|---|---|---|---|
| `organization` | [`Organization`](#organization) | yes |  |
| `questions` | [`OrgOnboardingQuestion`](#orgonboardingquestion)[] | yes |  |
| `answers` | [`OrgAnswerItem`](#organsweritem)[] | yes |  |
| `isCompleted` | boolean | yes | e.g. `true` |

### OrgQuestionType

Enum: `text` · `single_choice` · `multiple_choice` · `number` · `yes_no`

### OwnProfile

| Field | Type | Required | Notes |
|---|---|---|---|
| `user` | [`UserSummary`](#usersummary) | yes |  |
| `timezone` | string | yes | e.g. `"Asia/Kolkata"` |
| `wallet` | [`Wallet`](#wallet) | yes |  |
| `baseline` | [`Baseline`](#baseline) | yes |  |
| `answers` | [`OnboardingAnswers`](#onboardinganswers) | yes |  |
| `memberSince` | string | yes | e.g. `"2026-10-31T09:35:00.000Z"` |

### PageInfo

| Field | Type | Required | Notes |
|---|---|---|---|
| `nextCursor` | string,null | yes |  |
| `hasMore` | boolean | yes | e.g. `false` |

### PlaceOrderBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `offeredCoins` | integer | yes | e.g. `480`. range 0…∞ |
| `addressId` | integer | yes | e.g. `2` |
| `idempotencyKey` | string (uuid) | yes | e.g. `"0193f0b1-55aa-7c3d-8e21-9f0a1b2c3d4e"` |

### PredefinedNotificationBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `DAILY_REMINDER` \| `GOAL_COMPLETED` \| `COINS_EARNED` \| `EVENT_REMINDER` \| `TREE_MILESTONE` | yes | Predefined notification type. e.g. `"DAILY_REMINDER"` |
| `params` | object | no | Template parameter substitutions |

### PresignBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `purpose` | `avatar` \| `event_cover` | yes | e.g. `"event_cover"` |
| `contentType` | `image/jpeg` \| `image/png` \| `image/webp` | yes | e.g. `"image/jpeg"` |
| `sizeBytes` | integer | yes | e.g. `840122`. range 1…5242880 |

### PresignResult

| Field | Type | Required | Notes |
|---|---|---|---|
| `uploadUrl` | string | yes | e.g. `"https://storage.example.com/..."` |
| `publicUrl` | string | yes | Where the object will be readable once the PUT to `uploadUrl` succeeds. This is the Neon Object Storage endpoint for the branch, NOT a CDN and NOT cdn.ecolife.app — there is no CDN in front of the bucket today. The host varies per branch, so store the URL this call returns rather than reconstructing it.. e.g. `"https://br-dry-grass-a1og82ui.storage.c-1.ap-southeast-1.aws.neon.tech/uploads/covers/2026/01f7c2e4-6b3a-4f1e-9c80-2a5d8e3b7a11.webp"` |
| `expiresInSeconds` | integer | yes | e.g. `300` |

### Product

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | yes | e.g. `12` |
| `slug` | string | yes | e.g. `"tulsi-plant"` |
| `name` | string | yes | e.g. `"Tulsi plant, terracotta pot"` |
| `description` | string,null | yes | e.g. `"Grown without synthetic fertiliser."` |
| `category` | `plants` \| `household` \| `personal_care` \| `kitchen` \| `stationery` | yes | e.g. `"plants"` |
| `pricePaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `effectivePricePaise` | integer | no | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `imageUrl` | string,null | yes | e.g. `"https://images.unsplash.com/photo-1592150621744-aca64f48394a?auto=format&fit=crop&w=800&q=80"` |
| `images` | string[] | no | default `[]` |
| `stock` | integer | yes | e.g. `34` |
| `co2SavedKg` | number,null | yes | Why the product exists. Shown on the card.. e.g. `21.9` |
| `sellerOrgId` | integer,null | no |  |
| `sellerName` | string,null | no |  |
| `discountType` | `none` \| `percentage` \| `fixed` | no | e.g. `"percentage"`. default `"none"` |
| `discountValue` | integer | no | range 0…∞. default `0` |
| `discountStartDate` | string,null | no |  |
| `discountEndDate` | string,null | no |  |
| `allowCoinRedemption` | boolean | no | default `true` |
| `maxCoinRedemptionPercent` | integer | no | range 0…100. default `20` |
| `isActive` | boolean | no | default `true` |

### ProfilePatchBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `timezone` | string | no | e.g. `"Asia/Kolkata"` |
| `avatarUrl` | string,null (uri) | no | Any https URL the caller controls, or one returned by POST /uploads/presign.. e.g. `"https://images.unsplash.com/photo-1607346256330-dee7af15f7c5?auto=format&fit=facearea&facepad=3&w=256&h=256&q=70"` |
| `answers` | [`OnboardingAnswers`](#onboardinganswers) | no |  |

### PublicProfile

| Field | Type | Required | Notes |
|---|---|---|---|
| `user` | [`UserSummary`](#usersummary) | yes |  |
| `pointsTotal` | integer | yes | e.g. `1240` |
| `globalRank` | integer,null | yes | e.g. `12` |
| `currentStreak` | integer | yes | e.g. `12` |
| `eventsAttended` | integer | yes | e.g. `3` |
| `memberSince` | string | yes | e.g. `"2026-08-02T00:00:00.000Z"` |

### PushTokenBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `token` | string | yes | FCM device token. e.g. `"f-abc123xyz..."` |
| `platform` | `android` \| `ios` | no | Device OS platform. e.g. `"android"`. default `"android"` |

### Readiness

| Field | Type | Required | Notes |
|---|---|---|---|
| `service` | string | yes | e.g. `"ecolife-server"` |
| `database` | `reachable` | yes |  |
| `latencyMs` | integer | yes | e.g. `42` |

### RefreshBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `refreshToken` | string | no | Mobile sends this. Web sends the httpOnly cookie instead. |

### RegenerateCodeResult

| Field | Type | Required | Notes |
|---|---|---|---|
| `code` | string | yes | e.g. `"719302"` |
| `organization` | [`Organization`](#organization) | yes |  |

### Region

| Field | Type | Required | Notes |
|---|---|---|---|
| `code` | string | yes | e.g. `"IN-MH"` |
| `name` | string | yes | e.g. `"Maharashtra"` |
| `gridKgPerKwh` | number | yes | e.g. `0.71` |
| `tariffPaisePerKwh` | integer | yes | e.g. `950` |

### RegisterBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | e.g. `"Yusuf"` |
| `email` | string (email) | yes | e.g. `"yusuf@example.com"` |
| `password` | string | yes | e.g. `"correct horse battery"` |
| `phone` | string | no | e.g. `"+919876543210"` |
| `timezone` | string | no | e.g. `"Asia/Kolkata"`. default `"Asia/Kolkata"` |
| `organizationCode` | string | no | Optional 6-digit organization code to link user upon signup. e.g. `"482910"` |

### RegisterResult

| Field | Type | Required | Notes |
|---|---|---|---|
| `pass` | [`EventPass`](#eventpass) | yes |  |
| `event` | [`Event`](#event) | yes |  |

### ReorderOrgQuestionsBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `questionIds` | integer[] | yes |  |

### ResetPasswordBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `token` | string | yes |  |
| `password` | string | yes | e.g. `"correct horse battery"` |

### RevenueAnalytics

| Field | Type | Required | Notes |
|---|---|---|---|
| `grossMerchandiseValuePaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `totalCashCollectedPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `totalCoinDiscountPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `totalCoinsRedeemed` | integer | yes | e.g. `1250` |
| `platformRevenuePaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `platformSalesCommissionPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `platformCoinFeesPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `totalSellerPayoutsPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `pendingSellerPayoutsPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `settledSellerPayoutsPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `netPlatformCashFlowPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `monthlyBreakdown` | object[] | yes |  |

### ReviewOrganizationBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `decision` | `approve` \| `reject` \| `suspend` \| `reinstate` | yes | e.g. `"approve"` |
| `note` | string | no | e.g. `"GST certificate checked."` |
| `expected` | object | yes | The identity fields exactly as the review queue showed them. Compared inside the UPDATE, so an edit landing mid-decision is refused rather than approved unseen. |

### RewardEntry

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | yes | e.g. `9001` |
| `pointsDelta` | integer | yes | e.g. `200` |
| `coinsDelta` | integer | yes | e.g. `100` |
| `source` | `onboarding` \| `daily_log` \| `streak` \| `reduction` \| `goal` \| `event_attend` \| `event_host` \| `order` \| `order_refund` \| `admin` | yes | e.g. `"event_attend"` |
| `note` | string,null | yes | e.g. `"Beach clean-up, Versova"` |
| `createdAt` | string | yes | e.g. `"2026-10-30T07:12:00.000Z"` |

### RewardGrant

| Field | Type | Required | Notes |
|---|---|---|---|
| `pointsDelta` | integer | yes | e.g. `19` |
| `coinsDelta` | integer | yes | e.g. `9` |
| `reasons` | object[] | yes |  |

### ScanBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `passCode` | string | yes | e.g. `"yJ8kQ2mXp..."` |
| `scanClientId` | string (uuid) | yes | e.g. `"0193f0c4-11bb-7a2e-9d31-4e5f6a7b8c9d"` |

### ScanResult

| Field | Type | Required | Notes |
|---|---|---|---|
| `alreadyCheckedIn` | boolean | yes | e.g. `false` |
| `attendee` | [`UserSummary`](#usersummary) | yes |  |
| `checkedInAt` | string | yes | e.g. `"2026-11-02T02:12:00.000Z"` |
| `checkedInCount` | integer | yes | e.g. `13` |
| `capacity` | integer | yes | e.g. `100` |
| `attendeeReward` | [`RewardGrant`](#rewardgrant) \| null | yes | Null when already checked in — the reward was granted on the first scan |

### SellerAnalytics

| Field | Type | Required | Notes |
|---|---|---|---|
| `totalSalesVolumePaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `cashRevenuePaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `coinsRedeemedDiscountPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `totalCoinsRedeemed` | integer | yes | e.g. `1250` |
| `totalOrdersCount` | integer | yes | e.g. `45` |
| `totalUnitsSoldCount` | integer | yes | e.g. `88` |
| `activeProductsCount` | integer | yes | e.g. `12` |
| `topProducts` | object[] | yes |  |
| `monthlySales` | object[] | yes |  |

### SellerCommissionOverride

| Field | Type | Required | Notes |
|---|---|---|---|
| `sellerOrgId` | integer | yes | e.g. `42` |
| `sellerName` | string | yes | e.g. `"GreenRoot Organics"` |
| `commissionRateBps` | integer,null | yes | e.g. `800` |
| `commissionPercent` | number,null | yes | e.g. `8` |
| `effectiveCommissionRateBps` | integer | yes | e.g. `800` |
| `effectiveCommissionPercent` | number | yes | e.g. `8` |

### SellerCommissionOverrideBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `commissionRateBps` | integer,null | yes | Seller override in basis points (800 = 8%), or null to inherit global default. e.g. `800`. range 0…5000 |

### SellerOrder

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | yes | e.g. `101` |
| `orderNumber` | string | yes | e.g. `"ECO-2026-00042"` |
| `createdAt` | string | yes | e.g. `"2026-11-01T10:00:00.000Z"` |
| `status` | `placed` \| `confirmed` \| `shipped` \| `delivered` \| `cancelled` | yes | e.g. `"placed"` |
| `customer` | object | yes |  |
| `address` | [`Address`](#address) \| null | yes |  |
| `items` | [`SellerOrderItem`](#sellerorderitem)[] | yes |  |
| `sellerSubtotalPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `sellerCoinsSpent` | integer | yes | e.g. `100` |
| `sellerDiscountPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `sellerTotalPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |

### SellerOrderItem

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | yes | e.g. `1` |
| `productId` | integer | yes | e.g. `12` |
| `productName` | string | yes | e.g. `"Bamboo Toothbrush"` |
| `unitPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `quantity` | integer | yes | e.g. `2` |
| `totalPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `status` | `placed` \| `confirmed` \| `shipped` \| `delivered` \| `cancelled` | yes | e.g. `"placed"` |

### SellerPayout

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | yes | e.g. `10` |
| `payoutNumber` | string | yes | e.g. `"PAY-2026-00001"` |
| `sellerOrgId` | integer | yes | e.g. `12` |
| `sellerName` | string | yes | e.g. `"EcoLiving India"` |
| `totalAmountPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `settlementCount` | integer | yes | e.g. `5` |
| `status` | `pending` \| `processing` \| `completed` \| `failed` | yes | e.g. `"completed"` |
| `referenceNote` | string,null | yes | e.g. `"Bank NEFT Ref: N123456789"` |
| `processedBy` | integer,null | yes | e.g. `1` |
| `createdAt` | string | yes | e.g. `"2026-11-01T10:00:00.000Z"` |

### Session

| Field | Type | Required | Notes |
|---|---|---|---|
| `accessToken` | string | yes | e.g. `"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."` |
| `accessTokenExpiresIn` | integer | yes | seconds. e.g. `900` |
| `refreshToken` | string,null | yes | Non-null ONLY when the request carried `x-ecolife-platform: ios` or `android`. Without that header the caller is treated as a browser: the token is set as an httpOnly cookie and this field is null. It is not a bug — returning a 30-day credential where JS can read it would hand any XSS the whole account. |

### SettlementLedgerEntry

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | yes | e.g. `501` |
| `settlementId` | integer,null | yes | e.g. `101` |
| `orderId` | integer | yes | e.g. `55` |
| `orderNumber` | string | yes | e.g. `"ECO-2026-00042"` |
| `orderItemId` | integer,null | yes | e.g. `72` |
| `sellerOrgId` | integer | yes | e.g. `12` |
| `sellerName` | string | yes | e.g. `"EcoLiving India"` |
| `transactionType` | `sale_commission` \| `coin_subsidy` \| `coin_fee` \| `seller_payout` | yes | e.g. `"sale_commission"` |
| `amountPaise` | integer | yes | Integer paise. Never a float. 24000 = ₹240.00. e.g. `24000` |
| `status` | `pending` \| `settled` \| `cancelled` | yes | e.g. `"pending"` |
| `idempotencyKey` | string | yes | e.g. `"order:55:item:72:sale_commission"` |
| `note` | string,null | yes | e.g. `"Platform 10% commission on item 72"` |
| `createdAt` | string | yes | e.g. `"2026-11-01T10:00:00.000Z"` |

### StoredDailyAnswers

| Field | Type | Required | Notes |
|---|---|---|---|
| `vegMeals` | integer | no | e.g. `2`. range 0…10 |
| `nonVegMeals` | integer | no | e.g. `0`. range 0…10 |
| `veganMeals` | integer | no | e.g. `1`. range 0…10 |
| `acHoursBucket` | `0` \| `1_3` \| `4_8` \| `8_plus` | no | e.g. `"1_3"` |
| `bathChoice` | `bucket` \| `short_shower` \| `long_shower` | no | e.g. `"bucket"` |
| `wasteActions` | string[] | no |  |
| `trips` | [`StoredTrip`](#storedtrip)[] | no |  |

### StoredTrip

| Field | Type | Required | Notes |
|---|---|---|---|
| `mode` | string | yes | e.g. `"bus"` |
| `km` | number | yes | e.g. `14.5` |

### Streak

| Field | Type | Required | Notes |
|---|---|---|---|
| `current` | integer | yes | e.g. `12` |
| `longest` | integer | yes | e.g. `23` |

### SubmitLogBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `clientLogId` | string (uuid) | yes | e.g. `"0193f0a2-7c31-7b4e-9a51-6b2e0f3c4d55"` |
| `logDate` | string | yes | The user's LOCAL date. Must be today or yesterday in their timezone.. e.g. `"2026-10-31"` |
| `answers` | [`DailyAnswers`](#dailyanswers) | yes |  |

### SubmitOrgOnboardingAnswersBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `answers` | [`OrgAnswerInput`](#organswerinput)[] | yes |  |

### SystemSettings

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | yes | e.g. `1` |
| `defaultCommissionRateBps` | integer | yes | Commission in basis points (1000 = 10%). e.g. `1000`. range 0…5000 |
| `defaultCommissionPercent` | number | yes | Calculated commission percentage. e.g. `10` |
| `coinRedemptionFeeBps` | integer | yes | Fee on coin redemptions in bps (200 = 2%). e.g. `200`. range 0…2000 |
| `coinRedemptionFeePercent` | number | yes | Calculated coin fee percentage. e.g. `2` |
| `coinsPerRupee` | integer | yes | 10 coins = 1 Rupee. e.g. `10` |
| `coinValuePaise` | integer | yes | Value of 1 coin in paise. e.g. `10` |
| `maxDiscountPercent` | integer | yes | Max allowable coin redemption %. e.g. `20`. range 0…100 |
| `payoutHoldDays` | integer | yes | Settlement hold period in days. e.g. `7`. range 0…∞ |
| `updatedBy` | integer,null | yes | e.g. `1` |
| `updatedAt` | string | yes | e.g. `"2026-11-01T10:00:00.000Z"` |

### TrackToday

| Field | Type | Required | Notes |
|---|---|---|---|
| `date` | string | yes | e.g. `"2026-10-31"` |
| `existingLog` | object,null | yes |  |
| `askCooling` | boolean | yes | False when the profile reports no cooling. e.g. `true` |
| `defaults` | unknown | yes |  |

### Tree

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | yes | e.g. `7` |
| `slug` | string | yes | e.g. `"neem"` |
| `name` | string | yes | e.g. `"Neem"` |
| `description` | string | yes | e.g. `"Azadirachta indica. Shade, medicine and a mosquito deterrent."` |
| `rarity` | [`TreeRarity`](#treerarity) | yes |  |
| `imageUrl` | string | yes | e.g. `"https://images.unsplash.com/photo-1542601906990-b4d3fb778b09?auto=format&fit=crop&w=800&q=80"` |
| `growthStages` | [`GrowthStage`](#growthstage)[] \| null | yes | Null when the tree has one artwork and no progression. |
| `co2OffsetKgPerYear` | number | yes | Why a tree is the reward and not a sticker.. e.g. `48.5` |
| `isActive` | boolean | yes | e.g. `true` |

### TreeRarity

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | yes | e.g. `3` |
| `slug` | string | yes | e.g. `"rare"` |
| `name` | string | yes | e.g. `"Rare"` |
| `rank` | integer | yes | 1 is the most common tier; higher is rarer.. e.g. `3` |
| `dropWeight` | integer | yes | Relative likelihood, not a percentage. Divide by the sum of active tiers.. e.g. `100` |
| `isActive` | boolean | yes | e.g. `true` |

### Trip

| Field | Type | Required | Notes |
|---|---|---|---|
| `mode` | `walk` \| `cycle` \| `bus` \| `metro_train` \| `two_wheeler` \| `car` \| `cab` \| `auto_rickshaw` \| `work_from_home` | yes | e.g. `"bus"` |
| `km` | number | yes | e.g. `14.5`. range 0…500 |

### UpdateMembershipPreferencesBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `shareFootprint` | boolean | yes | e.g. `true` |

### UpdateMembershipPreferencesResult

| Field | Type | Required | Notes |
|---|---|---|---|
| `updated` | `true` | yes |  |
| `shareFootprint` | boolean | yes |  |

### UpdateOrganizationBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no | e.g. `"Acme Industries"` |
| `description` | string | no |  |
| `websiteUrl` | string (uri) | no |  |
| `contactEmail` | string (email) | no |  |
| `contactPhone` | string | no |  |
| `city` | string | no |  |
| `regionCode` | string | no |  |
| `address` | string | no |  |
| `verificationDetails` | object | no |  |
| `logoUrl` | string,null (uri) | no | Any https URL the caller controls, or one returned by POST /uploads/presign.. e.g. `"https://images.unsplash.com/photo-1607346256330-dee7af15f7c5?auto=format&fit=facearea&facepad=3&w=256&h=256&q=70"` |

### UpdateOrgQuestionBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | no |  |
| `description` | string,null | no |  |
| `type` | [`OrgQuestionType`](#orgquestiontype) | no |  |
| `options` | array,null | no |  |
| `required` | boolean | no |  |

### UpdateSellerOrderStatusBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `status` | `placed` \| `confirmed` \| `shipped` \| `delivered` \| `cancelled` | yes | e.g. `"placed"` |

### UpdateSellerProductBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no | e.g. `"Eco Bamboo Toothbrush"` |
| `slug` | string | no | e.g. `"eco-bamboo-toothbrush"` |
| `description` | string | no | e.g. `"100% biodegradable handle with charcoal bristles."` |
| `category` | `plants` \| `household` \| `personal_care` \| `kitchen` \| `stationery` | no | e.g. `"plants"` |
| `pricePaise` | integer | no | Base price in paise. e.g. `19900`. range 0…∞ |
| `imageUrl` | string,null (uri) | no | e.g. `"https://images.unsplash.com/photo-1592150621744"` |
| `images` | string[] | no | default `[]` |
| `stock` | integer | no | e.g. `50`. range 0…∞. default `0` |
| `co2SavedKg` | number,null | no | e.g. `0.5`. range 0…∞ |
| `discountType` | `none` \| `percentage` \| `fixed` | no | e.g. `"percentage"` |
| `discountValue` | integer | no | range 0…∞ |
| `discountStartDate` | string,null | no | e.g. `"2026-11-01T00:00:00.000Z"` |
| `discountEndDate` | string,null | no | e.g. `"2026-11-30T23:59:59.000Z"` |
| `allowCoinRedemption` | boolean | no |  |
| `maxCoinRedemptionPercent` | integer | no | range 0…100 |
| `isActive` | boolean | no |  |

### UpdateSystemSettingsBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `defaultCommissionRateBps` | integer | no | range 0…5000 |
| `coinRedemptionFeeBps` | integer | no | range 0…2000 |
| `coinsPerRupee` | integer | no |  |
| `coinValuePaise` | integer | no |  |
| `maxDiscountPercent` | integer | no | range 0…100 |
| `payoutHoldDays` | integer | no | range 0…∞ |

### UserSummary

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | yes | e.g. `7` |
| `name` | string | yes | e.g. `"Yusuf"` |
| `avatarUrl` | string,null | yes |  |
| `city` | string,null | yes | e.g. `"Mumbai"` |

### VerifyEmailBody

| Field | Type | Required | Notes |
|---|---|---|---|
| `token` | string | yes | e.g. `"a1b2c3…"` |

### Wallet

| Field | Type | Required | Notes |
|---|---|---|---|
| `pointsTotal` | integer | yes | e.g. `1240` |
| `coinsBalance` | integer | yes | e.g. `420` |

