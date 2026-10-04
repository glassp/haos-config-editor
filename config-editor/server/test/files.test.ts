import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import type { Config } from '../src/config.js';

async function setup(over: Partial<Config> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hace-'));
  const configDir = path.join(root, 'config');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(configDir);
  await fs.mkdir(dataDir);
  const cfg: Config = {
    port: 0, host: '127.0.0.1', configDir, dataDir, publicDir: root,
    readOnly: false, showHidden: false, allowStorage: false, maxFileSize: 1024 * 1024,
    historyLimit: 3, allowedRemotes: null, haUrl: null, haToken: null, ...over,
  };
  return { root, cfg, app: createApp(cfg) };
}
const H = { 'X-HA-Editor': '1' };

describe('files api', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { t = await setup(); });

  it('reads, writes with conflict detection and keeps history', async () => {
    await fs.writeFile(path.join(t.cfg.configDir, 'a.yaml'), 'a: 1\n');
    const r1 = await request(t.app).get('/api/file').query({ path: 'a.yaml' });
    expect(r1.body.content).toBe('a: 1\n');
    const w = await request(t.app).put('/api/file').set(H).send({ path: 'a.yaml', content: 'a: 2\n', expectedMtime: r1.body.mtime });
    expect(w.status).toBe(200);
    const stale = await request(t.app).put('/api/file').set(H).send({ path: 'a.yaml', content: 'a: 3\n', expectedMtime: r1.body.mtime - 5000 });
    expect(stale.status).toBe(409);
    const h = await request(t.app).get('/api/history').query({ path: 'a.yaml' });
    expect(h.body.versions).toHaveLength(1);
    const v = await request(t.app).get('/api/history/version').query({ path: 'a.yaml', id: h.body.versions[0].id });
    expect(v.body.content).toBe('a: 1\n');
  });

  it('rejects traversal and symlink escapes', async () => {
    for (const p of ['../etc/passwd', 'a/../../x', '..']) {
      const r = await request(t.app).get('/api/file').query({ path: p });
      expect([400, 403, 404]).toContain(r.status);
      expect(r.body.content).toBeUndefined();
    }
    await fs.writeFile(path.join(t.root, 'secret.txt'), 'nope');
    await fs.symlink(path.join(t.root, 'secret.txt'), path.join(t.cfg.configDir, 'link.txt'));
    expect((await request(t.app).get('/api/file').query({ path: 'link.txt' })).status).toBe(403);
    await fs.symlink(t.root, path.join(t.cfg.configDir, 'dirlink'));
    expect((await request(t.app).put('/api/file').set(H).send({ path: 'dirlink/new.txt', content: 'x' })).status).toBe(403);
  });

  it('requires the custom header for mutations', async () => {
    const r = await request(t.app).put('/api/file').send({ path: 'x.yaml', content: '' });
    expect(r.status).toBe(403);
  });

  it('protects .storage and hides dotfiles', async () => {
    await fs.mkdir(path.join(t.cfg.configDir, '.storage'));
    await fs.writeFile(path.join(t.cfg.configDir, '.storage', 'core'), '{}');
    await fs.writeFile(path.join(t.cfg.configDir, '.hidden'), 'x');
    await fs.writeFile(path.join(t.cfg.configDir, 'ok.yaml'), 'x');
    expect((await request(t.app).get('/api/file').query({ path: '.storage/core' })).status).toBe(403);
    const tree = await request(t.app).get('/api/tree');
    expect(tree.body.entries.map((e: { name: string }) => e.name)).toEqual(['ok.yaml']);
  });

  it('refuses binary files and honours read-only mode', async () => {
    await fs.writeFile(path.join(t.cfg.configDir, 'b.bin'), Buffer.from([1, 0, 2]));
    expect((await request(t.app).get('/api/file').query({ path: 'b.bin' })).status).toBe(415);
    const ro = await setup({ readOnly: true });
    const r = await request(ro.app).put('/api/file').set(H).send({ path: 'x.yaml', content: '' });
    expect(r.status).toBe(403);
  });

  it('supports create, rename, copy, delete and search', async () => {
    await request(t.app).post('/api/fs').set(H).send({ op: 'create-dir', path: 'packages' }).expect(200);
    await request(t.app).post('/api/fs').set(H).send({ op: 'create-file', path: 'packages/x.yaml' }).expect(200);
    await request(t.app).put('/api/file').set(H).send({ path: 'packages/x.yaml', content: 'hello: Needle\n' }).expect(200);
    await request(t.app).post('/api/fs').set(H).send({ op: 'create-file', path: 'packages/x.yaml' }).expect(409);
    await request(t.app).post('/api/fs').set(H).send({ op: 'copy', path: 'packages/x.yaml', to: 'packages/y.yaml' }).expect(200);
    await request(t.app).post('/api/fs').set(H).send({ op: 'rename', path: 'packages/y.yaml', to: 'packages/z.yaml' }).expect(200);
    const s = await request(t.app).get('/api/search').query({ q: 'needle', content: '1' });
    expect(s.body.results.map((r: { path: string }) => r.path).sort()).toEqual(['packages/x.yaml', 'packages/z.yaml']);
    await request(t.app).post('/api/fs').set(H).send({ op: 'delete', path: 'packages' }).expect(200);
    expect((await request(t.app).get('/api/tree')).body.entries).toEqual([]);
  });

  it('exposes only secret names', async () => {
    await fs.writeFile(path.join(t.cfg.configDir, 'secrets.yaml'), 'wifi_pw: hunter2\napi_key: abc\n');
    const r = await request(t.app).get('/api/secrets');
    expect(r.body).toEqual({ keys: ['wifi_pw', 'api_key'] });
  });

  it('blocks non-ingress remotes in add-on mode', async () => {
    const a = await setup({ allowedRemotes: ['172.30.32.2'] });
    expect((await request(a.app).get('/api/meta')).status).toBe(403);
  });
});
