/**
 * A small JSON Schema interpreter. Ajv compiles schemas with `new Function`, which the
 * add-on's Content-Security-Policy (no unsafe-eval) forbids, so validation is interpreted.
 * Supports the subset used by the built-in schemas and typical user schemas.
 */

export type Schema = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface SchemaError {
  path: (string | number)[];
  keyword: string;
  params: Record<string, unknown>;
  /** Schema object that raised the error (lets callers list allowed keys). */
  schema: Schema;
}

const typeOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;

function matchesType(t: string, v: unknown): boolean {
  const actual = typeOf(v);
  return actual === t || (t === 'number' && actual === 'integer');
}

const reCache = new Map<string, RegExp | null>();
/** Patterns come from Python (`re`); ones JavaScript cannot compile yield null and are ignored, never an error. */
function matches(pattern: string, value: string): boolean | null {
  let re = reCache.get(pattern);
  if (re === undefined) {
    try {
      re = new RegExp(pattern);
    } catch {
      re = null;
    }
    reCache.set(pattern, re);
  }
  return re ? re.test(value) : null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Validate `data` against `schema` (default: the root). `$ref`s always resolve against `root`. */
export function validateSchema(root: Schema, data: unknown, schema: Schema = root): SchemaError[] {
  const errors: SchemaError[] = [];
  walk(schema, data, [], errors, root, 0);
  return errors;
}

function resolveRef(ref: string, root: Schema): Schema | undefined {
  if (!ref.startsWith('#')) return undefined;
  return ref
    .slice(1)
    .split('/')
    .filter(Boolean)
    .reduce<Schema | undefined>((n, k) => n?.[decodeURIComponent(k).replace(/~1/g, '/').replace(/~0/g, '~')], root);
}

function walk(schema: Schema | boolean, data: unknown, path: (string | number)[], out: SchemaError[], root: Schema, depth: number) {
  if (schema === true || schema === undefined || depth > 40) return;
  const fail = (keyword: string, params: Record<string, unknown> = {}) => out.push({ path, keyword, params, schema: schema as Schema });
  if (schema === false) return fail('false');
  const s = schema as Schema;

  if (s.$ref) {
    const target = resolveRef(s.$ref, root);
    if (target) walk(target, data, path, out, root, depth + 1);
  }

  if (s.type !== undefined) {
    const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => matchesType(t, data))) {
      fail('type', { type: s.type });
      return; // everything below assumes the right type
    }
  }
  if (s.enum) {
    // x-case-insensitive: HA upper/lower-cases the value before comparing (vol.Upper, vol.Lower)
    const fold = s['x-case-insensitive'] && typeof data === 'string' ? data.toLowerCase() : null;
    const ok = s.enum.some((e: unknown) => (fold !== null && typeof e === 'string' ? e.toLowerCase() === fold : deepEqual(e, data)));
    if (!ok) fail('enum', { allowedValues: s.enum });
  }
  if ('const' in s && !deepEqual(s.const, data)) fail('const', { allowedValue: s.const });

  if (typeof data === 'number') {
    if (s.minimum !== undefined && data < s.minimum) fail('minimum', { limit: s.minimum });
    if (s.maximum !== undefined && data > s.maximum) fail('maximum', { limit: s.maximum });
    if (s.exclusiveMinimum !== undefined && data <= s.exclusiveMinimum) fail('minimum', { limit: s.exclusiveMinimum });
    if (s.exclusiveMaximum !== undefined && data >= s.exclusiveMaximum) fail('maximum', { limit: s.exclusiveMaximum });
  }
  if (typeof data === 'string') {
    if (s.minLength !== undefined && data.length < s.minLength) fail('minLength', { limit: s.minLength });
    if (s.maxLength !== undefined && data.length > s.maxLength) fail('maxLength', { limit: s.maxLength });
    if (s.pattern && matches(s.pattern, data) === false) fail('pattern', { pattern: s.pattern });
  }

  if (Array.isArray(data)) {
    if (s.minItems !== undefined && data.length < s.minItems) fail('minItems', { limit: s.minItems });
    if (s.maxItems !== undefined && data.length > s.maxItems) fail('maxItems', { limit: s.maxItems });
    if (s.items && typeof s.items === 'object') data.forEach((item, i) => walk(s.items, item, [...path, i], out, root, depth + 1));
  } else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const k of s.required ?? []) if (!(k in obj)) fail('required', { missingProperty: k });
    const props = s.properties ?? {};
    for (const [k, v] of Object.entries(obj)) {
      let matched = false;
      if (k in props) {
        matched = true;
        walk(props[k], v, [...path, k], out, root, depth + 1);
      }
      for (const [pattern, sub] of Object.entries<Schema>(s.patternProperties ?? {})) {
        if (matches(pattern, k) === true) {
          matched = true;
          walk(sub, v, [...path, k], out, root, depth + 1);
        }
      }
      if (!matched && s.additionalProperties !== undefined) {
        if (s.additionalProperties === false) fail('additionalProperties', { additionalProperty: k }) ;
        else if (typeof s.additionalProperties === 'object') walk(s.additionalProperties, v, [...path, k], out, root, depth + 1);
      }
    }
  }

  for (const sub of s.allOf ?? []) walk(sub, data, path, out, root, depth + 1);
  if (s.anyOf && !s.anyOf.some((sub: Schema) => passes(sub, data, root, depth))) {
    // If only one alternative fits the value's type, its errors are the useful ones.
    const fitting = s.anyOf.filter((sub: Schema) => typeFits(sub, data, root));
    if (fitting.length === 1) walk(fitting[0], data, path, out, root, depth + 1);
    else fail('anyOf');
  }
  if (s.oneOf && s.oneOf.filter((sub: Schema) => passes(sub, data, root, depth)).length !== 1) fail('oneOf');
  if (s.not && passes(s.not, data, root, depth)) fail('not');
  if (s.if) {
    if (passes(s.if, data, root, depth)) {
      if (s.then) walk(s.then, data, path, out, root, depth + 1);
    } else if (s.else) walk(s.else, data, path, out, root, depth + 1);
  }
}

/** Does the schema's `type` admit this value (ignoring everything else)? Untyped schemas fit anything. */
function typeFits(schema: Schema, data: unknown, root: Schema): boolean {
  const s = schema.$ref ? resolveRef(schema.$ref, root) ?? schema : schema;
  if (s.type === undefined) return true;
  return (Array.isArray(s.type) ? s.type : [s.type]).some((t: string) => matchesType(t, data));
}

function passes(schema: Schema, data: unknown, root: Schema, depth: number) {
  const scratch: SchemaError[] = [];
  walk(schema, data, [], scratch, root, depth + 1);
  return scratch.length === 0;
}
