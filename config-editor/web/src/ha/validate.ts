import { isMap, isScalar, isSeq, parseDocument, visit, type Document, type Node, type Scalar, type YAMLMap } from 'yaml';
import { ctx, type HaContext } from './context';
import { haTags, isHaTag } from './tags';
import { schemaFor } from '../schemas';
import { validateSchema, type Schema, type SchemaError } from './jsonschema';

export interface Problem {
  from: number;
  to: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

const ENTITY_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const SERVICE_KEYS = new Set(['action', 'service']);
const ENTITY_KEYS = new Set(['entity_id', 'entity']);

function nodeRange(n: Node | null | undefined, fallback: [number, number]): [number, number] {
  const r = n?.range;
  return r ? [r[0], r[1]] : fallback;
}

/** Collapse a node's range to its first line, so errors on big blocks do not paint everything red. */
function firstLine(text: string, [from, to]: [number, number]): [number, number] {
  const nl = text.indexOf('\n', from);
  const end = nl === -1 ? to : Math.min(to, nl);
  return [from, Math.max(from + 1, end)];
}

function similar(a: string, b: string) {
  // cheap edit distance, good enough for "did you mean"
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

function suggest(word: string, options: string[]) {
  let best: string | null = null;
  let score = 3;
  for (const o of options) {
    const s = similar(word, o);
    if (s < score) {
      score = s;
      best = o;
    }
  }
  return best;
}

function describe(e: SchemaError, allowedHere: string[]): string {
  const p = e.params;
  switch (e.keyword) {
    case 'additionalProperties': {
      const prop = String(p.additionalProperty);
      const hint = suggest(prop, allowedHere);
      return `Unknown key "${prop}"${hint ? ` — did you mean "${hint}"?` : ''}`;
    }
    case 'required':
      return `Missing required key "${p.missingProperty}"`;
    case 'enum':
      return `Must be one of: ${(p.allowedValues as unknown[]).join(', ')}`;
    case 'const':
      return `Must be "${p.allowedValue}"`;
    case 'type':
      return `Expected ${Array.isArray(p.type) ? (p.type as string[]).join(' or ') : p.type}`;
    case 'anyOf':
      return 'Missing one of the required keys';
    case 'minimum':
      return `Must be at least ${p.limit}`;
    case 'maximum':
      return `Must be at most ${p.limit}`;
    case 'oneOf':
      return "Value doesn't match any allowed form";
    default:
      return 'Invalid value';
  }
}

/** Walk a schema error path down the YAML AST. */
function nodeAt(doc: Document, parts: (string | number)[]): Node | null {
  let node: unknown = doc.contents;
  for (const part of parts) {
    if (isMap(node)) {
      const pair = node.items.find((i) => String((i.key as Scalar)?.value ?? i.key) === String(part));
      node = pair?.value ?? null;
    } else if (isSeq(node)) node = node.items[Number(part)] ?? null;
    else return null;
  }
  return (node as Node) ?? null;
}

function keyRange(map: Node | null, key: string): [number, number] | null {
  if (!isMap(map)) return null;
  const pair = (map as YAMLMap).items.find((i) => String((i.key as Scalar)?.value) === key);
  const r = (pair?.key as Node | undefined)?.range;
  return r ? [r[0], r[1]] : null;
}

const ptr = (path: (string | number)[]) => path.join('\u0001');
const isInside = (path: (string | number)[], tagged: string[]) => {
  const p = ptr(path);
  return tagged.some((t) => p === t || p.startsWith(t + '\u0001') || t === '');
};

/** Paths of nodes carrying `!include`/`!secret`/… tags: their real value is unknown to us. */
function taggedPaths(doc: Document): string[] {
  const out: string[] = [];
  const walk = (node: unknown, path: (string | number)[]) => {
    if (isScalar(node)) {
      if (isHaTag(node.tag)) out.push(ptr(path));
    } else if (isMap(node)) {
      for (const p of node.items) walk(p.value, [...path, String((p.key as Scalar)?.value)]);
    } else if (isSeq(node)) node.items.forEach((it, i) => walk(it, [...path, i]));
  };
  walk(doc.contents, []);
  return out;
}

function dirOf(path: string) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function joinPath(dir: string, rel: string) {
  const parts = (dir ? dir.split('/') : []).concat(rel.split('/'));
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  return out.join('/');
}

function checkTags(doc: Document, filePath: string, c: HaContext, out: Problem[]) {
  visit(doc, {
    Scalar(_k, node) {
      const tag = node.tag;
      if (!isHaTag(tag) || !node.range) return;
      const value = String(node.value ?? '').trim();
      const range: [number, number] = [node.range[0], node.range[1]];
      if (tag === '!secret') {
        if (c.secrets.size && !c.secrets.has(value)) {
          out.push({ ...pos(range), severity: 'error', message: `Secret "${value}" is not defined in secrets.yaml` });
        }
      } else if (tag.startsWith('!include')) {
        if (!c.paths.size) return;
        const target = joinPath(dirOf(filePath), value);
        const isDirInclude = tag.startsWith('!include_dir');
        const exists = isDirInclude
          ? [...c.paths].some((p) => p.startsWith(target + '/'))
          : c.paths.has(target);
        if (!exists) {
          out.push({
            ...pos(range),
            severity: isDirInclude ? 'warning' : 'error',
            message: isDirInclude ? `No files found in "${target}"` : `Included file "${target}" does not exist`,
          });
        }
      }
    },
  });
}

const pos = ([from, to]: [number, number]) => ({ from, to });

function checkEntities(doc: Document, c: HaContext, out: Problem[]) {
  const checkEntity = (node: Scalar) => {
    if (node.tag && isHaTag(node.tag)) return;
    const raw = typeof node.value === 'string' ? node.value : null;
    if (!raw || raw.includes('{{') || !node.range) return;
    for (const id of raw.split(',').map((s) => s.trim())) {
      if (!ENTITY_RE.test(id) || id === 'all' || id === 'none') continue;
      const domain = id.split('.')[0];
      if (c.entityDomains.has(domain) && !c.entityIds.has(id)) {
        out.push({ ...pos([node.range[0], node.range[1]]), severity: 'warning', message: `Unknown entity "${id}"` });
      }
    }
  };
  visit(doc, {
    Pair(_k, pair) {
      const key = isScalar(pair.key) ? String(pair.key.value) : '';
      const v = pair.value;
      if (ENTITY_KEYS.has(key)) {
        if (isScalar(v)) checkEntity(v);
        else if (isSeq(v)) v.items.forEach((it) => isScalar(it) && checkEntity(it));
      }
      if (SERVICE_KEYS.has(key) && isScalar(v) && typeof v.value === 'string' && v.range) {
        const val = v.value;
        if (/^[a-z0-9_]+\.[a-z0-9_]+$/.test(val)) {
          const [domain, service] = val.split('.');
          if (Object.keys(c.services).length && !c.services[domain]?.[service]) {
            out.push({ ...pos([v.range[0], v.range[1]]), severity: 'warning', message: `Unknown action "${val}"` });
          }
        }
      }
    },
  });
}

export function validateYaml(text: string, filePath: string, c: HaContext = ctx): Problem[] {
  const problems: Problem[] = [];
  const doc = parseDocument(text, { customTags: haTags, uniqueKeys: true, prettyErrors: false });

  for (const e of doc.errors) {
    problems.push({ from: e.pos[0], to: Math.max(e.pos[0] + 1, e.pos[1]), severity: 'error', message: e.message.split('\n')[0] });
  }
  for (const w of doc.warnings) {
    problems.push({ from: w.pos[0], to: Math.max(w.pos[0] + 1, w.pos[1]), severity: 'warning', message: w.message.split('\n')[0] });
  }
  if (doc.errors.length) return problems;

  checkTags(doc, filePath, c, problems);
  checkEntities(doc, c, problems);

  const match = schemaFor(filePath, c.customSchemas);
  if (match && doc.contents) {
    const errors = validateSchema(match.schema as Schema, doc.toJS({ maxAliasCount: -1 }));
    const tagged = taggedPaths(doc);
    const seen = new Set<string>();
    for (const e of errors) {
      if (isInside(e.path, tagged)) continue;
      const node = nodeAt(doc, e.path);
      const fallback: [number, number] = [0, Math.min(text.length, 1)];
      let range: [number, number];
      let allowed: string[] = [];
      if (e.keyword === 'additionalProperties') {
        const prop = String(e.params.additionalProperty);
        range = keyRange(node, prop) ?? firstLine(text, nodeRange(node, fallback));
        allowed = Object.keys(e.schema.properties ?? {});
      } else {
        range = firstLine(text, nodeRange(node, fallback));
      }
      const message = describe(e, allowed);
      const sig = `${range[0]}:${message}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      problems.push({ ...pos(range), severity: 'error', message });
    }
  }
  return problems;
}

export function validateJson(text: string): Problem[] {
  if (!text.trim()) return [];
  try {
    JSON.parse(text);
    return [];
  } catch (e) {
    const m = /position (\d+)/.exec((e as Error).message);
    const at = m ? Number(m[1]) : 0;
    return [{ from: Math.min(at, text.length), to: Math.min(at + 1, text.length), severity: 'error', message: (e as Error).message }];
  }
}
