# Security

This document describes Key Vault's security model: what it protects against, how it does it,
and its known limits. Section G of [docs/architecture.excalidraw](docs/architecture.excalidraw)
is a visual summary.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting instead
(the repository's **Security** tab → **Report a vulnerability**), with a description, reproduction steps and the affected version or commit. We aim to acknowledge
reports within 3 working days and to agree on a disclosure date with you. Never send real
secrets, private keys or production data.

**In scope**: the server (`server/`), the web client (`web/`), the Dockerfile and the
crypto/key-management scripts.
**Out of scope**: attacks that need root on the vault host or the ejson private key (see the
trust assumption below), denial of service by volume, social engineering, and vulnerabilities in
unmodified third-party dependencies that are already publicly known (report those upstream).

## Trust assumption

Encryption happens **on the server**. The vault host decrypts the master KEK into memory at
boot, and it sees plaintext while it serves reveals and exports. The design protects data at rest
(database, backups, git), data in transit and the application layer. **It does not protect against
an attacker with full control of the running server process or host.** Such an attacker can read
the in-memory KEKs and cached DEKs. Run the server on a dedicated, least-privilege host.

## Threat model

| Threat | Mitigation |
|---|---|
| Database dump or backup leaked | Every secret value is AES-256-GCM ciphertext. The KEK is not in the database. TOTP seeds are encrypted. Service tokens, invites and recovery codes are stored only as hashes. |
| Git repository leaked | ejson files contain only ciphertext plus the public key. The private key is never committed or baked into the image (`.gitignore`, `.dockerignore`). |
| Ciphertext row swap or tampering | The GCM tag plus AAD binds each ciphertext to its environment, secret, version and key name. A swapped row fails to decrypt. |
| Stolen session cookie | The cookie is `__Host-` prefixed, HttpOnly, Secure and SameSite=Strict. Sessions end after 15 min idle or 8 h absolute. Sensitive operations need re-auth. Users can log out all sessions. |
| CSRF | A csrf-sync synchronizer token is required on every non-GET request, in addition to SameSite=Strict. |
| Credential stuffing or brute force | Argon2id, mandatory MFA, a per-IP rate limit, a 15 min lockout after 5 failures, a common-password check and generic error messages. |
| Environment enumeration | Non-members get a 404 that is identical to the response for a missing environment. |
| Insider admin | Admin gives no implicit secret access. Self-grants are audited and the environment's owners are alerted. |
| XSS or clickjacking | A strict CSP (`script-src 'self'`, `frame-ancestors 'none'`), React escaping, and no `dangerouslySetInnerHTML`. |
| Secrets leaking to logs or caches | pino redaction (headers, bodies, and invite tokens in URL paths), no values in audit metadata, `Cache-Control: no-store` on the API, and values only via `POST …/reveal`, one per call. |
| Shoulder surfing or clipboard | Values are masked by default, re-masked after 30 s, and the clipboard is cleared after 30 s. The UI also locks when idle. |
| Leaked service token | Stored as SHA-256 only. Tokens have scopes, expiry and revocation, and every use is audited with `lastUsedAt`. A token stops working when its creator loses ownership. |
| Audit tampering | Hash chain, an append-only database trigger and `GET /api/audit/verify`. |
| AES-GCM nonce exhaustion | Each environment has its own DEK with an encryption counter. The DEK rotates automatically at 2^30 encryptions. |
| Loss of the ejson private key | **Availability risk.** Back the key up separately and offline. Without it the data is unrecoverable. |
| Full server compromise | **Accepted risk** of server-side encryption (see above). Reduced by KEK/DEK rotation, least-privilege hosting and a read-only, non-root container. |

## Cryptography

### Key hierarchy

```
ejson keypair (Curve25519, private key in the keydir, never in git or the image)
 └─ decrypts config/secrets.<env>.ejson in memory (NaCl box: X25519 + XSalsa20-Poly1305)
     └─ master_kek.<kid>     32-byte KEKs, `_active_kek` selects the one used for new wraps
         ├─ DEK per environment     AES-256-GCM key, wrapped by a KEK (wrappedDek, iv, tag, kekId)
         │   └─ secret values       AES-256-GCM, 96-bit random IV, 128-bit tag
         └─ system key = HKDF-SHA256(KEK, info "kv-system")  →  seals TOTP seeds
```

- **ejson**: a secrets file uses the same format as Shopify ejson. Each value is encrypted with
  NaCl `box` from an ephemeral keypair to the file's `_public_key`. Keys that start with `_` are
  left in plaintext. The server decrypts the file only in memory at boot, validates it with zod
  and freezes it. If anything is missing or invalid, the server **fails closed** and reports
  paths only, never values.
- **Envelope encryption**: each secret version is encrypted with its environment's DEK using
  AES-256-GCM, with AAD `kv1|envId|secretId|version|key`. The AAD makes ciphertext
  non-transplantable between rows, versions or key names. DEKs are wrapped with the active KEK.
  Unwrapped DEKs are cached briefly (60 s TTL) and zeroed when evicted.
- **System key**: HKDF-SHA256 of each KEK with info `kv-system`. It encrypts server-owned
  material such as TOTP seeds, with a per-record context string.
- **Rotation**:
  - DEK rotation (`POST …/rotate-key`, or automatic at 2^30 encryptions) re-encrypts every
    version of the environment in one transaction.
  - KEK rotation (`npm run rotate:kek -w server`) re-wraps DEKs and re-seals TOTP seeds without
    touching the secret values.
  - ejson keypair rotation re-encrypts the secrets file.

  The procedures are in [README.md](README.md#runbooks).
- **Import/export**: exports are ejson documents encrypted to a recipient public key that the
  owner supplies. Imports must be encrypted to the server's import keypair. Plaintext fields are
  rejected.

## Authentication

- **Passwords**:
  - Hashed with Argon2id (64 MiB, t=3, p=1).
  - At least 12 characters, checked against a common-password list.
- **MFA**:
  - Mandatory for every account. The user enrolls a passkey (WebAuthn), TOTP, or both.
  - TOTP codes are single-use: the last accepted time step is stored, so a code cannot be
    replayed.
- **Recovery codes**: 10 single-use codes, stored hashed and shown once. Using one is audited.
- **Lockout**: an account locks for 15 min after 5 failed password or MFA attempts. A per-IP rate
  limit also applies to the auth endpoints.
- **Sessions**:
  - Stored server-side in PostgreSQL.
  - Expire after 15 min idle or 8 h absolute.
  - The session ID is regenerated on login, MFA and re-auth.
  - Users can log out all sessions.
- **Step-up re-auth**: sensitive operations need an MFA verification within the last 5 minutes.
  These operations are revealing secrets in protected environments, exporting, rotating keys,
  and managing members and tokens. Otherwise the server returns `401 reauth_required`.
- **Google sign-in (optional)**: OpenID Connect authorization-code flow with PKCE (S256), `state`
  and `nonce`. It replaces the password step only, so MFA is still required.
  - No self-signup: only existing active users. They are matched by stored Google `sub`, or the
    first time by verified email (`email_verified` must be true). The `sub` is linked only after
    that login completes MFA. A user linked to one Google account is never matched by email for
    another.
  - The ID token is fetched directly from Google's token endpoint over TLS with the client
    secret. Its signature is not separately verified (OIDC Core §3.1.3.7). `iss`, `aud`/`azp`,
    `exp`, `nonce` and, if `GOOGLE_HOSTED_DOMAIN` is set, `hd` are checked.
  - Google redirects to an SPA route that POSTs `code` + `state` to the API. The session cookie
    stays `SameSite=Strict` and the callback stays CSRF-protected. The flow's state is single-use
    and expires after 10 min. The code and state are redacted from request logs.
- **Onboarding**: invite-only, with single-use, expiring, hashed invite tokens. The first admin
  is created with `npm run create-admin -w server`.

## Authorization (RBAC)

- **Roles**: each environment has the roles `viewer < editor < owner`.
  - Viewers can list and reveal secrets.
  - Editors can also create, update, delete and import.
  - Owners can also export, rotate keys, and manage members and service tokens.
- **Admin**: a separate global flag for user management. It grants **no implicit secret access**.
  An admin self-granting a role is allowed, but it is audited and the owners are alerted.
- **Protected environments** (production by default):
  - Editors confirm each change by typing the environment slug.
  - Reveals need recent MFA.
  - Users without a role can file an access request for time-boxed access.
- **Last owner**: the last owner of an environment cannot be removed.
- **Non-members**: they receive a 404 for anything in the environment.
- **Service tokens**: they act for one environment. Scope `read` returns JSON or an ejson pull.
  Scope `export` returns ejson only.

See section E of the diagram and [docs/API.md](docs/API.md) for the full matrix.

## Audit log

- **What is logged**: every auth event, reveal, change, export, import, token use, membership
  change and rotation is written to `AuditLog`. Entries contain metadata only, never secret
  values.
- **Hash chain**: each entry stores `hash = SHA-256(prevHash ‖ canonical entry)`. Writers take a
  PostgreSQL advisory lock, so the chain stays linear. `GET /api/audit/verify` recomputes the
  chain and reports the first broken link.
- **Append-only**: the database enforces it. The triggers `AuditLog_append_only` and
  `AuditLog_no_truncate` (migration `server/prisma/migrations/20261017222942_init`) reject
  `UPDATE`, `DELETE` and `TRUNCATE` on the table, even for the application's own role.

## Web hardening

- The helmet CSP is `default-src 'self'` and `script-src 'self'`, with no inline scripts and
  `frame-ancestors 'none'`. Helmet also sets HSTS, `X-Content-Type-Options` and
  `Referrer-Policy`.
- A CSRF synchronizer token (`x-csrf-token`, from `GET /api/csrf`) is required on every non-GET
  request. It is re-fetched after the session is regenerated.
- API responses send `Cache-Control: no-store`.
- Secret values are never put in URLs, logs or React Query caches beyond the reveal call.
- `TRUST_PROXY` must match your proxy topology, so client IPs used for rate limiting and audit
  cannot be spoofed with `X-Forwarded-For`.

## Known limitations

- **Server-side encryption**: the server is trusted. A full compromise of the host exposes the
  in-memory KEKs (see Trust assumption).
- **KEK in memory**: Node.js cannot reliably pin or zero all copies of key material. DEK cache
  zeroing is best effort.
- **Per-instance rate limiter**: the rate limiter lives in memory per process, so limits multiply
  with the number of instances. The account lockout is stored in the database and applies
  globally.
- **Lockout is only revealed after the password**: the password step answers a locked account with
  the same generic 401 as any other failure, without checking the password. `423 account_locked`
  appears only in MFA and re-auth steps, which already require the correct password.
- **Recovery-code login cost**: a recovery-code attempt checks the code against each unused code
  (up to 10 Argon2id verifications). It needs a pending session (correct password) and counts
  towards the lockout, so it is capped at 5 attempts per account per 15 minutes.
- **Availability depends on the ejson private key**: lose it and you lose the vault. Keep offline
  backups.
- **No HSM/KMS integration**: KEKs live in the ejson file, not in a hardware or cloud KMS.
