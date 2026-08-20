import 'reflect-metadata';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { SocketHandler } from './sockets/socket_handler';
import { installRedisAdapter } from './sockets/redis_adapter';
import { AppDataSource } from './config/data_source';
import { Ride } from './models/Ride';
import { RideOutcomeCode } from './services/ride_outcome';
import financeRoutes from './routes/finance_routes';
import adminRoutes from './routes/admin_routes';
import driverRoutes from "./routes/driver_routes";
import authRoutes, { driverAuthRouter } from "./routes/auth_routes";
import staffAuthRoutes from "./routes/staff_auth_routes";
import dispatcherRoutes from "./routes/dispatcher_routes";
import operationsRoutes from "./routes/operations_routes";
import rideRoutes from "./routes/ride_routes";
import notificationRoutes from "./routes/notification_routes";
import passengerRoutes from "./routes/passenger_routes";
import { NotificationService } from './services/notification_service';
import { StaleRideSweeper } from './services/stale_ride_sweeper';
import { OperationsControlSweeper } from './services/operations_control_sweeper';
import { FinancialRecoveryWorker } from './services/financial_recovery_worker';
import { ParkJobSweeper } from './services/park_job_sweeper';
import { redis } from './config/redis';
import publicCommsRoutes from "./routes/public_comms_routes";
import passengerPreferencesRoutes from "./routes/passenger_preferences_routes";

dotenv.config();

process.on('unhandledRejection', (reason: any) => {
  console.error('[FATAL] Unhandled Promise Rejection:', reason?.message || reason);
});

process.on('uncaughtException', (err: Error) => {
  console.error('[FATAL] Uncaught Exception:', err.message);
  process.exit(1);
});

const _allowedOrigins = process.env.ALLOWED_ORIGINS;
if (!_allowedOrigins) {
  throw new Error('FATAL: ALLOWED_ORIGINS environment variable is not set. Refusing to start.');
}
const ALLOWED_ORIGINS: string[] = _allowedOrigins.split(',').map(o => o.trim());

const app = express();
// Behind the dockerized nginx reverse proxy: trust the first proxy hop so
// req.ip reflects the real client (via X-Forwarded-For) instead of the proxy's
// address. Without this, express-rate-limit buckets EVERY request under the
// proxy IP — turning the per-IP limits into a single global limit for the whole
// platform (which is why onboarding was rejecting legitimate new drivers).
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));

// Paystack webhook needs the raw body for HMAC signature verification.
// Mount it before express.json() so the body isn't pre-parsed.
app.post('/api/v1/finance/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const { PaystackService } = await import('./services/paystack_service');
  const signature = req.headers['x-paystack-signature'] as string;
  const body = (req.body as Buffer).toString('utf8');
  if (!PaystackService.verifyWebhookSignature(body, signature)) {
    return res.status(400).send('Invalid signature');
  }
  try {
    await PaystackService.handleWebhook(JSON.parse(body));
    res.sendStatus(200);
  } catch (err: any) {
    console.error('Webhook error:', err?.message);
    res.status(500).send('Internal server error');
  }
});

/**
 * Resend delivery events.
 *
 * ── Mounted here, before express.json(), because the signature covers the
 * raw bytes ──────────────────────────────────────────────────────────────
 * Re-serialising a parsed body changes key order and whitespace, and the HMAC
 * then never matches. Same reason as the Paystack hook above.
 *
 * ── It answers before it thinks ──────────────────────────────────────────
 * Once the signature checks out we return 200 and process afterwards. A slow
 * database or a bug in the handler must not make Resend believe delivery
 * reporting is failing: Svix would retry, back off, and eventually disable the
 * endpoint — and the same Resend account carries every OTP and password reset
 * KekeRide sends. Losing marketing analytics is an inconvenience; having the
 * provider mark our endpoint unhealthy is a login outage waiting to happen.
 *
 * The processing itself is wrapped so nothing can escape into an unhandled
 * rejection, and it touches only communications tables.
 */
