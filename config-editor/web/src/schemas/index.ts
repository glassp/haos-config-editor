import { automationsFile, configurationFile, scenesFile, scriptsFile } from './ha';

export interface SchemaMatch {
  schema: object;
  /** Stable id used to cache compiled validators. */
  id: string;
}

function globToRegExp(glob: string) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?');
  return new RegExp(`^${re}$`);
}

/** The file whose schema `parse_config` paths are resolved against. */
export const CONFIG_ROOT_FILE = '/config/configuration.yaml';

/** '/config/packages/a.yaml' -> 'packages/a.yaml'; paths outside /config are returned unchanged. */
export const configRel = (path: string) => (path.startsWith('/config/') ? path.slice('/config/'.length) : path);

/** User supplied schemas (from .ha-editor/schemas.json) win over the built in ones. */
export function schemaFor(path: string, custom: Record<string, object> = {}): SchemaMatch | null {
  const rel = configRel(path);
  const inConfig = !rel.startsWith('/');
  for (const [glob, schema] of Object.entries(custom)) {
    const re = globToRegExp(glob);
    if (re.test(rel) || re.test(path)) return { schema, id: `custom:${glob}` };
  }
  if (!inConfig) return null;
  const base = rel.split('/').pop() ?? rel;
  if (base === 'automations.yaml') return { schema: automationsFile, id: 'automations' };
  if (base === 'scripts.yaml') return { schema: scriptsFile, id: 'scripts' };
  if (base === 'scenes.yaml') return { schema: scenesFile, id: 'scenes' };
  if (rel === 'configuration.yaml' || rel.startsWith('packages/')) return { schema: configurationFile, id: 'configuration' };
  return null;
}
