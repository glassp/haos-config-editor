import fs from 'node:fs/promises';
import path from 'node:path';
import { compileVisibility, sanitizeRules, type VisibilityRule } from './visibility.js';

export interface Settings {
  /** Which paths the explorer lists. Default: everything. */
  visibility: VisibilityRule[];
}

export function createSettings(dataDir: string) {
  const file = path.join(dataDir, 'settings.json');
  let current: Settings = { visibility: [] };
  let isVisible = compileVisibility([]);

  const apply = (s: Settings) => {
    current = s;
    isVisible = compileVisibility(s.visibility);
  };

  return {
    async load() {
      try {
        const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<Settings>;
        apply({ visibility: sanitizeRules(raw.visibility) });
      } catch {
        apply({ visibility: [] });
      }
    },
    get: () => current,
    async save(input: unknown) {
      const next: Settings = { visibility: sanitizeRules((input as Partial<Settings> | null)?.visibility) };
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(file, JSON.stringify(next, null, 2));
      apply(next);
      return next;
    },
    isVisible: (p: string) => isVisible(p),
  };
}

export type SettingsStore = ReturnType<typeof createSettings>;
