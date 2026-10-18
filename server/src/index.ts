import { createApp } from './app.js';
import { loadConfig } from './config/index.js';
import { initCrypto } from './crypto/index.js';
import { createDb } from './core/db.js';
import { logger } from './core/logger.js';

// Load config and decrypted secrets before anything else.
let config;
try {
  config = loadConfig();
} catch (e) {
  // Fail closed: no key / bad secrets → no server.
  logger.fatal({ err: (e as Error).message }, 'refusing to start: could not load ejson secrets');
  process.exit(1);
}

// Initialise encryption keys, the database and the Express app.
initCrypto({ masterKeks: config.secrets.master_kek, activeKek: config.secrets._active_kek });
const db = createDb(config.secrets.database_url);
const { app, close } = createApp({ config, db });

// Start listening for HTTP requests.
const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'key vault listening');
});

// Graceful shutdown: stop accepting requests, close pools, then exit.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(async () => {
      await close();
      await db.$disconnect();
      process.exit(0);
    });
  });
}
