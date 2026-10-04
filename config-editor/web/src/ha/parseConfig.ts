import { ctx } from './context';
import { CONFIG_ROOT_FILE, schemaFor } from '../schemas';
import { ITEM, type PathPart } from './yamlPath';
import { itemsOf, resolvePath } from './schemaWalk';

/**
 * `# parse_config: logger.logs` marks a file as a fragment of /config/configuration.yaml: its
 * whole content is the value at that key path. Anything inside [...] is only a human hint that
 * the segment is a list and is ignored (entities[i], entities[], entities[0] are the same).
 */
export interface Directive {
  raw: string;
  segments: string[];
  /** The path ended in [...]: the file may hold one item instead of the whole list. */
  trailingList: boolean;
  /** Offsets of the comment line. */
  from: number;
  to: number;
  error?: string;
}

const DIRECTIVE_RE = /^[ \t]*#[ \t]*parse_config[ \t]*:[ \t]*(.*?)[ \t]*$/m;
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

export function parseDirectivePath(raw: string): { segments: string[]; trailingList: boolean; error?: string } {
  if (/\[[^\]]*\[|\][^[]*\]|\[[^\]]*$|^[^[]*\]/.test(raw)) return { segments: [], trailingList: false, error: 'Unbalanced [ ] in parse_config path' };
  const trailingList = /\[[^\]]*\]\s*$/.test(raw);
  const clean = raw.replace(/\[[^\]]*\]/g, '');
  const segments = clean.split('.').map((s) => s.trim());
  if (!clean.trim()) return { segments: [], trailingList, error: 'parse_config needs a path, e.g. "# parse_config: logger.logs"' };
  const bad = segments.find((s) => !SEGMENT_RE.test(s));
  if (bad !== undefined) {
    return { segments: [], trailingList, error: bad === '' ? 'Empty segment in parse_config path' : `Invalid segment "${bad}" in parse_config path` };
  }
  return { segments, trailingList };
}

export function findDirective(text: string): Directive | null {
  const m = DIRECTIVE_RE.exec(text);
  if (!m) return null;
  return { raw: m[1], ...parseDirectivePath(m[1]), from: m.index, to: m.index + m[0].length };
}

export interface SchemaContext {
  /** Schema used to resolve $refs. */
  root: object;
  /** Schema the file content is validated against. */
  schema: object;
  /** Key path of the file inside `root` (empty unless a parse_config directive applies). */
  prefix: string[];
  trailingList: boolean;
  /** Set when a directive exists but cannot be resolved. */
  problem?: string;
}

/** Which schema applies to this file: its own, or a slice of configuration.yaml's via parse_config. */
export function schemaContext(text: string, filePath: string): SchemaContext | null {
  const dir = findDirective(text);
  if (!dir) {
    const m = schemaFor(filePath, ctx.customSchemas);
    return m ? { root: m.schema, schema: m.schema, prefix: [], trailingList: false } : null;
  }
  if (dir.error) return null;
  const rootMatch = schemaFor(CONFIG_ROOT_FILE, ctx.customSchemas);
  const sub = rootMatch && resolvePath(rootMatch.schema, dir.segments);
  if (!rootMatch || !sub) return null;
  return { root: rootMatch.schema, schema: sub, prefix: dir.segments, trailingList: dir.trailingList };
}

/** Item schema to use when the file holds a single list element instead of the list. */
export function singleItemSchema(sc: SchemaContext): object | undefined {
  return itemsOf(sc.schema, sc.root);
}

/** Path from the schema root to a position inside the file. */
export function fullPath(sc: SchemaContext, path: PathPart[]): PathPart[] {
  const lead: PathPart[] = sc.trailingList && path[0] !== ITEM ? [ITEM] : [];
  return [...sc.prefix, ...lead, ...path];
}
