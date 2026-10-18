/**
 * Project / environment / membership helpers shared by the routers.
 * Membership rows with an expiresAt in the past are treated as absent everywhere.
 */
import type { EnvRole, Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { requireRecentMfa } from '../auth/auth.middleware.js';
import { newEnvironmentKey } from '../../crypto/index.js';
import type { Db } from '../../core/db.js';
import { HttpError } from '../../core/http.js';

type Tx = Prisma.TransactionClient;

// Role ordering: viewer < editor < owner.
export const ROLE_RANK: Record<EnvRole, number> = { viewer: 1, editor: 2, owner: 3 };

// True when `role` is at least as powerful as `min`.
export function roleAtLeast(role: EnvRole, min: EnvRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Prisma filter for memberships that are currently in force. */
export function activeMemberWhere(now = new Date()): Prisma.EnvironmentMemberWhereInput {
  return { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}

// In-memory version of activeMemberWhere for a single row.
export function isActiveMembership(m: { expiresAt: Date | null } | null | undefined, now = Date.now()): boolean {
  return !!m && (m.expiresAt === null || m.expiresAt.getTime() > now);
}

// Allowed slugs (lowercase, digits, dashes) and colours (name or #hex).
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const COLOR_RE = /^(?:[a-z]{1,20}|#[0-9a-fA-F]{6})$/;

// Fields needed to create an environment.
export interface EnvInput {
  slug: string;
  name: string;
  color?: string;
  protected?: boolean;
}

// Environments created with a new project when none are given.
export const DEFAULT_ENVIRONMENTS: EnvInput[] = [
  { slug: 'dev', name: 'Development', color: 'green', protected: false },
  { slug: 'staging', name: 'Staging', color: 'amber', protected: false },
  { slug: 'prod', name: 'Production', color: 'red', protected: true },
];

/** Creates an environment with a fresh DEK; `ownerId` becomes its owner. */
export async function createEnvironment(tx: Tx, projectId: string, input: EnvInput, ownerId: string) {
  const key = newEnvironmentKey();
  return tx.environment.create({
    data: {
      projectId,
      slug: input.slug,
      name: input.name,
      color: input.color ?? 'gray',
      protected: input.protected ?? false,
      wrappedDek: key.wrappedDek as Uint8Array<ArrayBuffer>,
      dekIv: key.dekIv as Uint8Array<ArrayBuffer>,
      dekTag: key.dekTag as Uint8Array<ArrayBuffer>,
      kekId: key.kekId,
      members: { create: { userId: ownerId, role: 'owner' } },
    },
    select: envPublicSelect,
  });
}

// Environment columns safe to expose (no key material).
export const envPublicSelect = {
  id: true,
  slug: true,
  name: true,
  color: true,
  protected: true,
} satisfies Prisma.EnvironmentSelect;

// Environment as returned by the API, with the caller's role.
export interface EnvPublic {
  id: string;
  slug: string;
  name: string;
  color: string;
  protected: boolean;
  role: EnvRole | null;
}

// Builds the public environment shape.
export function toEnvPublic(e: { id: string; slug: string; name: string; color: string; protected: boolean }, role: EnvRole | null): EnvPublic {
  return { id: e.id, slug: e.slug, name: e.name, color: e.color, protected: e.protected, role };
}

/** Loads projects with each environment and the caller's role. */
export async function projectsForUser(db: Db, user: { id: string; isAdmin: boolean }, slug?: string) {
  const now = new Date();
  const projects = await db.project.findMany({
    where: {
      ...(slug ? { slug } : {}),
      ...(user.isAdmin
        ? {}
        : { environments: { some: { members: { some: { userId: user.id, ...activeMemberWhere(now) } } } } }),
    },
    orderBy: { name: 'asc' },
    include: {
      environments: {
        orderBy: { createdAt: 'asc' },
        select: {
          ...envPublicSelect,
          members: { where: { userId: user.id, ...activeMemberWhere(now) }, select: { role: true } },
        },
      },
    },
  });
  return projects.map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description,
    environments: p.environments.map((e) => toEnvPublic(e, e.members[0]?.role ?? null)),
  }));
}

/** Resolves project/env slugs plus the user's in-force membership (null when none). */
export async function resolveEnv(db: Db, projectSlug: string, envSlug: string, userId: string) {
  const env = await db.environment.findFirst({
    where: { slug: envSlug, project: { slug: projectSlug } },
    select: {
      ...envPublicSelect,
      projectId: true,
      project: { select: { slug: true, name: true } },
      members: { where: { userId }, select: { role: true, expiresAt: true } },
    },
  });
  if (!env) return null;
  const m = env.members[0];
  return { env, membership: isActiveMembership(m) ? m! : null };
}

/** Synchronous recent-MFA check for conditional use inside handlers. */
export function assertRecentMfa(req: Request): void {
  requireRecentMfa(req, {} as Response, () => {});
}

// Error when a protected env change lacks the typed-back slug.
export function confirmRequired(): HttpError {
  return new HttpError(400, 'confirm_required', 'This environment is protected: confirm with the environment slug');
}

// Shorthand for a 409 with a specific code.
export function conflict(code: string, message: string): HttpError {
  return new HttpError(409, code, message);
}

// Reads a required route param (404 if missing).
export function param(req: Request, name: string): string {
  const v = (req.params as Record<string, string | undefined>)[name];
  if (typeof v !== 'string') throw new HttpError(404, 'not_found', 'Not found');
  return v;
}

// True for Prisma's unique-constraint error (P2002).
export function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}
