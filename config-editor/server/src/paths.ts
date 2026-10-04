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
  /** Posix-style path relative to the config root ('' for the root itself). */
  rel: string;
}

/**
 * Maps user supplied relative paths onto the config root and refuses anything
 * that would escape it, either lexically (`..`) or through symlinks.
 */
export function createResolver(root: string) {
  const rootAbs = path.resolve(root);
  let realRoot: string | null = null;

  async function getRealRoot() {
    realRoot ??= await fs.realpath(rootAbs);
    return realRoot;
  }

  function inside(base: string, target: string) {
    const r = path.relative(base, target);
    return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
  }

  async function resolve(input: string): Promise<Resolved> {
    if (typeof input !== 'string' || input.includes('\0')) throw new HttpError(400, 'Invalid path');
    const norm = path.posix.normalize('/' + input.replaceAll('\\', '/'));
    const rel = norm.replace(/^\/+/, '').replace(/\/+$/, '');
    if (rel.split('/').includes('..')) throw new HttpError(400, 'Invalid path');
    const abs = path.join(rootAbs, rel);
    if (!inside(rootAbs, abs)) throw new HttpError(400, 'Invalid path');

    // Resolve symlinks of the deepest existing ancestor and make sure it stays inside the root.
    const base = await getRealRoot();
    let probe = abs;
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        if (!inside(base, real)) throw new HttpError(403, 'Path escapes the config directory');
        break;
      } catch (e) {
        if (e instanceof HttpError) throw e;
        const parent = path.dirname(probe);
        if (parent === probe) throw new HttpError(400, 'Invalid path');
        probe = parent;
      }
    }
    return { abs, rel };
  }

  return { resolve, rootAbs };
}

export type PathResolver = ReturnType<typeof createResolver>;
