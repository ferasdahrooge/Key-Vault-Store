import type { EnvRole } from '@prisma/client';
import type { AppConfig } from '../config/index.js';
import type { Db } from './db.js';

// Fields this app stores on the server-side session.
declare module 'express-session' {
  interface SessionData {
    /** Set only after password AND MFA succeeded. */
    userId?: string;
    /** Password verified, MFA pending. */
    pendingUserId?: string;
    /** Epoch ms of the last successful MFA (login or re-auth). */
    mfaAt?: number;
    /** Epoch ms of login, for the absolute session lifetime. */
    loginAt?: number;
    /** Pending WebAuthn challenge; single use, bound to its purpose, short-lived (see takeChallenge). */
    webauthnChallenge?: { challenge: string; purpose: 'login' | 'reauth' | 'register'; at: number };
    /** User is logged in but must still enroll an MFA factor (first login after invite). */
    mfaEnrollmentRequired?: boolean;
  }
}

// The signed-in user attached to req.user.
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
}

// Who performed an action: a browser user or a service token.
export type Actor = { type: 'user'; id: string } | { type: 'token'; id: string; envId: string; scopes: string[] };

/** Resolved by requireEnvRole for routes under /api/projects/:project/envs/:env. */
export interface EnvContext {
  projectId: string;
  projectSlug: string;
  envId: string;
  envSlug: string;
  protected: boolean;
  role: EnvRole;
}

// Extra properties our middleware attaches to Express requests.
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      actor?: Actor;
      envCtx?: EnvContext;
    }
  }
}

// Dependencies injected into createApp and every router.
export interface AppDeps {
  config: AppConfig;
  db: Db;
  /** Test-only: mounts POST /api/__test/login. createApp refuses it in production. */
  enableTestLogin?: boolean;
}
