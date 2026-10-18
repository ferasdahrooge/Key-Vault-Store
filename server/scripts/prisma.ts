/**
 * Runs the Prisma CLI with DATABASE_URL taken from the decrypted ejson secrets. The URL exists
 * only in the child process environment — it is never written to disk or a .env file.
 *
 *   npm run prisma -- migrate dev
 *   NODE_ENV=production npm run prisma -- migrate deploy
 */
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config/index.js';

// Run `npx prisma <args>` with the decrypted DATABASE_URL.
const config = loadConfig();
const r = spawnSync('npx', ['prisma', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: config.secrets.database_url },
});
process.exit(r.status ?? 1);
