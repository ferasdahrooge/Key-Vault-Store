# Key Vault HTTP API contract

The server (`server/src/features/*/*.routes.ts`) and the SPA (`web/`) both implement against this contract. If you change a shape, update this file.

## Conventions

- All browser endpoints live under `/api`. They are authenticated by session cookie, and same-origin only.
- Every non-GET request must send the header `x-csrf-token: <token>`. Get the token from `GET /api/csrf` → `{ token }`, and fetch it again after login, logout and re-auth, because the session is regenerated.
- Errors use the shape `{ error: { code, message, fields?: [{path, message}] } }`. These codes have special meaning:
  - `401 unauthenticated`: redirect to login.
  - `401 session_expired`: redirect to login.
  - `401 reauth_required`: show the re-auth modal, then retry the request.
  - `403 mfa_enrollment_required`: go to the MFA enrollment screen.
  - `403 EBADCSRFTOKEN`: refetch the CSRF token and retry once.
  - `404 not_found`: also returned for environments you are not a member of.
- Timestamps are ISO strings, and IDs are UUIDs.
- Route params `:p` and `:e` are the project slug and environment slug.
- Roles are `viewer < editor < owner`. A global `isAdmin` flag is separate and grants no access to secrets.

## Auth (`features/auth/auth.routes.ts`, `features/invites/invites.routes.ts`)

| Method & path | Body | Response |
|---|---|---|
| POST /api/auth/login | `{ email, password }` | `{ mfaRequired: true, methods: ("totp"\|"passkey"\|"recovery")[] }`<br>or, for a first login with no MFA yet, `{ mfaEnrollmentRequired: true }` with a session in enrollment mode |
| GET /api/auth/providers | – | `{ google: bool }`. True when a Google OAuth client is configured. |
| POST /api/auth/google/start | `{ next? }` | `{ url }`: Google's authorization URL (PKCE, state, nonce kept in the session). 404 when Google is not configured. |
| POST /api/auth/google/callback | `{ code, state }` | Same as POST /api/auth/login, plus `next` if given to `/start`. Google replaces the password step only. On the first Google login, the Google account is linked once MFA (or enrollment) completes. |
| DELETE /api/auth/google | – | `{ ok }`. Unlinks the Google account; requires recent MFA. |
| POST /api/auth/mfa/totp | `{ code }` | `{ user }` |
| POST /api/auth/mfa/recovery | `{ code }` | `{ user, remainingCodes }` |
| POST /api/auth/mfa/passkey/options | – | WebAuthn `PublicKeyCredentialRequestOptionsJSON` |
| POST /api/auth/mfa/passkey/verify | `AuthenticationResponseJSON` | `{ user }` |
| POST /api/auth/reauth | `{ code }` (TOTP) or `{ passkey: AuthenticationResponseJSON }` | `{ ok: true, mfaAt: ISO }` |
| POST /api/auth/reauth/passkey/options | – | request options |
| POST /api/auth/logout | – | `{ ok: true }` |
| POST /api/auth/logout-all | – | `{ ok: true }` (destroys every session of the user) |
| GET /api/auth/me | – | `{ user: { id, email, name, isAdmin }, mfa: { totp: bool, passkeys: number, recoveryCodesLeft: number }, mfaAt: ISO\|null, loginAt: ISO\|null, mfaEnrollmentRequired: bool, googleLinked: bool }`. This route also works in enrollment mode. |
| GET /api/auth/mfa/passkeys | – | `{ passkeys: [{ id, name, createdAt, lastUsedAt }] }` |
| POST /api/auth/mfa/totp/enroll | – | `{ otpauthUrl, qrDataUrl, secret }` (unconfirmed; calling it again within 15 min returns the same seed) |
| POST /api/auth/mfa/totp/confirm | `{ code }` | `{ recoveryCodes?: string[] }` (shown once; only when the user had no unused codes). Clears enrollment mode. |
| POST /api/auth/mfa/passkey/register/options | – | creation options |
| POST /api/auth/mfa/passkey/register/verify | `{ response: RegistrationResponseJSON, name }` | `{ id, name, recoveryCodes?: string[] }` (codes only when the user had no unused codes). |
| DELETE /api/auth/mfa/passkeys/:id | – | `{ ok }` (requires recent MFA; at least one factor must remain) |
| POST /api/invites (admin) | `{ email, name, isAdmin? }` | `201 { inviteUrl, expiresAt }`. The URL is `${APP_ORIGIN}/invite/<token>`. Inviting an admin (`isAdmin: true`) requires recent MFA. |
| GET /api/invites/:token | – | `{ email, name }` (404 if expired or used) |
| POST /api/invites/:token/accept | `{ password }` | `{ mfaEnrollmentRequired: true }`. The user is logged in, in enrollment mode. |