app.post('/api/v1/communications/webhooks/resend',
  express.raw({ type: '*/*', limit: '1mb' }),
  async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');

    /*
     * Verified against the secret directly, NOT via emailProvider().
     *
     * emailProvider() falls back to NullProvider wherever RESEND_API_KEY is
     * absent, and NullProvider.verifyWebhook() returns true unconditionally so
     * that tests need no signing. Routing this through it would mean any
     * environment without an API key accepting forged events — and a forged
     * event can suppress an address or withdraw a passenger's consent.
     */
    if (!process.env.RESEND_WEBHOOK_SECRET) {
      return res.status(503).json({ error: 'webhook not configured' });
    }
    const { ResendProvider } = await import('./services/email_provider');
    if (!new ResendProvider().verifyWebhook(raw, req.headers)) {
      // 401 rather than 400: Svix treats 4xx as "do not retry", which is right
      // — an unsigned or replayed event will not become valid on a second try.
      return res.status(401).json({ error: 'invalid signature' });
    }

    let body: any;
    try { body = JSON.parse(raw); }
    catch { return res.status(400).json({ error: 'invalid json' }); }

    const svixId = String(req.headers['svix-id'] ?? '');
    res.status(200).json({ received: true });

    void (async () => {
      try {
        const { EmailWebhookService } = await import('./services/email_webhook_service');
        await EmailWebhookService.handle(svixId, body);
      } catch (err: any) {
        // Deliberately only logged. There is no caller left to tell, and this
        // path must never be able to affect sending or operational traffic.
        console.error('[EMAIL_WEBHOOK] processing failed:', err?.message);
      }
    })();
  });

app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

/**
 * The dispatcher workspace, served from the backend itself.
 *
 * Same-origin on purpose: the app talks to /api/v1 and opens a Socket.IO
 * connection, and serving it from anywhere else would mean CORS on both plus a
 * second thing to deploy. A park device opens one URL and works.
 *
 * The directory sits outside the compiled output, so the path is resolved
 * relative to the source tree in development and to dist/ in production —
 * hence the two candidates.
 */
const dispatcherAppDir = [
  path.join(__dirname, '../../keke_dispatcher'),
  path.join(__dirname, '../../../keke_dispatcher'),
].find((candidate) => {
  try { return require('fs').existsSync(path.join(candidate, 'index.html')); } catch { return false; }
});
if (dispatcherAppDir) {
  /**
   * A slightly wider Content-Security-Policy, for the dispatcher app only.
   *
   * The global helmet policy is `default-src 'self'`, which means `connect-src`
   * is also `'self'` — so the Firebase Messaging SDK cannot reach the Google
   * endpoints it needs to mint a push token, and getToken() fails with an
   * unhelpful "Failed to fetch". That is what this fixes.
   *
   * Deliberately narrow on both axes:
   *   - it applies ONLY under /dispatch and /dispatcher, never to the API;
   *   - it names the exact Google hosts involved, not a wildcard.
   *
   * `script-src` stays `'self'`. The Firebase SDK is vendored and served from
   * this origin precisely so the policy does not have to allow executable code
   * from a third party — that trade is worth making for a network call and not
   * for a script tag.
   */
  const FIREBASE_ENDPOINTS = [
    'https://fcmregistrations.googleapis.com',
    'https://firebaseinstallations.googleapis.com',
    'https://fcm.googleapis.com',
  ];

  /*
 * Unsubscribe and preference pages. Public by design: a passenger must be able
 * to stop marketing from a device they are not signed in on, and a link that
 * demands a login is answered with the spam button instead.
 */
app.use('/comms', express.urlencoded({ extended: false }), publicCommsRoutes);

// A passenger's own preferences, authenticated as that passenger.
app.use("/api/v1/auth", passengerPreferencesRoutes);

app.use(['/dispatch', '/dispatcher'], helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'connect-src': ["'self'", ...FIREBASE_ENDPOINTS],
        // The service worker is same-origin; stated explicitly because
        // worker-src otherwise inherits from script-src and is easy to break.
        'worker-src': ["'self'"],
      },
    },
  }));

  const dispatcherStatic = express.static(dispatcherAppDir, {
    setHeaders: (res, filePath) => {
      /*
       * The shell must never be cached by the browser: a dispatcher on a stale
       * build during a shift is a support call nobody can diagnose over the
       * phone. The SERVICE WORKER still caches it for offline start-up — that
       * copy is versioned and dropped on activate, so it cannot outlive a
       * deploy the way an HTTP cache entry can.
       */
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, must-revalidate');

      /*
       * A service worker's scope cannot be broader than its own path, so this
       * one only ever controls /dispatch/. Served no-cache for the same reason
       * as the shell: an update must be able to land.
       */
      if (filePath.endsWith('sw.js')) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        res.setHeader('Service-Worker-Allowed', '/dispatch/');
      }

      if (filePath.endsWith('.webmanifest')) {
        res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
      }
    },
  });

  /*
   * `/dispatch` is the canonical route and the PWA's scope. `/dispatcher`
   * stays mounted because it is what the first devices were set up with, and a
   * park tablet with a bookmark that stops working on launch morning is not a
   * trade worth making. Both serve the identical directory.
   */
  app.use('/dispatch', dispatcherStatic);
  app.use('/dispatcher', dispatcherStatic);

  // Bare /dispatch → /dispatch/ so relative asset paths and the SW scope resolve.
  app.get('/dispatch', (_req, res) => res.redirect(301, '/dispatch/'));

  console.log(JSON.stringify({ level: 'info', message: `Park Dispatch app served from ${dispatcherAppDir} at /dispatch (alias /dispatcher)` }));
} else {
  console.warn(JSON.stringify({ level: 'warn', message: 'Park Dispatch app directory not found — /dispatch will 404' }));
}

