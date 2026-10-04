import fs from 'node:fs';

export interface Config {
  port: number;
  host: string;
  /** Real directory that backs the editor's virtual "/". */
  rootDir: string;
  /** Top-level folders of "/" the editor may enter. */
  allowedRoots: string[];
  dataDir: string;
  publicDir: string;
  readOnly: boolean;
  allowStorage: boolean;
  maxFileSize: number;
  historyLimit: number;
  /** When set, only these remote addresses may connect (the Supervisor ingress gateway). */
  allowedRemotes: string[] | null;
  haUrl: string | null;
  haToken: string | null;
}

interface AddonOptions {
  read_only?: boolean;
  allowed_roots?: string[];
  allow_storage?: boolean;
  max_file_size_kb?: number;
  history_limit?: number;
}

export const DEFAULT_ROOTS = ['config', 'share', 'ssl', 'media', 'addon_configs', 'addons'];

function readOptions(file: string): AddonOptions {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as AddonOptions;
  } catch {
    return {};
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // ADDON is set by run.sh; /data/options.json exists in every add-on container.
  const addon = Boolean(env.SUPERVISOR_TOKEN) || env.ADDON === '1' || fs.existsSync('/data/options.json');
  const dataDir = env.DATA_DIR ?? (addon ? '/data' : './.dev-data');
  const opts = readOptions(env.OPTIONS_FILE ?? `${dataDir}/options.json`);

  const haUrl = env.HA_URL ?? (addon ? 'http://supervisor/core' : null);
  const haToken = env.HA_TOKEN ?? env.SUPERVISOR_TOKEN ?? null;

  return {
    port: Number(env.PORT ?? 8099),
    host: env.HOST ?? (addon ? '0.0.0.0' : '127.0.0.1'),
    rootDir: env.ROOT_DIR ?? (addon ? '/' : './.dev-root'),
    allowedRoots: env.ALLOWED_ROOTS?.split(',').map((x) => x.trim()).filter(Boolean) ?? opts.allowed_roots ?? DEFAULT_ROOTS,
    dataDir,
    publicDir: env.PUBLIC_DIR ?? new URL('../public', import.meta.url).pathname,
    readOnly: opts.read_only ?? env.READ_ONLY === '1',
    allowStorage: opts.allow_storage ?? false,
    maxFileSize: (opts.max_file_size_kb ?? 2048) * 1024,
    historyLimit: opts.history_limit ?? 20,
    // Ingress traffic always comes from the Supervisor gateway.
    allowedRemotes: addon && env.ALLOW_ANY_REMOTE !== '1' ? ['172.30.32.2'] : null,
    haUrl,
    haToken,
  };
}