**User** = `{ id, email, name, isAdmin }`

**Auth error codes:**

| Code | Meaning |
|---|---|
| `401 invalid_credentials` | Generic: unknown user, wrong password or disabled account |
| `423 account_locked` | Locked after 5 failures, including failed MFA attempts. Only returned once the password is proven (MFA and re-auth steps); the password step answers a locked account with the generic 401. |
| `401 invalid_code` | Wrong TOTP or recovery code |
| `401 code_already_used` | A genuine TOTP code whose 30 s window was already used (e.g. logging straight back in). Counts as a failed attempt; wait for the next code. Spaces and dashes in codes are ignored. |
| `401 invalid_passkey` | Passkey verification failed |
| `401 google_login_failed` | Generic Google failure: no matching active user, a different linked Google account, unverified email, wrong hosted domain, locked account, or a failed code exchange. The reason is in the audit log only. |
| `400 google_flow_expired` | Missing, stale (>10 min), reused or mismatched `state`; start again |
| `429 rate_limited` | Too many requests |
| `400 weak_password` | Password fails the policy |
| `409 user_exists` | An account with that email already exists |
| `409 totp_already_enrolled` | TOTP is already set up |
| `409 last_factor` | Can't remove the only MFA factor |
| `403 cannot_modify_self` | Admins can't disable or demote themselves |
| `409 last_admin` | The change would leave no active admin (e.g. two admins demoting each other at once) |
| `409 user_invited` | The user hasn't accepted their invite yet |

## Users directory (`features/users/users.routes.ts`)

| Method & path | Body | Response |
|---|---|---|
| GET /api/users/directory (any authenticated user) | `?q=` (min 2 chars) | `{ users: [{id,email,name}] }` (active users only, max 20), used for the member picker |

## Admin (`features/admin/admin.routes.ts`, admin only)

| Method & path | Body | Response |
|---|---|---|
| GET /api/admin/users | – | `{ users: [{ id, email, name, isAdmin, status, lockedUntil, createdAt }] }` |
| PATCH /api/admin/users/:id | `{ status?: "active"\|"disabled", isAdmin?, unlock?: true }` (recent MFA) | `{ user }`. Disabling a user also kills their sessions. |

## Projects & environments (`features/projects/projects.routes.ts`)

| Method & path | Body | Response |
|---|---|---|
| GET /api/projects | – | `{ projects: [{ id, slug, name, description, environments: [{ id, slug, name, color, protected, role \| null }] }] }`. Admins see every project; other users see only projects where they belong to at least one environment. Each environment's `role` is the caller's role, or null. |
| POST /api/projects (admin) | `{ slug, name, description?, environments?: [{slug,name,color?,protected?}] }` | `201 { project }`. Defaults to environments dev, staging and prod, with prod protected. The creator becomes owner of every environment. |
| GET /api/projects/:p | – | the project, same shape as one list item |
| POST /api/projects/:p/envs (admin) | `{ slug, name, color?, protected? }` | `201 { environment }` |
| PATCH /api/projects/:p/envs/:e (owner) | `{ name?, color?, protected?, confirm? }`. Protected environments require `confirm: envSlug`, or return 400 `confirm_required`. Turning protection off also requires recent MFA. `color` is one of the palette names green, amber, red, blue, violet, cyan, pink or slate. | `{ environment }` |
| POST /api/projects/:p/envs/:e/rotate-key (owner, recent MFA) | `{ confirm? }` (protected environments require `confirm: envSlug`) | `{ ok, dekVersion, reencrypted }` — new DEK, re-encrypts every version in one transaction |
| POST /api/projects/:p/envs/:e/access-requests | `{ role, reason, durationMin }` | see Access requests |
| GET /api/projects/:p/compare?envs=dev,prod | – | `{ envs: string[], keys: [{ key, presence: { [envSlug]: { exists, version, updatedAt } \| null } }] }`. Covers only environments the caller is a member of, and never includes values. |

