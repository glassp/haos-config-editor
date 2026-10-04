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

/** Schema node reached by following `path`, or [] when unknown. */
export function descend(root: S, path: PathPart[]): S[] {
  let nodes = expand(root, root);
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
    // Branches of a oneOf/if-then that were passed through by `expand` are already included.
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
