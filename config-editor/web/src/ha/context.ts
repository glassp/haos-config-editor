import { api, type HaContextData } from '../api';

/** Live knowledge about the Home Assistant instance, shared by completion and validation. */
export interface HaContext {
  connected: boolean;
  entities: HaContextData['entities'];
  entityIds: Set<string>;
  entityDomains: Set<string>;
  services: HaContextData['services'];
  components: string[];
  secrets: Set<string>;
  paths: Set<string>;
  customSchemas: Record<string, object>;
}

export const ctx: HaContext = {
  connected: false,
  entities: [],
  entityIds: new Set(),
  entityDomains: new Set(),
  services: {},
  components: [],
  secrets: new Set(),
  paths: new Set(),
  customSchemas: {},
};

type Listener = () => void;
const listeners = new Set<Listener>();
export const onContextChange = (fn: Listener) => void listeners.add(fn);

export async function refreshContext() {
  const [ha, secrets, index, schemas] = await Promise.allSettled([
    api.haContext(),
    api.secrets(),
    api.index(),
    api.schemas(),
  ]);
  if (ha.status === 'fulfilled') {
    ctx.connected = ha.value.connected;
    ctx.entities = ha.value.entities;
    ctx.entityIds = new Set(ha.value.entities.map((e) => e.entity_id));
    ctx.entityDomains = new Set(ha.value.entities.map((e) => e.entity_id.split('.')[0]));
    ctx.services = ha.value.services;
    ctx.components = ha.value.components;
  }
  if (secrets.status === 'fulfilled') ctx.secrets = new Set(secrets.value.keys);
  if (index.status === 'fulfilled') ctx.paths = new Set(index.value.paths);
  if (schemas.status === 'fulfilled') ctx.customSchemas = schemas.value.schemas;
  listeners.forEach((fn) => fn());
}

export function addKnownPath(p: string) {
  ctx.paths.add(p);
}
