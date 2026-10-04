export interface Entry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  mtime: number;
}

export interface HaContextData {
  connected: boolean;
  entities: { entity_id: string; name: string; state: string }[];
  services: Record<string, Record<string, { name?: string; description?: string; fields?: Record<string, FieldDef> }>>;
  components: string[];
}

export interface FieldDef {
  name?: string;
  description?: string;
  fields?: Record<string, FieldDef>;
  selector?: unknown;
}

export interface VisibilityRule {
  mode: 'show' | 'hide';
  pattern: string;
}

export interface Settings {
  visibility: VisibilityRule[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// All URLs are relative so the app works under the Home Assistant ingress path prefix.
async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-HA-Editor': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  return data as T;
}

const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

export const api = {
  meta: () => call<{ haConnected: boolean; readOnly: boolean; maxFileSize: number }>('GET', 'api/meta'),
  tree: (path: string) => call<{ entries: Entry[] }>('GET', `api/tree?${q({ path })}`),
  read: (path: string) => call<{ path: string; content: string; mtime: number }>('GET', `api/file?${q({ path })}`),
  write: (path: string, content: string, expectedMtime: number | null) =>
    call<{ path: string; mtime: number }>('PUT', 'api/file', { path, content, expectedMtime }),
  fs: (op: 'create-file' | 'create-dir' | 'rename' | 'copy' | 'delete', path: string, to?: string) =>
    call<{ path?: string }>('POST', 'api/fs', { op, path, to }),
  search: (query: string, content: boolean) =>
    call<{ results: { path: string; line?: number; text?: string }[] }>(
      'GET',
      `api/search?${q({ q: query, content: content ? '1' : '0' })}`,
    ),
  index: () => call<{ paths: string[] }>('GET', 'api/index'),
  history: (path: string) => call<{ versions: { id: string; size: number }[] }>('GET', `api/history?${q({ path })}`),
  historyVersion: (path: string, id: string) =>
    call<{ content: string }>('GET', `api/history/version?${q({ path, id })}`),
  settings: () => call<Settings>('GET', 'api/settings'),
  saveSettings: (s: Settings) => call<Settings>('PUT', 'api/settings', s),
  secrets: () => call<{ keys: string[] }>('GET', 'api/secrets'),
  schemas: () => call<{ schemas: Record<string, object> }>('GET', 'api/schemas'),
  haContext: () => call<HaContextData>('GET', 'api/ha/context'),
  checkConfig: () => call<{ result: string; errors: string | null }>('POST', 'api/ha/check-config', {}),
  reload: (service: string) => call<unknown>('POST', 'api/ha/reload', { service }),
};
