import { Router } from 'express';
import type express from 'express';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebStream } from 'node:stream/web';
import type { AccountPool } from './accountPool.js';
import type { IpRotator } from './ipRotator.js';
import type { Metrics } from './metrics.js';
import type { SessionManager } from './sessionManager.js';
import { ZenClient } from './zenClient.js';

function abortOnClientClose(req: express.Request): AbortSignal {
  const controller = new AbortController();
  req.on('close', () => controller.abort());
  return controller.signal;
}

export function buildRouter(pool: AccountPool, rotator: IpRotator, sessions: SessionManager, metrics?: Metrics): Router {
  const router = Router();
  const zen = new ZenClient(pool, rotator, sessions, metrics);

  router.get('/health', (_req, res) => {
    res.json({ ok: true, upstream: 'opencode-zen', ip: rotator.status(), accounts: pool.status().length });
  });

  /** Pool status (keys are never exposed). */
  router.get('/v1/accounts', (_req, res) => {
    res.json({ accounts: pool.status(), ip: rotator.status() });
  });

  /** Manual egress rotation, e.g. curl -X POST localhost:8080/v1/rotate */
  router.post('/v1/rotate', (_req, res) => {
    const current = rotator.rotate();
    res.json({ ok: true, ...rotator.status() });
  });

  const proxy = async (req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> => {
    try {
      const zenPath = req.path.replace(/^\/v1/, '') || '/';
      const qIndex = req.originalUrl.indexOf('?');
      const bodyText =
        Buffer.isBuffer(req.body) && req.body.length > 0 && req.method !== 'GET' && req.method !== 'HEAD'
          ? (req.body as Buffer).toString('utf8')
          : undefined;

      const result = await zen.forward({
        method: req.method,
        path: zenPath,
        query: qIndex >= 0 ? req.originalUrl.slice(qIndex) : '',
        headers: req.headers as Record<string, string | string[] | undefined>,
        bodyText,
        provider: 'opencode-zen',
        signal: abortOnClientClose(req),
      });

      res.status(result.status);
      for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
      if (result.body) {
        Readable.fromWeb(result.body as unknown as NodeWebStream).pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      next(err);
    }
  };

  router.get('/v1/models', proxy);
  router.post('/v1/chat/completions', proxy);
  router.post('/v1/messages', proxy);
  // Catch-all for any other Zen paths.
  router.all(/^\/v1\/.*/, proxy);

  return router;
}
