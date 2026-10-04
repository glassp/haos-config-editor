import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Config } from './config.js';
import { HttpError, type PathResolver } from './paths.js';
import type { SettingsStore } from './settings.js';

export interface Entry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  mtime: number;
}

/** Folders never walked by search/index (huge and uninteresting); the explorer still lists them. */
const SKIP_WALK = new Set(['deps', '__pycache__', '.git', 'node_modules', '.cache']);
const STORAGE = '/config/.storage';

export function createFiles(cfg: Config, resolver: PathResolver, settings: SettingsStore) {
  const { resolve } = resolver;

  function guardStorage(rel: string) {
    if (!cfg.allowStorage && (rel === STORAGE || rel.startsWith(STORAGE + '/'))) {
      throw new HttpError(403, '.storage is protected (enable allow_storage to edit it)');
    }
  }

  function guardWrite(rel: string) {
    if (cfg.readOnly) throw new HttpError(403, 'Editor is in read-only mode');
    if (rel.split('/').filter(Boolean).length < 2) throw new HttpError(400, 'Cannot modify a top-level folder');
    guardStorage(rel);
  }

  const mapErr = (e: unknown): never => {
    if (e instanceof HttpError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new HttpError(404, 'Not found');
    if (code === 'EEXIST') throw new HttpError(409, 'Already exists');
    if (code === 'ENOTDIR') throw new HttpError(400, 'Not a directory');
    if (code === 'EISDIR') throw new HttpError(400, 'Is a directory');
    if (code === 'ENOTEMPTY') throw new HttpError(409, 'Directory is not empty');
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') throw new HttpError(403, 'Permission denied');
    throw e;
  };

  /** Raw directory listing, no visibility filtering. */
  async function listRaw(rel: string): Promise<Entry[]> {
    const { abs, rel: r, mount } = await resolve(rel);
    guardStorage(r);
    try {
      let names: string[];
      if (mount === null) {
        names = resolver.allowedRoots;
      } else {
        names = (await fs.readdir(abs, { withFileTypes: true })).map((d) => d.name);
      }
      const out: Entry[] = [];
      for (const name of names) {
        let st;
        try {
          st = await fs.stat(path.join(abs, name)); // follows symlinks; broken links are skipped
        } catch {
          continue;
        }
        if (!st.isFile() && !st.isDirectory()) continue;
        out.push({
          name,
          path: r === '/' ? `/${name}` : `${r}/${name}`,
          type: st.isDirectory() ? 'dir' : 'file',
          size: st.size,
          mtime: st.mtimeMs,
        });
      }
      out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
      return out;
    } catch (e) {
      return mapErr(e);
    }
  }

  /** What the explorer shows: the raw listing minus paths hidden in the settings. */
  async function list(rel: string): Promise<Entry[]> {
    return (await listRaw(rel)).filter((e) => settings.isVisible(e.path));
  }

  async function read(rel: string) {
    const { abs, rel: r } = await resolve(rel);
    guardStorage(r);
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) throw new HttpError(400, 'Not a file');
      if (st.size > cfg.maxFileSize) throw new HttpError(413, 'File is too large to edit');
      const buf = await fs.readFile(abs);
      if (buf.subarray(0, 8000).includes(0)) throw new HttpError(415, 'Binary files cannot be edited');
      return { path: r, content: buf.toString('utf8'), mtime: st.mtimeMs, size: st.size };
    } catch (e) {
      return mapErr(e);
    }
  }

  async function snapshot(rel: string, content: Buffer) {
    if (cfg.historyLimit <= 0) return;
    const dir = path.join(cfg.dataDir, 'history', crypto.createHash('sha1').update(rel).digest('hex'));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${Date.now()}.txt`), content);
    const names = (await fs.readdir(dir)).sort();
    for (const n of names.slice(0, Math.max(0, names.length - cfg.historyLimit))) {
      await fs.rm(path.join(dir, n), { force: true });
    }
  }

  async function historyDir(rel: string) {
    return path.join(cfg.dataDir, 'history', crypto.createHash('sha1').update(rel).digest('hex'));
  }

  async function listHistory(rel: string) {
    const { rel: r } = await resolve(rel);
    const dir = await historyDir(r);
    try {
      const names = (await fs.readdir(dir)).sort().reverse();
      return Promise.all(
        names.map(async (n) => ({ id: n.replace(/\.txt$/, ''), size: (await fs.stat(path.join(dir, n))).size })),
      );
    } catch {
      return [];
    }
  }

  async function readHistory(rel: string, id: string) {
    const { rel: r } = await resolve(rel);
    if (!/^\d+$/.test(id)) throw new HttpError(400, 'Invalid id');
    try {
      return { content: await fs.readFile(path.join(await historyDir(r), `${id}.txt`), 'utf8') };
    } catch (e) {
      return mapErr(e);
    }
  }

  /** Atomic write. `expectedMtime` guards against overwriting external changes; null skips the check. */
  async function write(rel: string, content: string, expectedMtime: number | null) {
    const { abs, rel: r } = await resolve(rel);
    guardWrite(r);
    const buf = Buffer.from(content, 'utf8');
    if (buf.length > cfg.maxFileSize) throw new HttpError(413, 'Content too large');
    try {
      let mode = 0o644;
      try {
        const st = await fs.stat(abs);
        if (!st.isFile()) throw new HttpError(400, 'Not a file');
        if (expectedMtime !== null && Math.abs(st.mtimeMs - expectedMtime) > 1) {
          throw new HttpError(409, 'File changed on disk since it was opened');
        }
        mode = st.mode & 0o777;
        await snapshot(r, await fs.readFile(abs)).catch(() => {});
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        if (expectedMtime !== null) throw new HttpError(409, 'File was deleted on disk');
      }
      const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.${Date.now()}.tmp`);
      await fs.writeFile(tmp, buf, { mode });
      try {
        await fs.rename(tmp, abs);
      } catch (e) {
        await fs.rm(tmp, { force: true });
        throw e;
      }
      const st = await fs.stat(abs);
      return { path: r, mtime: st.mtimeMs, size: st.size };
    } catch (e) {
      return mapErr(e);
    }
  }

  async function create(rel: string, type: 'file' | 'dir') {
    const { abs, rel: r } = await resolve(rel);
    guardWrite(r);
    try {
      if (type === 'dir') await fs.mkdir(abs, { recursive: false });
      else await fs.writeFile(abs, '', { flag: 'wx', mode: 0o644 });
      const st = await fs.stat(abs);
      return { path: r, mtime: st.mtimeMs };
    } catch (e) {
      return mapErr(e);
    }
  }

  async function rename(from: string, to: string) {
    const a = await resolve(from);
    const b = await resolve(to);
    guardWrite(a.rel);
    guardWrite(b.rel);
    try {
      await fs.access(b.abs).then(
        () => {
          throw new HttpError(409, 'Target already exists');
        },
        () => {},
      );
      await fs.rename(a.abs, b.abs);
      return { path: b.rel };
    } catch (e) {
      return mapErr(e);
    }
  }

  async function copy(from: string, to: string) {
    const a = await resolve(from);
    const b = await resolve(to);
    guardWrite(b.rel);
    guardStorage(a.rel);
    try {
      await fs.cp(a.abs, b.abs, { recursive: true, errorOnExist: true, force: false });
      return { path: b.rel };
    } catch (e) {
      return mapErr(e);
    }
  }

  async function remove(rel: string) {
    const { abs, rel: r } = await resolve(rel);
    guardWrite(r);
    try {
      const st = await fs.lstat(abs);
      if (st.isDirectory()) await fs.rm(abs, { recursive: true });
      else {
        await snapshot(r, await fs.readFile(abs)).catch(() => {});
        await fs.unlink(abs);
      }
    } catch (e) {
      return mapErr(e);
    }
  }

  /**
   * Walk the tree (bounded). `respectVisibility` is true for user facing search and false for
   * the internal index used by validation, which must see hidden files too.
   */
  async function walkFiles(
    start: string,
    opts: { respectVisibility: boolean; limit: number; onFile: (e: Entry) => Promise<void> | void },
  ) {
    let visited = 0;
    let count = 0;
    async function walk(rel: string) {
      if (count >= opts.limit || visited > 20000) return;
      let entries: Entry[];
      try {
        entries = opts.respectVisibility ? await list(rel) : await listRaw(rel);
      } catch {
        return;
      }
      for (const e of entries) {
        if (count >= opts.limit) return;
        visited++;
        if (e.type === 'dir') {
          if (!SKIP_WALK.has(e.name)) await walk(e.path);
        } else {
          count++;
          await opts.onFile(e);
        }
      }
    }
    await walk(start);
  }

  async function search(query: string, opts: { content: boolean; limit?: number }) {
    const q = query.toLowerCase();
    const limit = opts.limit ?? 100;
    const results: { path: string; line?: number; text?: string }[] = [];
    await walkFiles('/', {
      respectVisibility: true,
      limit: 20000,
      onFile: async (e) => {
        if (results.length >= limit) return;
        if (e.name.toLowerCase().includes(q)) results.push({ path: e.path });
        if (opts.content && e.size <= 512 * 1024) {
          try {
            const { content } = await read(e.path);
            const lines = content.split('\n');
            for (let i = 0; i < lines.length && results.length < limit; i++) {
              if (lines[i].toLowerCase().includes(q)) results.push({ path: e.path, line: i + 1, text: lines[i].trim().slice(0, 200) });
            }
          } catch {
            /* binary or unreadable */
          }
        }
      },
    });
    return results;
  }

  /** Every file under /config, hidden or not: for !include completion and validation. */
  async function index(limit = 5000) {
    const paths: string[] = [];
    await walkFiles('/config', { respectVisibility: false, limit, onFile: (e) => void paths.push(e.path) });
    return paths;
  }

  return { list, index, read, write, create, rename, copy, remove, search, listHistory, readHistory };
}

export type Files = ReturnType<typeof createFiles>;
