/**
 * Account lockout: after MAX_FAILURES consecutive failed password/MFA attempts the account is
 * locked for LOCK_MS. A fully successful login (password + MFA) resets the counter.
 */
import type { Db } from '../../core/db.js';

// Five failures in a row lock the account for 15 minutes.
export const MAX_FAILURES = 5;
export const LOCK_MS = 15 * 60 * 1000;

// True while the lock timestamp is still in the future.
export function isLocked(user: { lockedUntil: Date | null }, now = Date.now()): boolean {
  return !!user.lockedUntil && user.lockedUntil.getTime() > now;
}

/** Atomically records one failure. Returns true when this failure (newly) locked the account. */
export async function registerFailure(db: Db, userId: string): Promise<boolean> {
  const u = await db.user.update({ where: { id: userId }, data: { failedLogins: { increment: 1 } }, select: { failedLogins: true } });
  if (u.failedLogins < MAX_FAILURES) return false;
  await db.user.update({ where: { id: userId }, data: { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MS) } });
  return true;
}

// Clears the failure counter and any lock after a successful login.
export async function resetFailures(db: Db, userId: string): Promise<void> {
  await db.user.update({ where: { id: userId }, data: { failedLogins: 0, lockedUntil: null } });
}
