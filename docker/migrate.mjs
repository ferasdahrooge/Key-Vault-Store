// Container entrypoint for the `migrate` image target: `prisma migrate deploy` with DATABASE_URL
// taken from the decrypted ejson secrets. Compiled-JS equivalent of server/scripts/prisma.ts.
// The URL exists only in the child's environment; it is never written to disk.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/dist/config/index.js';

// Repo root inside the image, then run prisma migrate deploy with the decrypted URL.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig();
const r = spawnSync(path.join(root, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy'], {
  cwd: path.join(root, 'server'),
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: config.secrets.database_url },
});
if (r.error) console.error(`migrate: ${r.error.message}`);
process.exit(r.status ?? 1);
