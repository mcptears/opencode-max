import express from 'express';
import { AccountPool } from './accountPool.js';
import { CONFIG, loadAccounts, loadProxies } from './config.js';
import { IpRotator } from './ipRotator.js';
import { buildRouter } from './routes.js';
import { SessionManager } from './sessionManager.js';

async function main(): Promise<void> {
  const accounts = loadAccounts(CONFIG.accountsFile);
  const proxies = loadProxies(CONFIG.proxiesFile);

  const pool = new AccountPool(accounts, CONFIG.defaultCooldownMs);
  const rotator = new IpRotator(proxies);
  const sessions = new SessionManager();

  const app = express();
  app.disable('x-powered-by');
  // Raw body: we forward bytes ourselves after sanitizing JSON payloads.
  app.use(express.raw({ type: () => true, limit: '25mb' }));
  app.use(buildRouter(pool, rotator, sessions));

  // Error handler — surfaces 503 (pool exhausted) / 502 (upstream down) cleanly.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status =
      typeof err === 'object' && err !== null && typeof (err as { status?: unknown }).status === 'number'
        ? ((err as { status: number }).status as number)
        : 500;
    const message = err instanceof Error ? err.message : 'internal error';
    res.status(status).json({ error: { message, status } });
  });

  app.listen(CONFIG.port, () => {
    console.log(
      `opencode-max listening on :${CONFIG.port} — ${accounts.length} account(s), ` +
        `${proxies.length} proxie(s) in rotation pool, upstream ${CONFIG.upstreamBase}`,
    );
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
