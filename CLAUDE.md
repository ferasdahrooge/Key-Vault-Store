# Key Vault — notes for Claude

## Always comment code

Every change you make must follow the commenting rules in
[CONTRIBUTING.md → Code comments](CONTRIBUTING.md#code-comments). In short:

- One-line `//` (or `#`) comment above every function, component, route handler, exported
  constant and non-obvious block. Keep it short and easy to read.
- Route handlers: `// METHOD /path — purpose (who may call it)`.
- Each file starts with a one-line `/** ... */` summary.
- Describe purpose, not mechanics; no comments that just restate the code.
- JSX markup uses `{/* ... */}`, never `//`.
- Update or remove a comment whenever you change the code it describes.

## Checks before finishing

```sh
npm run typecheck
docker compose up -d db-test && npm test
npm test -w web
```