**Environment** = `{ id, slug, name, color, protected, role }`

## Secrets (`features/secrets/secrets.routes.ts`, mounted by the projects router)

Base path: `/api/projects/:p/envs/:e/secrets`

| Method & path | Role | Body | Response |
|---|---|---|---|
| GET `` | viewer | `?q=&tag=&type=` | `{ secrets: SecretMeta[] }` (never values) |
| POST `` | editor | `{ key, value, type?, description?, tags?, expiresAt? }` | `201 { secret: SecretMeta }`. Key must match `^[A-Za-z_][A-Za-z0-9_.-]{0,127}$`, and the value can be at most 64 KB. |
| GET `/:id` | viewer | – | `{ secret: SecretMeta }` |
| PATCH `/:id` | editor | `{ value?, type?, description?, tags?, expiresAt?, comment? }` | `{ secret }`. A `value` creates a new version. In a protected environment the body must also include `confirm: "<envSlug>"`. |
| DELETE `/:id` | editor | protected environments need `?confirm=<envSlug>` | `{ ok }` (soft delete) |
| POST `/:id/reveal` | viewer | `{ version? }` | `{ value, version }`. Audited. Protected environments require recent MFA. |
| GET `/:id/versions` | viewer | – | `{ versions: [{ version, createdAt, createdBy: {id,name}\|null, comment }] }` |
| POST `/:id/rollback/:version` | editor | `{ confirm? }` | `{ secret }`. Creates a new version that copies the old value. |

**SecretMeta** = `{ id, key, type, description, tags, currentVersion, expiresAt, createdAt, updatedAt, updatedBy: {id,name}|null }`
**type** is one of `password | apikey | connstr | cert | note | json`.

## Members (`/api/projects/:p/envs/:e/members`, owner unless noted)

| Method & path | Body | Response |
|---|---|---|
| GET `` (viewer+) | – | `{ members: [{ user: {id,email,name}, role, expiresAt }] }` |
| PUT `/:userId` | `{ role }` (recent MFA) | `{ member }`. Upserts: this is also how members are added. Returns 409 `last_owner` if it would demote the last owner. |
| DELETE `/:userId` | – (recent MFA) | `{ ok }`. Returns 409 `last_owner` for the last active owner. |

An admin adding themselves to an environment is allowed, but it is audited as `member.admin_self_grant`.

## Access requests (`features/access-requests/accessRequests.routes.ts`)

| Method & path | Body | Response |
|---|---|---|
| POST /api/projects/:p/envs/:e/access-requests (any authenticated user) | `{ role, reason, durationMin }` | `201 { request }` |
| GET /api/access-requests | – | `{ mine: AccessRequest[], toDecide: AccessRequest[] }`. `toDecide` lists requests for environments the caller owns. |
| POST /api/access-requests/:id/decide (owner of env) | `{ approve: boolean }` | `{ request }`. On approval, adds a time-boxed member using `expiresAt`. If the user's permanent role already covers the request, approval changes nothing. If their permanent role is lower, it returns 409 `already_member` (a permanent role is never replaced by a time-boxed one). You can't decide your own request. |

**AccessRequest** = `{ id, project:{slug,name}, env:{slug,name}, user:{id,name,email}, role, reason, durationMin, status, createdAt, decidedAt }`

## Service tokens (`/api/projects/:p/envs/:e/tokens`, owner)

| Method & path | Body | Response |
|---|---|---|
| GET `` | – | `{ tokens: [{ id, name, prefix, scopes, ejsonPublicKey, expiresAt, lastUsedAt, revokedAt, createdAt }] }` |
| POST `` | `{ name, scopes: ("read"\|"export")[], ejsonPublicKey?, expiresInDays? }` (recent MFA) | `201 { token: "kv_st_…", meta }`. The token is shown once. |
| DELETE `/:id` | – | `{ ok }` (revoke) |

