import { env } from '@config/env.ts';

/**
 * Verifying a Google access token (PRD-v2 §6.1).
 *
 * A Google ACCESS token is not an identity assertion — it is a bearer token
 * for Google's APIs, and any app can mint one for its own OAuth client. So two
 * calls, and both matter:
 *
 *   tokeninfo  — who was this token ISSUED TO? The audience check.
 *   userinfo   — which email does it carry, and is that email verified?
 *
 * Skipping tokeninfo is the classic break: userinfo happily describes the
 * owner of a token minted by somebody else's app, so an attacker could obtain
 * a token for their own client, present it here, and be handed an EcoLife
 * session for whichever Google account it belongs to. The audience check is
 * what ties the token to a client WE control.
 *
 * (An ID token would be verifiable offline by signature, which is cheaper and
 * stronger. The mobile client sends an access token, so this is what the
 * contract has to accept — the audience check is what makes it safe.)
 */

const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

/** Google is a third party on the network path; do not hang a request on it. */
const TIMEOUT_MS = 8_000;

export type GoogleIdentity = {
  email: string;
  name: string | null;
  avatarUrl: string | null;
};

/** Thrown for every rejection, so no caller can leak WHY to the client. */
export class GoogleAuthError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'GoogleAuthError';
  }
}

async function getJson(url: string, accessToken: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // Status only. The body can echo the token back, and this string reaches
    // the logs.
    throw new GoogleAuthError(`${url} responded ${res.status}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Google reports `email_verified` as a boolean from userinfo but as the STRING
 * `"true"` from some endpoints. Accept both; accept nothing else.
 */
function isVerified(v: unknown): boolean {
  return v === true || v === 'true';
}

/**
 * An avatar URL we are willing to store.
 *
 * It ends up in API responses and therefore in an `<img src>`, so a
 * `javascript:` or `data:` URL would be stored XSS waiting for a client that
 * renders it without checking. https only, and length-capped because the
 * column is unbounded text.
 */
function safeAvatarUrl(raw: unknown): string | null {
  const value = str(raw);
  if (!value || value.length > 500) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/** A display name from Google, or null to let the caller fall back. */
function safeName(info: Record<string, unknown>): string | null {
  const name = str(info.name) ?? str(info.given_name);
  return name ? name.slice(0, 80) : null;
}

/**
 * Verifies the token with Google and returns the identity it proves.
 *
 * Throws `GoogleAuthError` for every failure — bad token, foreign audience,
 * missing or unverified email, Google unreachable. The caller maps all of them
 * to one opaque response: which check failed is not the client's business, and
 * telling them turns this into an oracle for probing client ids.
 */
export async function verifyGoogleAccessToken(accessToken: string): Promise<GoogleIdentity> {
  const [tokenInfo, userInfo] = await Promise.all([
    getJson(TOKENINFO_URL, accessToken),
    getJson(USERINFO_URL, accessToken),
  ]);

  /**
   * The audience, under any of the four names Google has used for it.
   *
   * `aud` and `azp` come from the OAuth/OIDC specs; `audience` and `issued_to`
   * are the older tokeninfo spellings and are still returned. Checking only
   * `aud` passes tokens whose `aud` is absent but whose `azp` is ours, and —
   * worse — rejects nothing when the field is simply missing, so all four are
   * collected and at least one must match.
   */
  const presented = ['aud', 'azp', 'audience', 'issued_to']
    .map((k) => str(tokenInfo[k]))
    .filter((v): v is string => v !== null);

  if (presented.length === 0) {
    throw new GoogleAuthError('tokeninfo carried no audience');
  }

  const allowed = env.GOOGLE_OAUTH_CLIENT_IDS;
  if (!presented.some((id) => allowed.includes(id))) {
    // Do not log the ids presented: a token for someone else's client is not
    // ours to record. The count is enough to tell this apart from a malformed
    // response when reading logs.
    throw new GoogleAuthError(`token audience is not one of ours (${presented.length} presented)`);
  }

  const email = str(userInfo.email)?.toLowerCase() ?? null;
  if (!email) throw new GoogleAuthError('userinfo carried no email');

  /**
   * An unverified Google email proves nothing. Google permits unverified
   * addresses on some account types, and accepting one would let an attacker
   * claim any EcoLife account by signing up to Google with its address — the
   * account-takeover path this check exists to close.
   */
  if (!isVerified(userInfo.email_verified)) {
    throw new GoogleAuthError('google email is not verified');
  }

  return {
    email,
    name: safeName(userInfo),
    avatarUrl: safeAvatarUrl(userInfo.picture),
  };
}
