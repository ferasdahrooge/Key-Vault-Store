# Key Vault

A self-hosted secrets manager for small teams. People keep API keys, database passwords and other
configuration in per-project, per-environment vaults. Access is role-based, every action is
audited, and CI or servers fetch secrets with scoped service tokens. Vaults can be imported and
exported as [ejson](https://github.com/Shopify/ejson) files.

- **Server**: Express 5 + TypeScript + Prisma 6 on PostgreSQL 16 (`server/`)
- **Web**: React SPA built with Vite (`web/`), served by the server in production
- **Crypto**: server-side envelope encryption. Values are encrypted with AES-256-GCM under a
  per-environment DEK. Each DEK is wrapped by a master KEK, and the KEK lives in an ejson file
  that is decrypted only in memory.
- **Auth**: Argon2id passwords, mandatory MFA (passkey or TOTP), recovery codes, account lockout,
  short sessions and step-up re-authentication for sensitive actions.

See [SECURITY.md](SECURITY.md) for the threat model and crypto details.

## Architecture

- [docs/architecture.excalidraw](docs/architecture.excalidraw) is the full diagram. Open it at
  [excalidraw.com](https://excalidraw.com) via *Open → file*. It contains the system architecture,
  key hierarchy, data model, ten request flows, the RBAC matrix, the audit chain and the threat
  model.
- [docs/architecture.svg](docs/architecture.svg) is a static preview of the same diagram.
- [docs/API.md](docs/API.md) is the HTTP API contract.

`docs/tools/gen_excalidraw.py` generates the diagram, and `docs/tools/validate_excalidraw.py`
checks it. Both use only the Python 3.9 standard library. Edit the generator, not the
`.excalidraw` file:

```sh
python3 docs/tools/gen_excalidraw.py && python3 docs/tools/validate_excalidraw.py
```

## First-time setup: generate your secrets

The repository ships no secrets files. Each clone generates its own, encrypted to a keypair whose
private key never leaves your machine:

```sh
npm install
npm run secrets:init -- --env development      # fresh KEK, session secret, import keypair
npm run secrets:derive -- --from development --to compose \
  --database-url postgresql://keyvault:keyvault@db:5432/keyvault   # only for the compose stack
```

`secrets:init` writes `config/secrets.development.ejson` and stores the private key in
`~/.ejson/keys` with mode `0400`. Both `config/secrets.*.ejson` files are gitignored. If you lose
the private key, a database seeded under the old KEK can't be decrypted, so run
`docker compose down -v` and start over.

## Quick start: everything in one command

Prerequisites: Docker, and the secrets from the previous section (the private key is read from
`~/.ejson/keys`; override with `EJSON_KEYS_DIR=/path docker compose up -d`).

```sh
docker compose up -d          # db → migrate (one-shot) → app on http://localhost:8200
```

`docker compose up -d` builds the images if needed, waits for Postgres to be healthy, runs
`prisma migrate deploy`, and only then starts the app. After pulling code changes, use
`docker compose up -d --build`. `docker compose logs -f app` follows the app, and
`docker compose down` stops everything; the data volume is kept unless you add `-v`.

The stack mounts your `config/secrets.compose.ejson` read-only. It holds the same master KEK as
the development file, so the vault data is readable from both `npm run dev` and the container, but its
`database_url` points at the `db` service. Regenerate it with:

```sh
npm run secrets:derive -- --from development --to compose \
  --database-url postgresql://keyvault:keyvault@db:5432/keyvault --force
```

The first admin is created from the host, because the database port is published:

```sh
npm install
npm run create-admin -w server -- --email you@example.com --name "Your Name"
```

Compose serves plain HTTP on localhost only. Cookies get `Secure`, the `__Host-` prefix and HSTS
automatically whenever `APP_ORIGIN` is https. In production mode the app refuses to start with an
http `APP_ORIGIN` on any host other than localhost.

## Quick start (development, hot reload)

```sh
docker compose up -d db              # PostgreSQL 16 on 127.0.0.1:54320
npm install
npm run db:deploy -w server          # apply migrations
npm run create-admin -w server -- --email you@example.com --name "Your Name"
npm run dev                          # API on http://localhost:8200 (stop the compose app first)
npm run dev:web                      # SPA on http://localhost:5173 (proxies /api)
```

`create-admin` prints a single-use invite link. Open it to set your password and enroll MFA.
The command refuses to run if an admin already exists, unless you pass `--force`.

### The development secrets file

`config/secrets.development.ejson` is created by `npm run secrets:init -- --env development`
(see [First-time setup](#first-time-setup-generate-your-secrets)); pass
`--database-url <url>` to override the default `postgresql://keyvault:keyvault@localhost:54320/keyvault`.
To decrypt it, your machine needs the matching private key in your keydir (see below). A team that
wants to share one dev vault can share that private key over a secure channel instead.

The server **fails closed**. If the key is missing or any secret is invalid, it exits at boot and
reports only the path of the bad field.

`npm run prisma -w server -- <args>` runs the Prisma CLI. It injects `DATABASE_URL` from the
decrypted secrets into the child process only. Nobody exports it by hand, and no `.env` file is
needed. Examples: `npm run db:migrate -w server` (`migrate dev`) and
`npm run prisma -w server -- studio`.

## ejson key management

The private key for each secrets file is stored in a **keydir**, in a file named after the
public key. The keydir is resolved in this order (`resolveKeydir` in
`server/src/config/index.ts`):

1. `EJSON_KEYDIR`, if set
2. `/opt/ejson/keys` when `NODE_ENV=production`
3. `~/.ejson/keys` otherwise

| Command | Purpose |
|---|---|
| `npm run secrets:init -- --env <env>` | Create `config/secrets.<env>.ejson` with a new keypair, KEK, session secret and import keypair. Refuses to overwrite an existing file. |
| `npm run secrets:edit -- --env <env>` | Decrypt the file to a `0600` temp file and open `$VISUAL`/`$EDITOR`. On save it validates the schema and re-encrypts. The temp file is zeroed and removed afterwards. |
| `npm run secrets:keygen` | Generate a standalone ejson keypair. The private key goes into the keydir with mode `0400`. |

The app has its own ejson implementation and does not need the CLI. The CLI is useful for
interop and is used by the CLI interop tests:

```sh
brew tap shopify/shopify && brew install ejson
# or
go install github.com/Shopify/ejson/cmd/ejson@latest
```

> **BACKUPS: the ejson private key must be backed up separately and offline — losing it loses all data.**
> It decrypts the master KEK, and the KEK unwraps every environment key. A database backup without
> this key is unreadable. Never store the key in git, in the image, or next to the database backups.

## Runbooks

### Rotate the master KEK

1. Run `npm run secrets:edit -- --env production`. Add a new key, for example
   `"master_kek": { "v1": "…", "v2": "<base64 of 32 random bytes>" }`, and set
   `"_active_kek": "v2"`. Keep `v1` for now. You can generate the value with
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
2. Deploy the updated secrets file and restart. New DEKs are wrapped with `v2`, and existing
   DEKs still unwrap with `v1`.
3. Run `npm run rotate:kek -w server` with the production keydir available. In one transaction,
   it re-wraps every environment DEK that is not on the active KEK, and re-seals every TOTP seed.
   It does not touch secret values.
4. Verify that the script reports `Environments still on another KEK: 0`.
5. Remove `v1` with `secrets:edit`, deploy, and restart.

### Rotate an environment DEK

As an environment owner with recent MFA, use the environment's settings page in the UI, or call
`POST /api/projects/:p/envs/:e/rotate-key`. It generates a new DEK and re-encrypts every secret
version in one transaction. The server also rotates a DEK automatically once it has sealed
2^30 values.

### Rotate the ejson keypair

1. Run `npm run secrets:keygen` and note the new public key. The private key lands in your keydir.
2. Run `npm run secrets:edit -- --env <env>` and replace `_public_key` with the new public key.
   On save the file is re-encrypted to the new key.
3. Install the new private key on every host (`/opt/ejson/keys/<new pub>`, read-only), deploy the
   new file, and restart.
4. Once everything runs on the new key, delete the old private key from every host. Do the same
   in your offline backup, after you have backed up the new key.

## Service tokens (CI / servers)

An environment owner creates a token in the UI, or calls `POST /api/projects/:p/envs/:e/tokens`.
The token (`kv_st_…`) is shown once. The server stores only its SHA-256. Each token has scopes,
an optional expiry and can be revoked. A token stops working when its creator is disabled or is
no longer an owner. Every use is audited.

```sh
# scope "read": JSON
curl -fsS -H "Authorization: Bearer $KV_TOKEN" https://vault.example.com/api/v1/secrets
# → { "project": "...", "env": "...", "secrets": { "KEY": "value" } }

# scope "export": an ejson document encrypted to your CI's public key
curl -fsS -H "Authorization: Bearer $KV_TOKEN" \
  "https://vault.example.com/api/v1/secrets.ejson?pub=$CI_EJSON_PUBLIC_KEY" > secrets.ejson
ejson decrypt secrets.ejson   # needs the matching private key in the keydir
```

If a token was registered with an `ejsonPublicKey`, `/api/v1/secrets` also returns an ejson
document instead of plaintext JSON. See [docs/API.md](docs/API.md) for error codes.

## Testing

```sh
docker compose up -d db-test   # throwaway Postgres on 127.0.0.1:54329 (tmpfs)
npm test                       # server unit + integration tests (vitest)
npm test -w web                # web component tests (vitest + jsdom)
npm run typecheck
```

`TEST_DATABASE_URL` defaults to `postgresql://keyvault:keyvault@localhost:54329/keyvault_test`.
The ejson CLI interop tests are skipped when `ejson` is not on `PATH`.

## Production deployment

```sh
docker build -t key-vault .                                 # runtime image (default target)
docker build --target migrate -t key-vault-migrate .        # one-shot migration image

# Run migrations first. Attach to the network where Postgres is reachable.
docker run --rm --network <net> -v /opt/ejson/keys:/opt/ejson/keys:ro key-vault-migrate
docker compose up -d                                        # or your orchestrator
```

- **TLS**: run the app behind a TLS-terminating reverse proxy (Caddy, nginx, a cloud load
  balancer) and set an https `APP_ORIGIN`. Cookies become `Secure` with the `__Host-` prefix, and passkeys require HTTPS.
- **`TRUST_PROXY`**: set it to the number of proxy hops in front of the app (usually `1`). This
  makes client IPs, used for rate limiting and audit, and the HTTPS scheme correct. Leave it at
  `0` if nothing is in front.
- **`APP_ORIGIN`**: the exact public origin, for example `https://vault.example.com`. It is used
  for the CSRF/origin checks, invite links and WebAuthn.
- **`RP_ID`**: the WebAuthn relying-party ID, normally the hostname of `APP_ORIGIN`. Changing it
  later invalidates every enrolled passkey.
- **Keys**: mount the ejson private key **read-only** at `/opt/ejson/keys`. It is never baked into
  the image, and `.dockerignore` excludes key directories. The image runs as the non-root `node`
  user. The compose `app` service adds a read-only root filesystem, `cap_drop: ALL` and
  `no-new-privileges`.
- **Secrets file**: mount it **read-only** at `/app/config/secrets.production.ejson` (or point
  `SECRETS_FILE` elsewhere). The image contains no secrets file, so it can be shared or pushed to
  a registry without carrying anyone's vault. Create the file with
  `NODE_ENV=production npm run secrets:init -- --env production --database-url …` on a trusted
  machine, using your own database credentials (the compose `keyvault`/`keyvault` login is for
  local use only).
- **Google sign-in (optional)**: see [Sign in with Google](#sign-in-with-google).
- **Health**: `GET /healthz` returns `{ ok: true }`. The image has a `HEALTHCHECK` on it.
- Run a single instance, or put sticky sessions in front. The rate limiter is in memory per
  instance (see SECURITY.md).

## Sign in with Google

Optional. Google replaces the **password step only**: users still complete MFA afterwards. There
is no self-signup. Google works only for existing, active users (invite them first). On the first
Google login the user is matched by verified email. After that login passes MFA, their Google
account ID is linked and used from then on. Users can unlink it on the Account page.

1. In Google Cloud console → *APIs & Services* → *Credentials*, create an **OAuth client ID** of
   type *Web application*. Add the authorized redirect URI `${APP_ORIGIN}/login/google/callback`,
   for example `https://vault.example.com/login/google/callback`. In development with Vite, set
   `APP_ORIGIN=http://localhost:5173` and register `http://localhost:5173/login/google/callback`.
2. Run `npm run secrets:edit -- --env <env>` and add:

   ```json
   "google_oauth": {
     "client_id": "1234-abc.apps.googleusercontent.com",
     "client_secret": "GOCSPX-…"
   }
   ```

3. Optional: set `GOOGLE_HOSTED_DOMAIN=example.com` to accept only accounts from that Google
   Workspace domain. The ID token's `hd` claim is enforced.
4. Restart. The login page shows **Continue with Google** when `google_oauth` is present.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Report security
problems privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## License

Key Vault is licensed under the [Apache License 2.0](LICENSE).
