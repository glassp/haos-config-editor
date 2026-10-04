import fs from 'node:fs';

export interface Config {
  port: number;
  host: string;
  configDir: string;
  dataDir: string;
  publicDir: string;
  readOnly: boolean;
  showHidden: boolean;
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
  show_hidden?: boolean;
  allow_storage?: boolean;
  max_file_size_kb?: number;
  history_limit?: number;
}

function readOptions(file: string): AddonOptions {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as AddonOptions;
  } catch {
    return {};
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const addon = Boolean(env.SUPERVISOR_TOKEN);
  const dataDir = env.DATA_DIR ?? (addon ? '/data' : './.dev-data');
  const opts = readOptions(env.OPTIONS_FILE ?? `${dataDir}/options.json`);

  const haUrl = env.HA_URL ?? (addon ? 'http://supervisor/core' : null);
  const haToken = env.HA_TOKEN ?? env.SUPERVISOR_TOKEN ?? null;

  return {
    port: Number(env.PORT ?? 8099),
    host: env.HOST ?? (addon ? '0.0.0.0' : '127.0.0.1'),
    configDir: env.CONFIG_DIR ?? (addon ? '/config' : './.dev-config'),
    dataDir,
    publicDir: env.PUBLIC_DIR ?? new URL('../public', import.meta.url).pathname,
    readOnly: opts.read_only ?? env.READ_ONLY === '1',
    showHidden: opts.show_hidden ?? false,
    allowStorage: opts.allow_storage ?? false,
    maxFileSize: (opts.max_file_size_kb ?? 2048) * 1024,
    historyLimit: opts.history_limit ?? 20,
    // Ingress traffic always comes from the Supervisor gateway.
    allowedRemotes: addon && env.ALLOW_ANY_REMOTE !== '1' ? ['172.30.32.2'] : null,
    haUrl,
    haToken,
  };
}
