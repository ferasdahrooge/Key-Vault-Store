/**
 * Bootstraps the first admin: creates an invited admin user and prints a single-use invite link.
 * The admin sets their password and enrolls MFA through the normal invite flow.
 *
 *   npm run create-admin -w server -- --email you@example.com --name "You" [--force]
 *
 * Refuses when an active or invited admin already exists, unless --force is given.
 */
import { issueInvite, normaliseEmail } from '../src/features/invites/invites.service.js';
import { loadConfig } from '../src/config/index.js';
import { initCrypto } from '../src/crypto/index.js';
import { createDb } from '../src/core/db.js';
import { recordAudit } from '../src/features/audit/audit.service.js';
import { arg } from './_shared.js';

// Read and validate command-line arguments.
const rawEmail = arg('email');
const name = arg('name')?.trim();
const force = process.argv.includes('--force');

if (!rawEmail || !name || rawEmail.startsWith('--') || name.startsWith('--')) {
  console.error('usage: npm run create-admin -w server -- --email you@example.com --name "Your Name" [--force]');
  process.exit(2);
}
const email = normaliseEmail(rawEmail);
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || name.length > 100) {
  console.error('error: invalid --email or --name');
  process.exit(2);
}

// Boot config, crypto and the database like the server does.
const config = loadConfig();
initCrypto({ masterKeks: config.secrets.master_kek, activeKek: config.secrets._active_kek });
const db = createDb(config.secrets.database_url);

try {
  // Avoid accidentally creating extra admins.
  const admins = await db.user.count({ where: { isAdmin: true, status: { in: ['active', 'invited'] } } });
  if (admins > 0 && !force) {
    console.error(`error: ${admins} active or invited admin(s) already exist; pass --force to create another`);
    process.exitCode = 1;
  } else {
    // Issue the invite and audit it as a system action.
    const inv = await issueInvite(db, config.APP_ORIGIN, { email, name, isAdmin: true });
    await recordAudit(db, {
      action: 'invite.created',
      actorType: 'system',
      actorId: null,
      meta: { userId: inv.userId, email, isAdmin: true, via: 'create-admin', force },
    });
    console.log(`Admin invite for ${email}:`);
    console.log(`  ${inv.inviteUrl}`);
    console.log(`  expires ${inv.expiresAt.toISOString()} (single use)`);
  }
} catch (err) {
  const code = (err as { code?: string }).code;
  console.error(`error: ${code === 'user_exists' ? 'a non-invited user with this email already exists' : (err as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