app.use((req, res, next) => {
  const start = Date.now();
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  (req as any).requestId = requestId;
  res.on('finish', () => {
    console.log(JSON.stringify({
      level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      requestId,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - start,
    }));
  });
  next();
});

/** Fixed at module load, so it identifies this process for its whole life. */
const STARTED_AT = new Date().toISOString();

app.get('/health', async (req, res) => {
  try {
    await AppDataSource.query('SELECT 1');
    await redis.ping();
    /*
     * `colour` and `startedAt` are what make a blue-green cutover verifiable
     * from outside: without them there is no way to tell, from the public URL,
     * which process just answered.
     */
    res.status(200).json({
      status: 'ok', db: 'up', redis: 'up',
      colour: process.env.DEPLOY_COLOUR ?? 'unset',
      startedAt: STARTED_AT,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(503).json({ status: 'degraded', error: err.message });
  }
});

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/driver/auth', driverAuthRouter);
// Staff identity. Deliberately its own path and its own token audience — a
// staff session must never be reachable through the customer auth surface.
app.use('/api/v1/staff/auth', staffAuthRoutes);
// The park dispatcher device surface. Staff sessions only — the legacy shared
// key is refused outright, because every action here must name a person.
app.use('/api/v1/dispatcher', dispatcherRoutes);
app.use('/api/v1/operations', operationsRoutes);
app.use('/api/v1/finance', financeRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/drivers', driverRoutes);
app.use('/api/v1/rides', rideRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/passenger', passengerRoutes);

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'] },
});

new SocketHandler(io);

/*
 * Room broadcasts cross process boundaries during a blue-green deploy.
 * Installed on the Server, so no emit call site changes. Fails soft and is
 * switchable with SOCKET_REDIS_ADAPTER=false. See sockets/redis_adapter.ts.
 */
void installRedisAdapter(io);

const PORT = process.env.PORT || 3000;

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  const status = err.statusCode || err.status || 500;
  console.error(JSON.stringify({ level: 'error', url: req.originalUrl, error: err.message }));
  const code = err.code || (status < 500 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR');
  const message = status < 500 ? err.message : 'Something went wrong. Please try again.';
  res.status(status).json({ code, message });
});

AppDataSource.initialize()
  .then(async () => {
    console.log(JSON.stringify({ level: 'info', message: 'PostgreSQL initialized' }));
    
    /*
     * Migrations are NOT run here.
     *
     * This used to call runMigrations() on every boot. Under blue-green that is
     * a race: two colours start against one database and both try to apply the
     * same migration, which TypeORM does not arbitrate. Worse, it was silent —
     * removing it from the Dockerfile CMD changed nothing, because the app was
     * migrating itself.
     *
     * infra/deploy.sh applies migrations exactly once, before either colour
     * starts. The pending-migration check below reports anything outstanding.
     */

    NotificationService.initialize();

    // Sweep rides stuck in 'searching' from before last restart
    try {
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
      const swept = await AppDataSource.getRepository(Ride)
        .createQueryBuilder()
        .update()
        // Not a supply failure and it must never be counted as one: these rides
        // were mid-search when the process went away, so nothing was ever
        // concluded about driver availability. TECHNICAL_FAILURE keeps them out
        // of the "no Kekes in Awada" reports, where they would otherwise show
        // up as demand we could not serve.
        .set({
          status: 'failed' as any,
          outcomeReason: RideOutcomeCode.TECHNICAL_FAILURE,
          outcomeDetail: 'dispatch_interrupted_by_restart',
        })
        .where('status = :status AND "createdAt" < :cutoff', { status: 'searching', cutoff: tenMinAgo })
        .execute();
      if (swept.affected && swept.affected > 0) {
        console.log(JSON.stringify({ level: 'info', message: `Swept ${swept.affected} stale searching rides to failed` }));
      }
    } catch (e: any) {
      console.error(JSON.stringify({ level: 'warn', message: 'Stale ride sweep failed', error: e.message }));
    }

    // Lifecycle expiry for rides stuck in accepted / arrived / in_progress.
    // The startup sweep above only covers 'searching'; without this, a ride a
    // driver accepted and abandoned blocks that passenger from booking AND that
    // driver from accepting, indefinitely, until someone runs SQL by hand.
    // Guarded by a Postgres advisory lock, so running several backend instances
    // needs no change here. See services/stale_ride_sweeper.ts.
    try {
      StaleRideSweeper.start();
      OperationsControlSweeper.start();
      FinancialRecoveryWorker.start();
    } catch (e: any) {
      console.error(JSON.stringify({ level: 'error', message: 'Failed to start stale-ride sweeper', error: e.message }));
    }

    // Expires park dispatch jobs whose claim or assignment window elapsed. A
    // no-op unless PARK_DISPATCH_ENABLED is true, and guarded by its own
    // advisory lock so several instances can run it safely.
    try {
      ParkJobSweeper.start();
    } catch (e: any) {
      console.error(JSON.stringify({ level: 'error', message: 'Failed to start park job sweeper', error: e.message }));
    }

    /*
     * Migrations are applied by infra/deploy.sh, not at boot. Report anything
     * outstanding loudly — but start anyway. A container that refuses to start
     * because of a pending migration turns a bookkeeping problem into an
     * outage, and during a blue-green deploy the old colour is deliberately
     * running against a newer schema.
     */
    try {
      const pending = await AppDataSource.showMigrations();
      console.log(JSON.stringify({
        level: pending ? 'warn' : 'info',
        scope: 'migrations',
        message: pending
          ? 'PENDING MIGRATIONS: this process is running against an older schema than the code expects. Run infra/deploy.sh, or `npm run migration:run`.'
          : 'Schema is up to date.',
        pending,
      }));
    } catch (e: any) {
      console.log(JSON.stringify({
        level: 'warn', scope: 'migrations',
        message: 'Could not check for pending migrations.', error: e?.message,
      }));
    }

    const server = httpServer.listen(PORT, () => {
      console.log(JSON.stringify({
        level: 'info',
        message: `Keke Backend running on port ${PORT}`,
        colour: process.env.DEPLOY_COLOUR ?? 'unset',
      }));
    });

    const shutdown = async (signal: string) => {
      console.log(JSON.stringify({ level: 'info', message: `${signal} received, shutting down gracefully` }));
      server.close(async () => {
        try {
          // Stop sweeping before the datasource goes away, so an in-flight pass
          // cannot query a destroyed connection during a deploy.
          StaleRideSweeper.stop();
          OperationsControlSweeper.stop();
          FinancialRecoveryWorker.stop();
          await AppDataSource.destroy();
          redis.disconnect();
        } catch (e) {}
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  })
  .catch((err) => {
    console.error(JSON.stringify({ level: 'error', message: 'DB init failed', error: err.message }));
    process.exit(1);
  });
