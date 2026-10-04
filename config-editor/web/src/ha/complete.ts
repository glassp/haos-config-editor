import { autocompletion, completionKeymap, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { Facet } from '@codemirror/state';
import { ctx, type HaContext } from './context';
import { CONFIG_ROOT_FILE, configRel, schemaFor } from '../schemas';
import { descend, enumValues, propertiesOf, resolvePath } from './schemaWalk';
import { fullPath, parseDirectivePath, schemaContext } from './parseConfig';
import { prepareSchemas } from './prepare';
import { HA_TAG_NAMES } from './tags';
import { ITEM, pathFor, parseLine, siblingKeys, siblingScalars, type PathPart } from './yamlPath';

/** Path of the file being edited, relative to the config root. */
export const filePathFacet = Facet.define<string, string>({ combine: (v) => v[0] ?? '' });

const JINJA = [
  ['states', "states('${}')"],
  ['is_state', "is_state('${}', '${}')"],
  ['state_attr', "state_attr('${}', '${}')"],
  ['is_state_attr', "is_state_attr('${}', '${}', '${}')"],
  ['has_value', "has_value('${}')"],
  ['now', 'now()'],
  ['utcnow', 'utcnow()'],
  ['today_at', "today_at('${}')"],
  ['as_timestamp', 'as_timestamp(${})'],
  ['relative_time', 'relative_time(${})'],
  ['timedelta', 'timedelta(${})'],
  ['float', 'float(${0})'],
  ['int', 'int(${0})'],
  ['round', 'round(${1})'],
  ['area_name', "area_name('${}')"],
  ['area_entities', "area_entities('${}')"],
  ['device_id', "device_id('${}')"],
  ['expand', "expand('${}')"],
  ['trigger', 'trigger.${}'],
  ['iif', 'iif(${}, ${}, ${})'],
  ['min', 'min(${})'],
  ['max', 'max(${})'],
];

const entityKeys = new Set(['entity_id', 'entity', 'entities', 'above_entity', 'source']);
const serviceKeys = new Set(['action', 'service']);

function entityOptions(c: HaContext, typedDomain?: string): Completion[] {
  return c.entities
    .filter((e) => !typedDomain || e.entity_id.startsWith(typedDomain + '.'))
    .map((e) => ({ label: e.entity_id, detail: e.name || e.state, type: 'variable', boost: 1 }));
}

function serviceOptions(c: HaContext): Completion[] {
  return Object.entries(c.services).flatMap(([domain, svcs]) =>
    Object.entries(svcs).map(([name, def]) => ({
      label: `${domain}.${name}`,
      detail: def.name,
      info: def.description,
      type: 'function',
    })),
  );
}

/** Field definitions for `data:` of the service named in `siblings`. */
function serviceFields(c: HaContext, siblings: Record<string, string>): Completion[] {
  const full = siblings.action ?? siblings.service;
  if (!full || !full.includes('.')) return [];
  const [domain, service] = full.split('.');
  const out: Completion[] = [];
  const collect = (fields: Record<string, { name?: string; description?: string; fields?: Record<string, never> }> | undefined) => {
    for (const [k, f] of Object.entries(fields ?? {})) {
      if (f.fields) collect(f.fields as never);
      else out.push({ label: k, detail: f.name, info: f.description, type: 'property', apply: `${k}: ` });
    }
  };
  collect(c.services[domain]?.[service]?.fields as never);
  return out;
}

function lastKey(path: PathPart[]): string | null {
  for (let i = path.length - 1; i >= 0; i--) if (path[i] !== ITEM) return path[i] as string;
  return null;
}

/** Synchronous core: uses whatever schemas are loaded. */
export function completeYaml(context: CompletionContext): CompletionResult | null {
  const { state, pos } = context;
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  const filePath = state.facet(filePathFacet);
  const lines = state.doc.toString().split('\n');
  const lineIdx = line.number - 1;
  const c = ctx;

  // --- `# parse_config: a.b` paths --------------------------------------------------
  const dm = /^[ \t]*#[ \t]*parse_config[ \t]*:[ \t]*([\w.-]*)$/.exec(before);
  if (dm) {
    const rootSchema = schemaFor(CONFIG_ROOT_FILE, c.customSchemas)?.schema as never;
    if (!rootSchema) return null;
    const lastDot = dm[1].lastIndexOf('.');
    const head = lastDot === -1 ? [] : parseDirectivePath(dm[1].slice(0, lastDot)).segments;
    const node = head.length ? resolvePath(rootSchema, head) : rootSchema;
    if (!node) return null;
    let props = propertiesOf(descend(rootSchema, [], node as never), rootSchema, {});
    if (!props.size) props = propertiesOf(descend(rootSchema, [ITEM], node as never), rootSchema, {});
    const partial = dm[1].slice(lastDot + 1);
    return {
      from: pos - partial.length,
      options: [...props.entries()].map(([k, p]) => ({ label: k, type: 'property', info: p.description })),
      validFor: /^[\w-]*$/,
    };
  }

  // --- tags: !secret, !include ... -------------------------------------------------
  const tagArg = /(!(?:secret|include\w*|env_var|input))\s+([^\s#]*)$/.exec(before);
  if (tagArg) {
    const from = pos - tagArg[2].length;
    if (tagArg[1] === '!secret') {
      return { from, options: [...c.secrets].map((k) => ({ label: k, type: 'constant' })), validFor: /^[\w-]*$/ };
    }
    if (tagArg[1].startsWith('!include')) {
      const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/') + 1) : '';
      const dirOnly = tagArg[1].startsWith('!include_dir');
      const items = new Set<string>();
      for (const p of c.paths) {
        if (!p.startsWith(dir)) continue;
        const rel = p.slice(dir.length);
        if (dirOnly) {
          const parts = rel.split('/');
          for (let i = 1; i < parts.length; i++) items.add(parts.slice(0, i).join('/'));
        } else if (/\.ya?ml$/.test(rel)) items.add(rel);
      }
      return { from, options: [...items].sort().map((p) => ({ label: p, type: 'file' })), validFor: /^[\w./-]*$/ };
    }
    return null;
  }
  const tagStart = /(?:^|:\s+|-\s+)(![\w]*)$/.exec(before);
  if (tagStart) {
    return { from: pos - tagStart[1].length, options: HA_TAG_NAMES.map((t) => ({ label: t, type: 'keyword' })), validFor: /^![\w]*$/ };
  }

  // --- Jinja ------------------------------------------------------------------------
  const inTemplate = /\{\{[^}]*$|\{%[^%]*$/.test(before);
  const word = context.matchBefore(/[A-Za-z_][\w.]*/);

  // entity ids anywhere a "domain.partial" token is typed (values, templates, flow lists)
  if (word && word.text.includes('.') && !/^\s*[\w-]+\s*$/.test(before)) {
    const domain = word.text.split('.')[0];
    if (c.entityDomains.has(domain)) {
      return { from: word.from, options: entityOptions(c, domain), validFor: /^[\w.]*$/ };
    }
  }

  const info = parseLine(line.text);
  const colon = before.indexOf(':');
  const isKeyPosition = colon === -1 || !/^\s*(-\s+)*[^\s:#][^:#]*:/.test(before);

  if (isKeyPosition) {
    // scalar list item under entity_id: ... / action: ...
    if (info.dashCol !== null && !/^\s*(-\s+)+[^:]*:/.test(before)) {
      const { path } = pathFor(lines, lineIdx);
      const key = path.length >= 2 && path.at(-1) === ITEM ? lastKey(path.slice(0, -1)) : null;
      const m = context.matchBefore(/[\w.]*/);
      if (key && entityKeys.has(key) && m && (m.text || context.explicit)) {
        return { from: m.from, options: entityOptions(c), validFor: /^[\w.]*$/ };
      }
    }
    // property names
    const m = context.matchBefore(/[\w-]*/);
    if (!m || (!m.text && !context.explicit)) return null;
    // only directly after indentation / list dashes
    if (!/^\s*(-\s+)*$/.test(before.slice(0, m.from - line.from))) return null;
    const { path, lines: at } = pathFor(lines, lineIdx);
    const siblings = siblingScalars(lines, lineIdx);
    const present = siblingKeys(lines, lineIdx);
    return {
      from: m.from,
      options: keyOptions(filePath, state.doc.toString(), path, at, lines, siblings).filter((o) => !present.has(o.label)),
      validFor: /^[\w-]*$/,
    };
  }

  // value position: `key: <cursor>`
  const key = info.key;
  if (!key) return null;
  const valueStart = before.slice(colon + 1);
  const m = context.matchBefore(/[\w.@-]*/);
  const from = m ? m.from : pos;
  if (serviceKeys.has(key) && !inTemplate) {
    if (!m || (!m.text && !context.explicit && !/:\s*$/.test(before))) return null;
    return { from, options: serviceOptions(c), validFor: /^[\w.]*$/ };
  }
  if (entityKeys.has(key) && !inTemplate) {
    return { from, options: entityOptions(c), validFor: /^[\w.]*$/ };
  }
  if (inTemplate && m) {
    return { from: m.from, options: JINJA.map(([label, apply]) => ({ label, type: 'function', apply: snippetLike(apply) })), validFor: /^\w*$/ };
  }
  // enum / boolean values from the schema
  const sc = schemaContext(state.doc.toString(), filePath);
  if (sc) {
    const { path } = pathFor(lines, lineIdx);
    const nodes = descend(sc.root as never, fullPath(sc, path));
    const props = propertiesOf(nodes, sc.root as never, siblingScalars(lines, lineIdx));
    const vals = enumValues(props.get(key) ? [props.get(key)!.schema] : [], sc.root as never);
    if (vals.length && /^\s*[\w.-]*$/.test(valueStart)) {
      return { from, options: vals.map((v) => ({ label: v, type: 'enum' })), validFor: /^[\w.-]*$/ };
    }
  }
  return null;
}

/** Turn `foo('${}')` style templates into plain text with the cursor left inside the first quotes. */
function snippetLike(t: string) {
  return (view: import('@codemirror/view').EditorView, _c: Completion, from: number, to: number) => {
    const first = t.indexOf('${}');
    const text = t.replace(/\$\{\d?\}/g, '');
    const cursor = first === -1 ? text.length : first;
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + cursor } });
  };
}

function keyOptions(filePath: string, text: string, path: PathPart[], at: number[], lines: string[], siblings: Record<string, string>): Completion[] {
  const c = ctx;
  const out: Completion[] = [];
  const sc = schemaContext(text, filePath);
  const key = lastKey(path);

  // service data: fields come from the live service registry
  if ((key === 'data' || key === 'service_data') && path.at(-1) !== ITEM) {
    const ownerLine = at[path.length - 1];
    const sib = siblingScalars(lines, ownerLine);
    out.push(...serviceFields(c, sib));
  }
  if (key === 'target' && path.at(-1) !== ITEM) {
    for (const k of ['entity_id', 'device_id', 'area_id', 'floor_id', 'label_id']) out.push({ label: k, type: 'property', apply: `${k}: ` });
  }

  if (sc) {
    const nodes = descend(sc.root as never, fullPath(sc, path));
    for (const [k, p] of propertiesOf(nodes, sc.root as never, siblings)) {
      out.push({ label: k, type: 'property', ...(path.length === 0 && !sc.prefix.length ? { detail: p.description } : { info: p.description }), apply: `${k}: ` });
    }
  }

  // top level of configuration.yaml / packages: integrations that are loaded in HA
  const rel = configRel(filePath);
  if (path.length === 0 && !sc?.prefix.length && (rel === 'configuration.yaml' || rel.startsWith('packages/'))) {
    const seen = new Set(out.map((o) => o.label));
    for (const comp of c.components) {
      if (comp.includes('.') || seen.has(comp)) continue;
      out.push({ label: comp, type: 'namespace', apply: `${comp}:\n  `, boost: -1 });
    }
  }
  const unique = new Map<string, Completion>();
  for (const o of out) if (!unique.has(o.label)) unique.set(o.label, o);
  return [...unique.values()];
}

/** Loads the integration schemas the document needs, then completes. */
export async function yamlCompletions(context: CompletionContext): Promise<CompletionResult | null> {
  const { state, pos } = context;
  const line = state.doc.lineAt(pos);
  const dm = /^[ \t]*#[ \t]*parse_config[ \t]*:[ \t]*([\w-]+)\./.exec(line.text.slice(0, pos - line.from));
  await prepareSchemas(state.doc.toString(), state.facet(filePathFacet), dm ? [dm[1]] : []);
  return completeYaml(context);
}

export const haAutocomplete = () =>
  autocompletion({
    override: [yamlCompletions],
    activateOnTyping: true,
    maxRenderedOptions: 60,
    icons: false,
    tooltipClass: () => 'cm-ha-tooltip',
  });

export { completionKeymap };
