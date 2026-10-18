/** Invite issuance, shared by POST /api/invites and scripts/create-admin.ts. */
import { Prisma } from '@prisma/client';
import type { Db } from '../../core/db.js';
import { randomToken, sha256hex } from '../../crypto/index.js';
import { HttpError } from '../../core/http.js';

// Invite links expire after 24 hours.
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

// Emails are compared and stored lowercase without surrounding spaces.
export const normaliseEmail = (e: string) => e.trim().toLowerCase();

/**
 * Creates the user in status 'invited' (or reuses an existing invited user, updating name/isAdmin),
 * revokes any earlier unused invites for them and issues a new single-use token.
 * Refuses (409) when an active or disabled user already has the email.
 */
export async function issueInvite(
  db: Db,
  appOrigin: string,
  input: { email: string; name: string; isAdmin?: boolean; createdBy?: string },
): Promise<{ userId: string; inviteUrl: string; expiresAt: Date }> {
  const email = normaliseEmail(input.email);
  const token = randomToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  let userId: string;
  try {
    // Create or refresh the invited user and replace any older unused invite atomically.
    userId = await db.$transaction(async (tx) => {
      const existing = await tx.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
      if (existing && existing.status !== 'invited') throw new HttpError(409, 'user_exists', 'A user with this email already exists');
      const user = existing
        ? await tx.user.update({ where: { id: existing.id }, data: { name: input.name, isAdmin: input.isAdmin ?? existing.isAdmin } })
        : await tx.user.create({ data: { email, name: input.name, isAdmin: input.isAdmin ?? false, status: 'invited' } });
      await tx.invite.deleteMany({ where: { userId: user.id, usedAt: null } });
      await tx.invite.create({
        data: { userId: user.id, tokenHash: sha256hex(token), expiresAt, createdBy: input.createdBy ?? user.id },
      });
      return user.id;
    });
  } catch (err) {
    // A concurrent invite for the same new email won the unique(email) race.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new HttpError(409, 'user_exists', 'A user with this email already exists');
    }
    throw err;
  }

  // Only the token's hash is stored; the plaintext goes out once in this URL.
  return { userId, inviteUrl: `${appOrigin.replace(/\/$/, '')}/invite/${token}`, expiresAt };
}

/** Looks up a usable (unused, unexpired, user still invited) invite by its plaintext token. */
export async function findUsableInvite(db: Db, token: string) {
  // Reject malformed tokens before touching the database.
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const invite = await db.invite.findUnique({ where: { tokenHash: sha256hex(token) }, include: { user: true } });
  if (!invite || invite.usedAt || invite.expiresAt.getTime() <= Date.now() || invite.user.status !== 'invited') return null;
  return invite;
}
