export interface VisibilityRule {
  mode: 'show' | 'hide';
  pattern: string;
}

/** Glob -> RegExp. `**` crosses folders, `*` and `?` do not. Patterns without a leading "/" match at any depth. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim();
  if (!g.startsWith('/')) g = '**/' + g;
  g = g.replace(/\/+$/, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function ancestorsAndSelf(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  return parts.map((_, i) => '/' + parts.slice(0, i + 1).join('/'));
}

/**
 * Rules apply in order and the last applicable rule wins; with no applicable rule a path
 * is visible. A rule that matches a folder applies to everything inside it.
 */
export function compileVisibility(rules: VisibilityRule[]): (path: string) => boolean {
  const compiled = rules.map((r) => ({ mode: r.mode, re: globToRegExp(r.pattern) }));
  return (path) => {
    const chain = ancestorsAndSelf(path);
    let visible = true;
    for (const r of compiled) if (chain.some((p) => r.re.test(p))) visible = r.mode === 'show';
    return visible;
  };
}

export function sanitizeRules(input: unknown): VisibilityRule[] {
  if (!Array.isArray(input)) return [];
  const out: VisibilityRule[] = [];
  for (const r of input.slice(0, 200)) {
    if (!r || typeof r !== 'object') continue;
    const { mode, pattern } = r as Record<string, unknown>;
    if ((mode === 'show' || mode === 'hide') && typeof pattern === 'string' && pattern.trim() && pattern.length <= 300) {
      out.push({ mode, pattern: pattern.trim() });
    }
  }
  return out;
}
