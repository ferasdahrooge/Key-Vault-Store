/** Password generator for secret values and strength hints for account passwords. */
// Look-alike characters (l, I, O, 0, 1) are left out so generated values are easy to read back.
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '-_.~!@#%^*+=';

// Default character set for generated secrets.
export const DEFAULT_CHARSET = LOWER + UPPER + DIGITS + SYMBOLS;

// Source of random numbers (injectable for tests).
type RandomSource = (buf: Uint32Array<ArrayBuffer>) => unknown;
const defaultRandom: RandomSource = (buf) => {
  crypto.getRandomValues(buf);
};

/** Uniform random integer in [0, max) using rejection sampling (no modulo bias). */
function randomInt(max: number, random: RandomSource): number {
  // Values at or above `limit` would make low results more likely, so they are redrawn.
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    random(buf);
    const v = buf[0]!;
    if (v < limit) return v % max;
  }
}

/**
 * Generates a random password with crypto.getRandomValues.
 * Guarantees at least one char from each class when the default charset is used.
 */
export function generatePassword(length = 32, charset = DEFAULT_CHARSET, random: RandomSource = defaultRandom): string {
  if (length < 1) throw new Error('length must be positive');
  if (charset.length < 2) throw new Error('charset too small');
  const classes = charset === DEFAULT_CHARSET ? [LOWER, UPPER, DIGITS, SYMBOLS] : [];
  for (let attempt = 0; attempt < 100; attempt++) {
    let out = '';
    for (let i = 0; i < length; i++) out += charset[randomInt(charset.length, random)];
    if (length < classes.length || classes.every((c) => [...out].some((ch) => c.includes(ch)))) return out;
  }
  throw new Error('could not generate password');
}

// One password hint and whether it passes.
export interface StrengthCheck {
  id: string;
  label: string;
  ok: boolean;
  required: boolean;
}

// Same minimum as the server policy.
export const MIN_PASSWORD_LENGTH = 12;

/** Hints for account passwords. Only length (and not containing the email name) is required. */
export function passwordChecks(pw: string, email = ''): StrengthCheck[] {
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  return [
    { id: 'len', label: `At least ${MIN_PASSWORD_LENGTH} characters`, ok: pw.length >= MIN_PASSWORD_LENGTH, required: true },
    {
      id: 'email',
      label: 'Does not contain your email name',
      ok: !(local.length >= 3 && pw.toLowerCase().includes(local)),
      required: true,
    },
    { id: 'case', label: 'Mixes upper and lower case', ok: /[a-z]/.test(pw) && /[A-Z]/.test(pw), required: false },
    { id: 'digit', label: 'Contains a number', ok: /\d/.test(pw), required: false },
    { id: 'symbol', label: 'Contains a symbol', ok: /[^A-Za-z0-9]/.test(pw), required: false },
    { id: 'long', label: '16+ characters (recommended)', ok: pw.length >= 16, required: false },
  ];
}

// 0–4 score for the strength meter.
export function passwordScore(pw: string, email = ''): 0 | 1 | 2 | 3 | 4 {
  if (!pw) return 0;
  const checks = passwordChecks(pw, email);
  if (checks.some((c) => c.required && !c.ok)) return 1;
  const optional = checks.filter((c) => !c.required && c.ok).length;
  return optional >= 4 ? 4 : optional >= 2 ? 3 : 2;
}
