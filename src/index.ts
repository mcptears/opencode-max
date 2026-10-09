import dns from 'node:dns/promises';
import { exec } from 'node:child_process';
import path from 'node:path';
import express from 'express';
import { AccountPool } from './accountPool.js';
import { buildAdminRouter } from './adminRoutes.js';
import { describeAutoStart, isAutoStartEnabled } from './autostart.js';
import { CONFIG, loadAccounts, loadProxies } from './config.js';
import { IpRotator } from './ipRotator.js';
import { Metrics } from './metrics.js';
import { projectRoot } from './paths.js';
import { buildRouter } from './routes.js';
import { loadProviders } from './providers.js';
import { SessionManager } from './sessionManager.js';
import { QuotaTracker } from './quota.js';
import { getSettings } from './settings.js';
import { initTray, isTraySupported } from './tray.js';

function printHelp(): void {
  console.log(`opencode-max — OpenCode Zen proxy with IP rotation + multi-account key pool

Usage: node dist/index.js [options]

  --tray        run in the system tray (hides to tray, menu: dashboard / rotate / auto-start / quit)
  --open        open the dashboard in your browser on start
  --port <n>    listen port (overrides PORT / settings)
  --help        show this help

Dashboard: http://127.0.0.1:<port>/dashboard   API: http://127.0.0.1:<port>/v1
Auto-start on login: toggle it in the tray menu or the dashboard.`);
}

function parseArgs(): { tray: boolean; open: boolean; port?: number } {
  const args = process.argv.slice(2);
  const out: { tray: boolean; open: boolean; port?: number } = { tray: false, open: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tray') out.tray = true;
    else if (args[i] === '--open') out.open = true;
    else if (args[i] === '--help' || args[i] === '-h') {
      printHelp();
      process.exit(0);
    } else if (args[i] === '--port' && args[i + 1]) {
      const n = Number(args[++i]);
      if (Number.isInteger(n) && n > 0 && n < 65536) out.port = n;
    }
  }
  return out;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? `open ${JSON.stringify(url)}` :
    process.platform === 'win32' ? `start "" ${JSON.stringify(url)}` :
    `xdg-open ${JSON.stringify(url)}`;
  exec(cmd, () => undefined);
}

function dashboardRoot(): string {
  return path.resolve(projectRoot(), 'public');
}

async function main(): Promise<void> {
  const flags = parseArgs();
  if (flags.port) CONFIG.port = flags.port;
  const settings = getSettings();
  const port = flags.port ?? settings.port;

  const accounts = loadAccounts(CONFIG.accountsFile);
  const proxies = loadProxies(CONFIG.proxiesFile);

  const pool = new AccountPool(accounts);
  const rotator = new IpRotator(proxies);
  const sessions = new SessionManager();
  const metrics = new Metrics();
  const quota = new QuotaTracker();
  pool.setQuotaTracker(quota);
  // Prune old usage events hourly so the table stays small.
  const quotaPruneTimer = setInterval(() => quota.prune(), 3600_000);
  if (typeof quotaPruneTimer.unref === 'function') quotaPruneTimer.unref();

  rotator.onHealthChange = (proxy, healthy) => {
    metrics.record(healthy ? 'rotated' : 'error', `proxy ${healthy ? 'recovered' : 'unhealthy, skipped in rotation'}: ${proxy}`);
  };
  if (settings.proxyHealthCheck) {
    rotator.startHealthChecks(settings.proxyHealthIntervalMs);
  }

  // Zen treats IPv4 and IPv6 as separate rate-limit buckets: detect dual-stack
  // so direct egress can alternate families and double the effective quota.
  let dualStack = false;
  try {
    const host = new URL(settings.upstreamBase).hostname;
    await dns.lookup(host, { family: 6 });
    dualStack = true;
  } catch {
    dualStack = false;
  }
  rotator.configureEgress({ familyMode: settings.egressFamily, dualStack });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.raw({ type: () => true, limit: '25mb' }));

  // Dashboard (no build step — static files).
  app.use('/dashboard', express.static(dashboardRoot(), { index: 'dashboard.html' }));
  app.get('/dashboard', (_req, res) => res.sendFile(path.join(dashboardRoot(), 'dashboard.html')));
  app.get('/', (_req, res) => res.redirect('/dashboard/'));
  app.use(buildAdminRouter({ pool, rotator, sessions, metrics }));
  // Providers are re-read from disk on every request so dashboard edits apply live.
  app.use(buildRouter(pool, rotator, sessions, metrics, quota, loadProviders));

  // Error handler.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status =
      typeof err === 'object' && err !== null && typeof (err as { status?: unknown }).status === 'number'
        ? ((err as { status: number }).status as number)
        : 500;
    const message = err instanceof Error ? err.message : 'internal error';
    metrics.record('error', message.slice(0, 160));
    res.status(status).json({ error: { message, status } });
  });

  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`opencode-max on http://127.0.0.1:${port} — ${accounts.length} account(s), ${proxies.length} proxie(s)`);
    console.log(`dashboard: http://127.0.0.1:${port}/dashboard`);
    if (flags.open) openBrowser(`http://127.0.0.1:${port}/dashboard`);
  });

  const shutdown = (): void => {
    console.log('\nshutting down…');
    rotator.stopHealthChecks();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (flags.tray) {
    if (!isTraySupported()) {
      console.log('tray not supported on this system (headless?) — running in terminal mode.');
    } else {
      const tray = initTray({
        port,
        onOpenDashboard: () => openBrowser(`http://127.0.0.1:${port}/dashboard`),
        onRotate: () => {
          rotator.rotate();
          const label = rotator.egressLabel();
          metrics.rotated(label);
          console.log(`rotated egress → ${label}`);
        },
        onQuit: () => {
          tray?.kill();
          shutdown();
        },
      });
      if (tray) {
        console.log(`tray icon active — ${describeAutoStart()} (${isAutoStartEnabled() ? 'on' : 'off'})`);
      } else {
        console.log('tray failed to initialize — running in terminal mode.');
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
