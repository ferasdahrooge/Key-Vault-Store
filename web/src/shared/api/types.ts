// TypeScript mirrors of docs/API.md. Keep in sync with the contract.
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';

export type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
};

// Environment roles, lowest to highest.
export type Role = 'viewer' | 'editor' | 'owner';
export const ROLES: readonly Role[] = ['viewer', 'editor', 'owner'] as const;

// The signed-in user.
export interface User {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
}

// Minimal user reference (who changed something).
export interface UserRef {
  id: string;
  name: string;
}

// A user as shown in the member picker.
export interface DirectoryUser {
  id: string;
  email: string;
  name: string;
}

// Second factors a user can log in with.
export type MfaMethod = 'totp' | 'passkey' | 'recovery';

// After the password step: either MFA or enrollment is next.
export type LoginResponse =
  | { mfaRequired: true; methods: MfaMethod[] }
  | { mfaEnrollmentRequired: true };

/** Google callback: same as password login, plus the return path given to /google/start. */
export type GoogleLoginResponse = LoginResponse & { next?: string };

// Optional sign-in providers.
export interface AuthProviders {
  google: boolean;
}

// GET /api/auth/me.
export interface MeResponse {
  user: User;
  mfa: { totp: boolean; passkeys: number; recoveryCodesLeft: number };
  mfaAt: string | null;
  loginAt: string | null;
  /** True while the session is in enrollment mode (no MFA factor yet). /me works in this mode. */
  mfaEnrollmentRequired: boolean;
  /** A Google account is linked for sign-in. */
  googleLinked: boolean;
}

// Data for setting up an authenticator app.
export interface TotpEnrollResponse {
  otpauthUrl: string;
  qrDataUrl: string;
  secret: string;
}

// A newly added passkey (plus recovery codes on first factor).
export interface PasskeyRegisterResponse {
  id: string;
  name: string;
  recoveryCodes?: string[];
}

// A registered passkey.
export interface PasskeyInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

// An environment with the caller's role (null = not a member).
export interface Environment {
  id: string;
  slug: string;
  name: string;
  color: string;
  protected: boolean;
  role: Role | null;
}

// A project with its environments.
export interface Project {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  environments: Environment[];
}

// Fields for creating an environment.
export interface NewEnvironmentInput {
  slug: string;
  name: string;
  color?: string;
  protected?: boolean;
}

// Key presence per environment.
export interface CompareResponse {
  envs: string[];
  keys: {
    key: string;
    presence: Record<string, { exists: boolean; version: number; updatedAt: string } | null>;
  }[];
}

// Kinds of secret.
export type SecretType = 'password' | 'apikey' | 'connstr' | 'cert' | 'note' | 'json';
export const SECRET_TYPES: readonly SecretType[] = ['password', 'apikey', 'connstr', 'cert', 'note', 'json'] as const;

// Secret metadata (never the value).
export interface SecretMeta {
  id: string;
  key: string;
  type: SecretType;
  description: string | null;
  tags: string[];
  currentVersion: number;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: UserRef | null;
}

// One entry in a secret's history.
export interface SecretVersion {
  version: number;
  createdAt: string;
  createdBy: UserRef | null;
  comment: string | null;
}

// An environment member.
export interface Member {
  user: DirectoryUser;
  role: Role;
  expiresAt: string | null;
}

// State of an access request.
export type AccessRequestStatus = 'pending' | 'approved' | 'denied' | 'expired' | (string & {});

// An access request as shown in the UI.
export interface AccessRequest {
  id: string;
  project: { slug: string; name: string };
  env: { slug: string; name: string };
  user: { id: string; name: string; email: string };
  role: Role;
  reason: string;
  durationMin: number;
  status: AccessRequestStatus;
  createdAt: string;
  decidedAt: string | null;
}

// What a service token may do.
export type TokenScope = 'read' | 'export';

// Service token metadata (never the token itself).
export interface ServiceTokenMeta {
  id: string;
  name: string;
  prefix: string;
  scopes: TokenScope[];
  ejsonPublicKey: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

// Result of an import dry run.
export interface ImportPreview {
  changes: { key: string; status: 'new' | 'changed' | 'unchanged' }[];
  rejected: { path: string; reason: string }[];
}

// Counts after applying an import.
export interface ImportCommitResult {
  created: number;
  updated: number;
  unchanged: number;
}

// A user as shown in the admin panel.
export interface AdminUser {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  status: 'active' | 'disabled' | (string & {});
  lockedUntil: string | null;
  createdAt: string;
}

// One audit log row.
export interface AuditEntry {
  seq: number;
  at: string;
  actorType: string;
  actor: { id: string; name: string; email: string } | null;
  action: string;
  projectId: string | null;
  envId: string | null;
  secretId: string | null;
  ip: string | null;
  meta: Record<string, unknown> | null;
}

// A page of audit entries plus the cursor for the next one.
export interface AuditPage {
  entries: AuditEntry[];
  nextBefore: number | string | null;
}

// Result of verifying the audit chain.
export interface AuditVerify {
  ok: boolean;
  checked: number;
  brokenAtSeq?: number;
}
