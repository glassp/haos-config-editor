import { StreamLanguage, type LanguageSupport } from '@codemirror/language';
import { yaml } from '@codemirror/lang-yaml';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { jinja2 } from '@codemirror/legacy-modes/mode/jinja2';
import type { Extension } from '@codemirror/state';

export type Kind = 'yaml' | 'json' | 'python' | 'js' | 'markdown' | 'shell' | 'ini' | 'jinja' | 'text';

export function kindOf(path: string): Kind {
  const name = path.split('/').pop()!.toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  if (['yaml', 'yml'].includes(ext)) return 'yaml';
  if (['json', 'jsonc'].includes(ext) || name === '.ha_run.lock') return 'json';
  if (ext === 'py') return 'python';
  if (['js', 'mjs', 'cjs', 'ts'].includes(ext)) return 'js';
  if (['md', 'markdown'].includes(ext)) return 'markdown';
  if (['sh', 'bash'].includes(ext)) return 'shell';
  if (['conf', 'cfg', 'ini', 'properties', 'env'].includes(ext)) return 'ini';
  if (['j2', 'jinja', 'jinja2'].includes(ext)) return 'jinja';
  return 'text';
}

export function languageFor(kind: Kind): Extension {
  const support: Record<Kind, () => LanguageSupport | Extension> = {
    yaml: () => yaml(),
    json: () => json(),
    python: () => python(),
    js: () => javascript(),
    markdown: () => markdown(),
    shell: () => StreamLanguage.define(shell),
    ini: () => StreamLanguage.define(properties),
    jinja: () => StreamLanguage.define(jinja2),
    text: () => [],
  };
  return support[kind]();
}
