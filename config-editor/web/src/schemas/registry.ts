import type { Schema } from '../ha/jsonschema';
import { builtinDefs, builtinIntegrations } from './ha';

/**
 * Integration schemas for configuration.yaml. They are generated from Home Assistant itself
 * (tools/schemagen) and served as one small JSON file per integration, fetched on demand.
 */
export interface IndexEntry {
  name: string;
  kind: 'config' | 'platform';
  doc?: string;
  platforms?: number;
}

interface Loaded {
  schema: Schema;
  defs: Record<string, Schema>;
}

type Fetcher = (path: string) => Promise<unknown>;

// Relative URL: works under the Home Assistant ingress path prefix.
let fetchJson: Fetcher = async (path) => {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
};

const loaded = new Map<string, Loaded | null>();
const inflight = new Map<string, Promise<void>>();
let index: Record<string, IndexEntry> = {};
let haVersion = '';
let initPromise: Promise<void> | null = null;
let revision = 0;
let cachedRoot: { revision: number; schema: Schema } | null = null;

export const registry = {
  /** For tests and tools: where schema files come from. */
  setFetcher(fn: Fetcher) {
    fetchJson = fn;
    this.reset();
  },
  reset() {
    loaded.clear();
    inflight.clear();
    index = {};
    initPromise = null;
    cachedRoot = null;
    revision++;
  },
  get index() {
    return index;
  },
  get haVersion() {
    return haVersion;
  },
  get revision() {
    return revision;
  },
  init(): Promise<void> {
    initPromise ??= (async () => {
      try {
        const data = (await fetchJson('schemas/index.json')) as { haVersion: string; domains: Record<string, IndexEntry> };
        index = data.domains;
        haVersion = data.haVersion;
        revision++;
      } catch {
        index = {}; // offline / not bundled: only the hand-written schemas apply
      }
    })();
    return initPromise;
  },
  /** Load the schemas of these configuration.yaml keys (unknown keys are ignored). */
  async ensure(domains: Iterable<string>): Promise<void> {
    await this.init();
    const jobs: Promise<void>[] = [];
    for (const d of new Set(domains)) {
      if (!(d in index) || d in builtinIntegrations || loaded.has(d)) continue;
      let job = inflight.get(d);
      if (!job) {
        job = fetchJson(`schemas/integrations/${d}.json`)
          .then((data) => {
            loaded.set(d, data as Loaded);
            cachedRoot = null;
            revision++;
          })
          .catch(() => void loaded.set(d, null))
          .finally(() => void inflight.delete(d));
        inflight.set(d, job);
      }
      jobs.push(job);
    }
    await Promise.all(jobs);
  },
  isLoaded: (d: string) => loaded.get(d) != null,
  /** Schema of the whole configuration.yaml with everything loaded so far. */
  root(): Schema {
    if (cachedRoot?.revision === revision) return cachedRoot.schema;
    const properties: Record<string, Schema> = { ...builtinIntegrations };
    const defs: Record<string, Schema> = { ...builtinDefs };
    for (const [domain, entry] of Object.entries(index)) {
      if (domain in builtinIntegrations) continue;
      const l = loaded.get(domain);
      if (l) {
        defs[`d__${domain}`] = l.schema;
        Object.assign(defs, l.defs);
        properties[domain] = { $ref: `#/$defs/d__${domain}`, description: entry.name };
      } else properties[domain] = { description: entry.name };
    }
    const schema: Schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties,
      additionalProperties: true,
      $defs: defs,
    };
    cachedRoot = { revision, schema };
    return schema;
  },
};
