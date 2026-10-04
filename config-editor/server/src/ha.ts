import type { Config } from './config.js';
import { HttpError } from './paths.js';

const RELOADABLE = /^[a-z_]+\.reload(_all|_core_config|_custom_templates|_config_entry)?$/;

export interface HaClient {
  available: boolean;
  states(): Promise<{ entity_id: string; name: string; state: string }[]>;
  services(): Promise<Record<string, Record<string, { name?: string; description?: string; fields?: Record<string, unknown> }>>>;
  components(): Promise<string[]>;
  checkConfig(): Promise<{ result: string; errors: string | null }>;
  callService(name: string): Promise<void>;
}

export function createHaClient(cfg: Config): HaClient {
  const base = cfg.haUrl?.replace(/\/$/, '') ?? null;
  const available = Boolean(base && cfg.haToken);

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    if (!available) throw new HttpError(503, 'Home Assistant API is not available');
    let res: Response;
    try {
      res = await fetch(`${base}/api${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${cfg.haToken}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new HttpError(502, 'Could not reach Home Assistant');
    }
    if (!res.ok) throw new HttpError(502, `Home Assistant returned ${res.status}`);
    return (await res.json()) as T;
  }

  return {
    available,
    async states() {
      const rows = await api<{ entity_id: string; state: string; attributes?: { friendly_name?: string } }[]>('/states');
      return rows.map((r) => ({
        entity_id: r.entity_id,
        name: r.attributes?.friendly_name ?? '',
        state: r.state,
      }));
    },
    async services() {
      const rows = await api<{ domain: string; services: Record<string, never> }[]>('/services');
      return Object.fromEntries(rows.map((r) => [r.domain, r.services]));
    },
    async components() {
      return (await api<{ components: string[] }>('/config')).components;
    },
    checkConfig() {
      return api('/config/core/check_config', { method: 'POST', body: '{}' });
    },
    async callService(name) {
      if (!RELOADABLE.test(name)) throw new HttpError(400, 'Only reload services may be called');
      const [domain, service] = name.split('.');
      await api(`/services/${domain}/${service}`, { method: 'POST', body: '{}' });
    },
  };
}
