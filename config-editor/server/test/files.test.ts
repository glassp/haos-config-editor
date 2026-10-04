import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import type { Config } from '../src/config.js';

async function setup(over: Partial<Config> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hace-'));
  const rootDir = path.join(root, 'root');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(path.join(rootDir, 'config'), { recursive: true });
  await fs.mkdir(path.join(rootDir, 'share'));
  await fs.mkdir(path.join(rootDir, 'secretdir'));
  await fs.mkdir(dataDir);
  const cfg: Config = {
    port: 0, host: '127.0.0.1', rootDir, allowedRoots: ['config', 'share', 'media'], dataDir, publicDir: root,
    readOnly: false, allowStorage: false, maxFileSize: 1024 * 1024,
    historyLimit: 3, allowedRemotes: null, haUrl: null, haToken: null, ...over,
  };
  return { root, cfg, config: path.join(rootDir, 'config'), app: createApp(cfg) };
}
const H = { 'X-HA-Editor': '1' };
const names = (r: { body: { entries: { name: string }[] } }) => r.body.entries.map((e) => e.name);

describe('files api', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { t = await setup(); });

  it('lists a virtual root made of the allowed, existing folders only', async () => {
    const r = await request(t.app).get('/api/tree').query({ path: '/' });
    expect(names(r)).toEqual(['config', 'share']); // media is allowed but not mounted; secretdir is not allowed
    expect(r.body.entries[0].path).toBe('/config');
  });

  it('reads, writes with conflict detection and keeps history', async () => {
    await fs.writeFile(path.join(t.config, 'a.yaml'), 'a: 1\n');
    const r1 = await request(t.app).get('/api/file').query({ path: '/config/a.yaml' });
    expect(r1.body.content).toBe('a: 1\n');
    const w = await request(t.app).put('/api/file').set(H).send({ path: '/config/a.yaml', content: 'a: 2\n', expectedMtime: r1.body.mtime });
    expect(w.status).toBe(200);
    const stale = await request(t.app).put('/api/file').set(H).send({ path: '/config/a.yaml', content: 'a: 3\n', expectedMtime: r1.body.mtime - 5000 });
    expect(stale.status).toBe(409);
    const h = await request(t.app).get('/api/history').query({ path: '/config/a.yaml' });
    expect(h.body.versions).toHaveLength(1);
    const v = await request(t.app).get('/api/history/version').query({ path: '/config/a.yaml', id: h.body.versions[0].id });
    expect(v.body.content).toBe('a: 1\n');
  });

  it('rejects traversal, foreign folders and symlink escapes', async () => {
    await fs.writeFile(path.join(t.cfg.rootDir, 'secretdir', 'x.txt'), 'nope');
    for (const p of ['/secretdir/x.txt', '/config/../secretdir/x.txt', '/../etc/passwd', '/etc/passwd']) {
      const r = await request(t.app).get('/api/file').query({ path: p });
      expect([400, 403, 404]).toContain(r.status);
      expect(r.body.content).toBeUndefined();
    }
    await fs.symlink(path.join(t.cfg.rootDir, 'secretdir', 'x.txt'), path.join(t.config, 'link.txt'));
    expect((await request(t.app).get('/api/file').query({ path: '/config/link.txt' })).status).toBe(403);
    await fs.symlink(path.join(t.cfg.rootDir, 'share'), path.join(t.config, 'dirlink'));
    expect((await request(t.app).put('/api/file').set(H).send({ path: '/config/dirlink/new.txt', content: 'x' })).status).toBe(403);
  });

  it('refuses to modify top-level folders', async () => {
    expect((await request(t.app).post('/api/fs').set(H).send({ op: 'delete', path: '/config' })).status).toBe(400);
    expect((await request(t.app).post('/api/fs').set(H).send({ op: 'create-dir', path: '/newroot' })).status).toBe(403); // not an allowed folder
  });

  it('requires the custom header for mutations', async () => {
    const r = await request(t.app).put('/api/file').send({ path: '/config/x.yaml', content: '' });
    expect(r.status).toBe(403);
  });

  it('protects .storage', async () => {
    await fs.mkdir(path.join(t.config, '.storage'));
    await fs.writeFile(path.join(t.config, '.storage', 'core'), '{}');
    expect((await request(t.app).get('/api/file').query({ path: '/config/.storage/core' })).status).toBe(403);
    expect((await request(t.app).get('/api/tree').query({ path: '/config/.storage' })).status).toBe(403);
  });

  it('shows everything by default, including dotfiles', async () => {
    await fs.writeFile(path.join(t.config, '.hidden'), 'x');
    await fs.writeFile(path.join(t.config, 'ok.yaml'), 'x');
    expect(names(await request(t.app).get('/api/tree').query({ path: '/config' }))).toEqual(['.hidden', 'ok.yaml']);
  });

  it('applies visibility rules to the explorer and search but not to reads or the index', async () => {
    await fs.mkdir(path.join(t.config, 'private'));
    await fs.writeFile(path.join(t.config, 'private', 'a.yaml'), 'needle: 1\n');
    await fs.writeFile(path.join(t.config, 'secrets.yaml'), 'k: v\n');
    await fs.writeFile(path.join(t.config, 'ok.yaml'), 'needle: 2\n');
    await request(t.app).put('/api/settings').set(H).send({ visibility: [
      { mode: 'hide', pattern: '/config/private' },
      { mode: 'hide', pattern: 'secrets.yaml' },
    ] }).expect(200);
    expect(names(await request(t.app).get('/api/tree').query({ path: '/config' }))).toEqual(['ok.yaml']);
    const s = await request(t.app).get('/api/search').query({ q: 'needle', content: '1' });
    expect(s.body.results.map((r: { path: string }) => r.path)).toEqual(['/config/ok.yaml']);
    // hidden files stay accessible to the application
    expect((await request(t.app).get('/api/file').query({ path: '/config/private/a.yaml' })).status).toBe(200);
    expect((await request(t.app).get('/api/index')).body.paths).toEqual(expect.arrayContaining(['/config/private/a.yaml', '/config/secrets.yaml']));
    expect((await request(t.app).get('/api/secrets')).body.keys).toEqual(['k']);
    // the settings survive a reload of the store
    expect((await request(t.app).get('/api/settings')).body.visibility).toHaveLength(2);
  });

  it('later rules override earlier ones (hide everything, show one folder)', async () => {
    await fs.mkdir(path.join(t.config, 'packages'));
    await fs.writeFile(path.join(t.config, 'packages', 'p.yaml'), '');
    await fs.writeFile(path.join(t.config, 'other.yaml'), '');
    await request(t.app).put('/api/settings').set(H).send({ visibility: [
      { mode: 'hide', pattern: '/config/*' },
      { mode: 'show', pattern: '/config/packages' },
    ] });
    expect(names(await request(t.app).get('/api/tree').query({ path: '/config' }))).toEqual(['packages']);
    expect(names(await request(t.app).get('/api/tree').query({ path: '/config/packages' }))).toEqual(['p.yaml']);
  });

  it('refuses binary files and honours read-only mode', async () => {
    await fs.writeFile(path.join(t.config, 'b.bin'), Buffer.from([1, 0, 2]));
    expect((await request(t.app).get('/api/file').query({ path: '/config/b.bin' })).status).toBe(415);
    const ro = await setup({ readOnly: true });
    const r = await request(ro.app).put('/api/file').set(H).send({ path: '/config/x.yaml', content: '' });
    expect(r.status).toBe(403);
  });

  it('supports create, rename, copy, delete and search', async () => {
    await request(t.app).post('/api/fs').set(H).send({ op: 'create-dir', path: '/config/packages' }).expect(200);
    await request(t.app).post('/api/fs').set(H).send({ op: 'create-file', path: '/config/packages/x.yaml' }).expect(200);
    await request(t.app).put('/api/file').set(H).send({ path: '/config/packages/x.yaml', content: 'hello: Needle\n' }).expect(200);
    await request(t.app).post('/api/fs').set(H).send({ op: 'create-file', path: '/config/packages/x.yaml' }).expect(409);
    await request(t.app).post('/api/fs').set(H).send({ op: 'copy', path: '/config/packages/x.yaml', to: '/share/y.yaml' }).expect(200);
    await request(t.app).post('/api/fs').set(H).send({ op: 'rename', path: '/share/y.yaml', to: '/share/z.yaml' }).expect(200);
    const s = await request(t.app).get('/api/search').query({ q: 'needle', content: '1' });
    expect(s.body.results.map((r: { path: string }) => r.path).sort()).toEqual(['/config/packages/x.yaml', '/share/z.yaml']);
    await request(t.app).post('/api/fs').set(H).send({ op: 'delete', path: '/config/packages' }).expect(200);
    expect((await request(t.app).get('/api/tree').query({ path: '/config' })).body.entries).toEqual([]);
  });

  it('exposes only secret names', async () => {
    await fs.writeFile(path.join(t.config, 'secrets.yaml'), 'wifi_pw: hunter2\napi_key: abc\n');
    expect((await request(t.app).get('/api/secrets')).body).toEqual({ keys: ['wifi_pw', 'api_key'] });
  });

  it('sanitises settings input', async () => {
    const r = await request(t.app).put('/api/settings').set(H).send({ visibility: [{ mode: 'nope', pattern: 'x' }, { mode: 'hide', pattern: '  ' }, { mode: 'hide', pattern: '*.db' }] });
    expect(r.body.visibility).toEqual([{ mode: 'hide', pattern: '*.db' }]);
  });

  it('blocks non-ingress remotes in add-on mode', async () => {
    const a = await setup({ allowedRemotes: ['172.30.32.2'] });
    expect((await request(a.app).get('/api/meta')).status).toBe(403);
  });
});
