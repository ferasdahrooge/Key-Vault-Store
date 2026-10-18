# Contributing to Key Vault

Thanks for helping. Bug reports, fixes, docs and tests are all welcome.

## Before you start

- **Security issues**: don't open a public issue. Follow [SECURITY.md](SECURITY.md).
- **Larger changes** (new features, crypto, auth or RBAC changes): open an issue first so the
  design can be discussed before you write code.

## Development setup

Follow [First-time setup](README.md#first-time-setup-generate-your-secrets) and
[Quick start (development, hot reload)](README.md#quick-start-development-hot-reload) in the README.
Every clone generates its own encrypted secrets; never commit `config/secrets.*.ejson` or
anything from `~/.ejson/keys`.

## Project layout

Code is grouped by feature, so everything for one area (routes, services, pages, API calls) lives
in one folder.

```text
server/src/
  index.ts, app.ts        entry point and Express app
  config/                 ejson config loading (keep here: the repo root is resolved from it)
  crypto/                 envelope encryption
  core/                   db, http helpers, logger, shared types
  features/<feature>/     <feature>.routes.ts, <feature>.service.ts, *.middleware.ts
                          auth, invites, users, admin, projects, secrets, members,
                          access-requests, tokens, service-api, exchange, audit, key-rotation

web/src/
  main.tsx, App.tsx       entry point and route table
  app/                    shell: Layout, Nav, ErrorBoundary, query client
  shared/                 api client + types, UI primitives (ui, Dialog, Toast), lib helpers
  features/<feature>/     pages, components, hooks and <feature>.api.ts
    environment/tabs/<tab>/   one folder per environment tab (secrets, members, tokens, ...)
    admin/tabs/               admin page tabs
  test/                   test helpers
```

In the web app, import within the same feature with relative paths, and from anywhere else with
the `@/` alias (`@/shared/components/ui`). The server uses relative `.js` imports (NodeNext).

## Code comments

Comment as you go, so the code stays easy to read for the next person:

- **One line per comment.** Put a short `//` (TS/JS/Prisma) or `#` (Python/YAML/Dockerfile) comment
  above each function, component, route handler, exported constant and non-obvious block.
- **Say what it is for, not how it works.** `// POST /login — check email + password; next step is MFA`
  beats `// call verifyPassword`.
- **Every route handler** gets `// METHOD /path — purpose (who may call it)`.
- **Every file** starts with a one-line `/** ... */` summary of what it contains.
- Use plain language. Skip comments that only repeat the code (`// increment i`).
- In JSX markup use `{/* ... */}`, never `//`.
- When you change code, update or delete its comment in the same commit; a wrong comment is worse
  than none.

## Before opening a pull request

```sh
npm run typecheck
docker compose up -d db-test && npm test
npm run build
```

CI runs the same checks. Please:

- add or update tests for behaviour changes, especially anything touching auth, crypto, RBAC
  or the audit log;
- keep [docs/API.md](docs/API.md) and [SECURITY.md](SECURITY.md) in sync with the code;
- keep pull requests focused on one change.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
