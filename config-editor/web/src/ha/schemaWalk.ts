import { ITEM, type PathPart } from './yamlPath';

type S = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface PropInfo {
  schema: S;
  description?: string;
}

/** Resolve local $refs and flatten allOf/anyOf/oneOf and if/then branches into a list of candidate object schemas. */
export function expand(node: S | undefined, root: S, siblings: Record<string, string> = {}, depth = 0): S[] {
  if (!node || typeof node !== 'object' || depth > 12) return [];
  if (node.$ref) {
    const target = resolveRef(node.$ref, root);
    const rest = { ...node };
    delete rest.$ref;
    return [...expand(target, root, siblings, depth + 1), ...(Object.keys(rest).length ? [rest] : [])];
  }
  const out: S[] = [node];
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    for (const branch of node[key] ?? []) out.push(...expand(branch, root, siblings, depth + 1));
  }
  // Pick `if/then` variants whose discriminator matches the sibling values typed so far.
  if (node.if && node.then) {
    const props = node.if.properties ?? {};
    const keys = Object.keys(props);
    if (keys.length && keys.every((k) => 'const' in props[k] && siblings[k] === props[k].const)) {
      out.push(...expand(node.then, root, siblings, depth + 1));
    }
  }
  if (node.else) out.push(...expand(node.else, root, siblings, depth + 1));
  if (node.then && !node.if?.properties) out.push(...expand(node.then, root, siblings, depth + 1));
  return out;
}

function resolveRef(ref: string, root: S): S | undefined {
  if (!ref.startsWith('#/')) return undefined;
  return ref
    .slice(2)
    .split('/')
    .reduce<S | undefined>((n, k) => n?.[k], root);
}

function deref(node: S | undefined, root: S): S | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (!node.$ref) return node;
  const target = resolveRef(node.$ref, root);
  const { $ref, ...rest } = node; // eslint-disable-line @typescript-eslint/no-unused-vars
  return target ? { ...target, ...rest } : undefined;
}

/** Items schema of an array-ish node (including the then-branch of "one or a list" schemas). */
export function itemsOf(node: S | undefined, root: S): S | undefined {
  const n = deref(node, root);
  return deref(n?.items, root) ?? deref(n?.then?.items, root);
}

function findChild(node: S | undefined, key: string, root: S, depth = 0): S | undefined {
  const n = deref(node, root);
  if (!n || depth > 8) return undefined;
  if (n.properties?.[key]) return n.properties[key];
  for (const [pattern, sub] of Object.entries<S>(n.patternProperties ?? {})) if (new RegExp(pattern).test(key)) return sub;
  for (const k of ['allOf', 'anyOf', 'oneOf']) {
    for (const b of n[k] ?? []) {
      const r = findChild(b, key, root, depth + 1);
      if (r) return r;
    }
  }
  for (const b of [n.then, n.else]) {
    const r = b && findChild(b, key, root, depth + 1);
    if (r) return r;
  }
  if (n.additionalProperties && typeof n.additionalProperties === 'object') return n.additionalProperties;
  // A list: keys address the items' properties ("entities.xyz" means entities[].xyz).
  const items = itemsOf(n, root);
  return items ? findChild(items, key, root, depth + 1) : undefined;
}

/**
 * Resolve a dotted key path (as written in a `parse_config` directive, brackets already removed)
 * to a single schema node. Lists are stepped through implicitly.
 */
export function resolvePath(root: S, segments: string[]): S | null {
  let node: S | undefined = root;
  for (const seg of segments) {
    node = findChild(node, seg, root);
    if (!node) return null;
  }
  return deref(node, root) ?? null;
}

/** Schema nodes reached by following `path`, or [] when unknown. ITEM steps into list items. */
export function descend(root: S, path: PathPart[], start: S = root): S[] {
  let nodes = expand(start, root);
  for (const part of path) {
    const next: S[] = [];
    for (const n of nodes) {
      if (part === ITEM) {
        if (n.items) next.push(...expand(n.items, root));
        // a single object where a list is also allowed behaves like one item
        else if (n.properties || n.additionalProperties) next.push(n);
      } else if (n.properties?.[part]) next.push(...expand(n.properties[part], root));
      else if (n.additionalProperties && typeof n.additionalProperties === 'object') {
        next.push(...expand(n.additionalProperties, root));
      }
    }
    if (!next.length) {
      // implicit list step: "entities" followed by a key means the key of the items
      for (const n of nodes) {
        for (const item of expand(n.items, root)) {
          if (item.properties?.[part]) next.push(...expand(item.properties[part], root));
          else if (item.additionalProperties && typeof item.additionalProperties === 'object') next.push(...expand(item.additionalProperties, root));
        }
      }
    }
    nodes = next;
    if (!nodes.length) break;
  }
  return nodes;
}

/** Property names (and their schemas) offered at the object described by `nodes`. */
export function propertiesOf(nodes: S[], root: S, siblings: Record<string, string>): Map<string, PropInfo> {
  const out = new Map<string, PropInfo>();
  for (const n of nodes) {
    for (const branch of expand(n, root, siblings)) {
      for (const [k, v] of Object.entries<S>(branch.properties ?? {})) {
        if (!out.has(k)) out.set(k, { schema: v, description: v.description });
      }
    }
  }
  return out;
}

/** Enumerated values for the schema node(s), if any. */
export function enumValues(nodes: S[], root: S): string[] {
  const out = new Set<string>();
  for (const n of nodes) {
    for (const b of expand(n, root)) {
      for (const v of b.enum ?? []) out.add(String(v));
      if ('const' in b) out.add(String(b.const));
      if (b.type === 'boolean' || (Array.isArray(b.type) && b.type.length === 1 && b.type[0] === 'boolean')) {
        out.add('true');
        out.add('false');
      }
    }
  }
  return [...out];
}
