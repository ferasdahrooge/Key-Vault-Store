/**
 * Password hashing (Argon2id) and password policy.
 * Passwords are NFKC-normalised before hashing/verifying so visually identical input matches.
 */
import { hash, verify } from '@node-rs/argon2';
import { HttpError } from '../../core/http.js';
import { COMMON_PASSWORDS } from './commonPasswords.js';

// @node-rs/argon2 exports Algorithm as a `const enum`, which esbuild/tsx cannot inline. 2 = Argon2id.
const ARGON2ID = 2;

// Argon2id cost: 64 MiB memory, 3 passes.
export const PASSWORD_HASH_OPTIONS = { algorithm: ARGON2ID, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

// Allowed password length range (in characters, not bytes).
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

// NFKC so look-alike Unicode forms hash the same.
const normalise = (pw: string) => pw.normalize('NFKC');

// Hashes a password for storage.
export async function hashPassword(password: string): Promise<string> {
  return hash(normalise(password), PASSWORD_HASH_OPTIONS);
}

// Checks a password against a stored hash; malformed hashes just fail.
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, normalise(password));
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;
/** Burns the same Argon2 work as a real verify, so unknown emails are not distinguishable by timing. */
export async function dummyVerify(password: string): Promise<void> {
  dummyHash ??= hash('kv-dummy-password-for-timing-equalisation', PASSWORD_HASH_OPTIONS);
  await verifyPassword(await dummyHash, password);
}

/** Returns a list of human-readable policy violations (empty = acceptable). Never echoes the password. */
export function checkPasswordPolicy(password: string, email?: string): string[] {
  const problems: string[] = [];
  const pw = normalise(password);
  const chars = [...pw];
  if (chars.length < PASSWORD_MIN) problems.push(`Password must be at least ${PASSWORD_MIN} characters`);
  if (chars.length > PASSWORD_MAX) problems.push(`Password must be at most ${PASSWORD_MAX} characters`);

  const lower = pw.toLowerCase();
  // Reject passwords containing the email's local part.
  const local = email?.split('@')[0]?.toLowerCase().normalize('NFKC') ?? '';
  if (local.length >= 3 && lower.includes(local)) problems.push('Password must not contain your email name');

  // Reject common passwords, even with digits/symbols tacked on the end.
  const stripped = lower.replace(/[\d\s!@#$%^&*()_+\-=.,?~`'"[\]{}|\\/:;<>]+$/u, '');
  if (COMMON_PASSWORDS.has(lower) || (stripped.length > 0 && COMMON_PASSWORDS.has(stripped))) {
    problems.push('Password is too common');
  } else if (new Set(chars).size < 5) {
    problems.push('Password needs more variety');
  }
  return problems;
}

/** Throws 400 weak_password with field errors when the policy is violated. */
export function assertPasswordPolicy(password: string, email?: string): void {
  const problems = checkPasswordPolicy(password, email);
  if (problems.length) {
    const err = new HttpError(400, 'weak_password', problems[0]);
    (err as HttpError & { fields: unknown }).fields = problems.map((message) => ({ path: 'password', message }));
    throw err;
  }
}