## ejson exchange (`features/exchange/exchange.routes.ts`)

| Method & path | Role | Body | Response |
|---|---|---|---|
| GET /api/import-key | auth | – | `{ publicKey }`, the server import public key (hex) |
| POST /api/projects/:p/envs/:e/export | owner + recent MFA | `{ recipientPublicKey, keys?: string[] }` | `application/json` attachment `secrets.<env>.ejson`, encrypted to the recipient |
| POST /api/projects/:p/envs/:e/import/preview | editor | `{ ejson: string }` (file contents, encrypted to the import key) | `{ changes: [{ key, status: "new"\|"changed"\|"unchanged" }], rejected: [{ path, reason }] }` |
| POST /api/projects/:p/envs/:e/import/commit | editor | `{ ejson: string, confirm? }` | `{ created, updated, unchanged, rejected: [{ path, reason }] }` |

- **Import mapping**: top-level string fields become secrets. Anything nested deeper than 8 levels is rejected with reason `too_deep`. Nested objects are flattened with `__`, so `{"db":{"password":"x"}}` becomes `db__password`. Keys starting with `_` are ignored. Each value must be ejson-encrypted, or it is rejected.
- **Export mapping**: the inverse, flat. Secrets named exactly `_public_key` or `_kv_meta` are left out because they would collide with document fields. The document includes `_public_key`, `_kv_meta: { project, env, exportedAt }`, and one field per secret.

## Machine API (`features/service-api/serviceApi.routes.ts`): `Authorization: Bearer kv_st_…`

| Method & path | Scope | Response |
|---|---|---|
| GET /api/v1/secrets | read | `{ project, env, secrets: { KEY: value } }`. If the token has an `ejsonPublicKey`, the response is an ejson document encrypted to that key instead. |
| GET /api/v1/secrets.ejson?pub=<hex> | export | ejson document encrypted to `pub`, or to the token's registered key |

Every call is audited (`token.use`). Bearer-auth failures return these codes:

| Code | When |
|---|---|
| `401 invalid_token` | The token is unknown, revoked or expired |
| `401 token_inactive` | The token's creator is disabled or is no longer an owner of the environment |
| `403 insufficient_scope` | The token lacks the scope this call needs |
| `429 rate_limited` | More than 60 requests per minute for this token, or too many failed auths from this IP |

## Audit (`features/audit/audit.routes.ts`)

| Method & path | Who | Response |
|---|---|---|
| GET /api/audit?envId=&actorId=&action=&before=&limit= | Admins see everything. Environment owners see only their environments, and must pass `envId`. | `{ entries: [{ seq, at, actorType, actorId, actor: {id,name,email}\|null, action, projectId, envId, secretId, ip, meta }], nextBefore }` |
| GET /api/audit/verify | admin | `{ ok, checked, brokenAtSeq? }` |
| GET /api/audit/export.jsonl | admin | NDJSON stream |

## Audit action names

| Area | Actions |
|---|---|
| Auth | `auth.login.success`, `auth.login.failed`, `auth.login.locked`, `auth.mfa.success`, `auth.mfa.failed`, `auth.reauth`, `auth.logout`, `auth.logout_all`, `auth.mfa.totp_enrolled`, `auth.mfa.passkey_added`, `auth.mfa.passkey_removed`, `auth.recovery_code_used`, `auth.google.linked`, `auth.google.unlinked`. Google logins add `meta.via: "google"` to `auth.login.*`. |
| Users and invites | `invite.created`, `invite.accepted`, `user.updated` |
| Projects and environments | `project.created`, `env.created`, `env.updated`, `env.dek_rotated`, `system.kek_rotated` |
| Secrets | `secret.created`, `secret.updated`, `secret.deleted`, `secret.reveal`, `secret.rollback` |
| Members and access | `member.set`, `member.removed`, `member.admin_self_grant`, `member.admin_self_grant.notice` (one per active owner, `meta: { ownerId, adminId, role }`), `access.requested`, `access.decided` |
| Tokens and exchange | `token.created`, `token.revoked`, `token.use`, `export.ejson`, `import.ejson` |

Secret values are never written to audit `meta`. `meta` may contain key names, versions and counts.
