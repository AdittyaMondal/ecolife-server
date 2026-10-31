/**
 * Password hashing (PRD-v2 §6.1, CLAUDE.md §4.7).
 *
 * argon2id via Bun's built-in — memory-hard, so a stolen hash resists GPU
 * cracking in a way bcrypt no longer reliably does. No dependency.
 *
 * NOTE: `Bun.password` does not exist on Node. This is the single hard Bun
 * dependency in the codebase, so a Node host would need node:crypto scrypt
 * or an argon2 package. The deployment target is the Bun container image.
 */
export function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, { algorithm: 'argon2id' });
}

/**
 * Always returns a boolean, never throws.
 *
 * A malformed or truncated hash in the database would otherwise throw and
 * surface as a 500, which tells an attacker that this particular account
 * exists and is broken. A failed verify is a failed verify.
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(plain, hash);
  } catch {
    return false;
  }
}

/**
 * Burn roughly the same time as a real verify when the account does not exist.
 *
 * Without this, "unknown email" returns in ~1ms and "wrong password" in
 * ~100ms, and that gap is a free account-enumeration oracle regardless of how
 * carefully the error messages are matched.
 */
const DUMMY_HASH = await hashPassword(crypto.randomUUID());

export async function equaliseTiming(): Promise<void> {
  await verifyPassword('not-a-real-password', DUMMY_HASH);
}
