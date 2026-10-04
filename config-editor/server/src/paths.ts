import fs from 'node:fs/promises';
import path from 'node:path';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Resolved {
  /** Absolute path on disk. */
  abs: string;
  /** Virtual path as seen by the editor: '/' or '/config/automations.yaml'. */
  rel: string;
  /** Top-level mount ("config", "share", ...) or null for '/'. */
  mount: string | null;
}

/**
 * The editor exposes a virtual "/" that lists a fixed set of top-level folders (the Home
 * Assistant mounts). Every path is confined to one of those folders, lexically and through
 * symlinks. Anything else in the container (/data, /etc, ...) is unreachable.
 */
export function createResolver(rootDir: string, allowedRoots: string[]) {
  const rootAbs = path.resolve(rootDir);
  const allowed = new Set(allowedRoots);
  const realRoots = new Map<string, string>();

  async function realRoot(mount: string) {
    let r = realRoots.get(mount);
    if (!r) {
      r = await fs.realpath(path.join(rootAbs, mount));
      realRoots.set(mount, r);
    }
    return r;
  }

  const inside = (base: string, target: string) => {
    const r = path.relative(base, target);
    return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
  };

  async function resolve(input: string): Promise<Resolved> {
    if (typeof input !== 'string' || input.includes('\0')) throw new HttpError(400, 'Invalid path');
    const norm = path.posix.normalize('/' + input.replaceAll('\\', '/'));
    const rel = norm === '/' ? '/' : norm.replace(/\/+$/, '');
    if (rel === '/') return { abs: rootAbs, rel, mount: null };

    const mount = rel.split('/')[1];
    if (!allowed.has(mount)) throw new HttpError(403, `"/${mount}" is not available in this editor`);
    const abs = path.join(rootAbs, rel);

    let base: string;
    try {
      base = await realRoot(mount);
    } catch {
      throw new HttpError(404, `"/${mount}" is not mounted`);
    }
    // Resolve symlinks of the deepest existing ancestor and make sure it stays inside the mount.
    let probe = abs;
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        if (!inside(base, real)) throw new HttpError(403, 'Path escapes its folder');
        break;
      } catch (e) {
        if (e instanceof HttpError) throw e;
        const parent = path.dirname(probe);
        if (parent === probe) throw new HttpError(400, 'Invalid path');
        probe = parent;
      }
    }
    return { abs, rel, mount };
  }

  return { resolve, rootAbs, allowedRoots: [...allowed] };
}

export type PathResolver = ReturnType<typeof createResolver>;
