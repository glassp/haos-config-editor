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

/** User supplied schemas (from .ha-editor/schemas.json) win over the built in ones. */
export function schemaFor(path: string, custom: Record<string, object> = {}): SchemaMatch | null {
  for (const [glob, schema] of Object.entries(custom)) {
    if (globToRegExp(glob).test(path)) return { schema, id: `custom:${glob}` };
  }
  const base = path.split('/').pop() ?? path;
  if (path === 'automations.yaml' || base === 'automations.yaml') return { schema: automationsFile, id: 'automations' };
  if (base === 'scripts.yaml') return { schema: scriptsFile, id: 'scripts' };
  if (base === 'scenes.yaml') return { schema: scenesFile, id: 'scenes' };
  if (path === 'configuration.yaml' || path.startsWith('packages/')) return { schema: configurationFile, id: 'configuration' };
  return null;
}
