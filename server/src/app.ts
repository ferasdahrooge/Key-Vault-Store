import { existsSync } from 'node:fs';
import path from 'node:path';
import connectPgSimple from 'connect-pg-simple';
import { csrfSync } from 'csrf-sync';
import express, { type Express } from 'express';
import session from 'express-session';
import helmet from 'helmet';
import pg from 'pg';
import { pinoHttp } from 'pino-http';
import { IDLE_TIMEOUT_MS } from './features/auth/auth.middleware.js';
import { repoRoot } from './config/index.js';
import { errorHandler, notFound } from './core/http.js';
import { logger, redactUrl } from './core/logger.js';
import { accessRequestsRouter } from './features/access-requests/accessRequests.routes.js';
import { adminRouter } from './features/admin/admin.routes.js';
import { auditRouter } from './features/audit/audit.routes.js';
import { authRouter } from './features/auth/auth.routes.js';
import { exchangeRouter } from './features/exchange/exchange.routes.js';
import { invitesRouter } from './features/invites/invites.routes.js';
import { projectsRouter } from './features/projects/projects.routes.js';
import { serviceApiRouter } from './features/service-api/serviceApi.routes.js';
import { testLoginRouter } from './features/auth/testLogin.routes.js';
import { usersRouter } from './features/users/users.routes.js';
import type { AppDeps } from './core/types.js';

// Builds the Express app: security headers, APIs, session/CSRF, and the SPA.
export function createApp(deps: AppDeps): { app: Express; close: () => Promise<void> } {
  const { config } = deps;
  if (deps.enableTestLogin && config.isProd) throw new Error('test login must never be enabled in production');

  // Base Express setup: hide framework header, honour configured proxy hops.
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);

  app.use(
    // Request logging (health checks skipped, sensitive URLs redacted).
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/healthz' },
      // The serialized copy, not the live request: routing still sees the real URL.
      serializers: { req: (req) => Object.assign(req, { url: redactUrl(req.url) }) },
    }),
  );
  app.use(
    // Strict security headers: CSP, HSTS, no framing, no referrer.
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'self'"],
          ...(config.secureTransport ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      strictTransportSecurity: config.secureTransport ? { maxAge: 63072000, includeSubDomains: true, preload: true } : false,
      referrerPolicy: { policy: 'no-referrer' },
      xFrameOptions: { action: 'deny' },
      crossOriginEmbedderPolicy: true,
    }),
  );

  // Liveness probe for Docker / load balancers.
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  // ---- Machine API: bearer service tokens, no cookies, no CSRF ----
  app.use('/api/v1', express.json({ limit: '256kb' }), noStore, serviceApiRouter(deps));

  // ---- Browser API: session cookie + CSRF ----
  const pool = new pg.Pool(pgPoolConfig(config.secrets.database_url));
  const PgStore = connectPgSimple(session);
  // ejson imports may carry many secrets; only those two routes get the larger limit.
  app.use(/^\/api\/projects\/[^/]+\/envs\/[^/]+\/import\/(preview|commit)$/, express.json({ limit: '2mb' }));
  app.use(
    '/api',
    noStore,
    express.json({ limit: '256kb' }),
    session({
      name: config.sessionCookieName,
      secret: config.secrets.session_secret,
      store: new PgStore({ pool, tableName: 'session', createTableIfMissing: false }),
      resave: false,
      saveUninitialized: false,
      rolling: true, // idle timeout: every request pushes expiry forward
      cookie: {
        httpOnly: true,
        secure: config.secureTransport,
        sameSite: 'strict',
        path: '/',
        maxAge: IDLE_TIMEOUT_MS,
      },
    }),
  );

  // CSRF: the SPA fetches a token from /api/csrf and sends it on every mutation.
  const { csrfSynchronisedProtection, generateToken } = csrfSync();
  app.get('/api/csrf', (req, res) => {
    res.json({ token: generateToken(req) });
  });
  app.use('/api', csrfSynchronisedProtection);

  // Mount every browser API router; unknown /api paths return 404.
  if (deps.enableTestLogin) app.use('/api/__test', testLoginRouter(deps));
  app.use('/api/auth', authRouter(deps));
  app.use('/api/invites', invitesRouter(deps));
  app.use('/api/admin', adminRouter(deps));
  app.use('/api/users', usersRouter(deps));
  app.use('/api/projects', projectsRouter(deps)); // includes envs, secrets, members, tokens, compare
  app.use('/api', exchangeRouter(deps)); // /import-key and /projects/:p/envs/:e/{export,import/*}
  app.use('/api/access-requests', accessRequestsRouter(deps));
  app.use('/api/audit', auditRouter(deps));
  app.use('/api', (_req, _res, next) => next(notFound()));

  // ---- SPA ----
  const webDist = path.join(repoRoot, 'web', 'dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  // Single place that turns errors into JSON responses.
  app.use(errorHandler);

  return { app, close: () => pool.end() };
}

/** Prisma uses ?schema=; node-postgres needs it as search_path. */
function pgPoolConfig(databaseUrl: string): pg.PoolConfig {
  const url = new URL(databaseUrl);
  const schema = url.searchParams.get('schema');
  url.searchParams.delete('schema');
  return {
    connectionString: url.toString(),
    max: 5,
    ...(schema ? { options: `-c search_path="${schema.replace(/"/g, '')}"` } : {}),
  };
}

// Prevents browsers and proxies from caching API responses.
function noStore(_req: express.Request, res: express.Response, next: express.NextFunction) {
  res.set('Cache-Control', 'no-store');
  next();
}
