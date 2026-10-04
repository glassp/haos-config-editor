import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs/promises';
import type { Config } from './config.js';
import { createFiles } from './files.js';
import { createHaClient, type HaClient } from './ha.js';
import { HttpError, createResolver } from './paths.js';
import { createSettings, type SettingsStore } from './settings.js';

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw new HttpError(400, `Missing ${name}`);
  return v;
};

export function createApp(cfg: Config, ha: HaClient = createHaClient(cfg), settings: SettingsStore = createSettings(cfg.dataDir)) {
  const resolver = createResolver(cfg.rootDir, cfg.allowedRoots);
  const files = createFiles(cfg, resolver, settings);
  const app = express();
  app.disable('x-powered-by');

  // Only the Supervisor ingress gateway may talk to us when running as an add-on.
  app.use((req, res, next) => {
    if (cfg.allowedRemotes) {
      const remote = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
      if (!cfg.allowedRemotes.includes(remote)) return void res.status(403).send('Forbidden');
    }
    next();
  });

  app.use((_req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; worker-src 'self' blob:; frame-ancestors 'self'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use(express.json({ limit: '10mb' }));

  // State-changing requests must carry a custom header, which browsers only allow
  // same-origin (cross-site requests would need a CORS preflight we never grant).
  app.use('/api', (req, _res, next) => {
    if (req.method !== 'GET' && req.get('x-ha-editor') !== '1') return next(new HttpError(403, 'Missing X-HA-Editor header'));
    next();
  });

  const api = express.Router();
  const wrap =
    (fn: (req: Request) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) =>
      fn(req).then((out) => res.json(out ?? { ok: true }), next);

  api.get('/meta', wrap(async () => ({
    haConnected: ha.available,
    readOnly: cfg.readOnly,
    maxFileSize: cfg.maxFileSize,
  })));

  api.get('/tree', wrap(async (req) => ({ entries: await files.list(String(req.query.path ?? '/')) })));
  api.get('/file', wrap(async (req) => files.read(str(req.query.path, 'path'))));
  api.put('/file', wrap(async (req) => {
    const { path, content, expectedMtime } = req.body ?? {};
    if (typeof content !== 'string') throw new HttpError(400, 'Missing content');
    return files.write(str(path, 'path'), content, typeof expectedMtime === 'number' ? expectedMtime : null);
  }));
  api.post('/fs', wrap(async (req) => {
    const { op, path, to } = req.body ?? {};
    switch (op) {
      case 'create-file': return files.create(str(path, 'path'), 'file');
      case 'create-dir': return files.create(str(path, 'path'), 'dir');
      case 'rename': return files.rename(str(path, 'path'), str(to, 'to'));
      case 'copy': return files.copy(str(path, 'path'), str(to, 'to'));
      case 'delete': return files.remove(str(path, 'path'));
      default: throw new HttpError(400, 'Unknown op');
    }
  }));
  api.get('/search', wrap(async (req) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return { results: [] };
    return { results: await files.search(q, { content: req.query.content === '1' }) };
  }));
  // Flat list of every visible file path, for !include completion/validation and quick open.
  api.get('/index', wrap(async () => ({
    paths: await files.index(),
  })));

  api.get('/settings', wrap(async () => settings.get()));
  api.put('/settings', wrap(async (req) => settings.save(req.body)));
  api.get('/history', wrap(async (req) => ({ versions: await files.listHistory(str(req.query.path, 'path')) })));
  api.get('/history/version', wrap(async (req) => files.readHistory(str(req.query.path, 'path'), str(req.query.id, 'id'))));

  // Names (never values) from secrets.yaml, for completion and validation.
  api.get('/secrets', wrap(async () => {
    try {
      const { abs } = await resolver.resolve('/config/secrets.yaml');
      const text = await fs.readFile(abs, 'utf8');
      const keys = [...text.matchAll(/^([A-Za-z0-9_.-]+)\s*:/gm)].map((m) => m[1]);
      return { keys };
    } catch {
      return { keys: [] };
    }
  }));

  // Optional user schemas: /config/.ha-editor/schemas.json maps globs to schema files.
  api.get('/schemas', wrap(async () => {
    const out: Record<string, unknown> = {};
    try {
      const { abs } = await resolver.resolve('/config/.ha-editor/schemas.json');
      const map = JSON.parse(await fs.readFile(abs, 'utf8')) as Record<string, string>;
      for (const [glob, file] of Object.entries(map)) {
        try {
          out[glob] = JSON.parse((await files.read(file.startsWith('/') ? file : `/config/${file}`)).content);
        } catch {
          /* skip unreadable schema */
        }
      }
    } catch {
      /* no custom schemas */
    }
    return { schemas: out };
  }));

  api.get('/ha/context', wrap(async () => {
    if (!ha.available) return { connected: false, entities: [], services: {}, components: [] };
    const [entities, services, components] = await Promise.all([
      ha.states().catch(() => []),
      ha.services().catch(() => ({})),
      ha.components().catch(() => []),
    ]);
    return { connected: true, entities, services, components };
  }));
  api.post('/ha/check-config', wrap(async () => ha.checkConfig()));
  api.post('/ha/reload', wrap(async (req) => {
    if (cfg.readOnly) throw new HttpError(403, 'Editor is in read-only mode');
    await ha.callService(str(req.body?.service, 'service'));
  }));

  app.use('/api', api);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use(express.static(cfg.publicDir, { index: 'index.html', maxAge: 0 }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
    const status = (err as { status?: number }).status;
    if (status && status < 500) return void res.status(status).json({ error: 'Bad request' });
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  });

  return app;
}
