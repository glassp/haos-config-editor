import { api, type VisibilityRule } from '../api';
import { compileVisibility } from '../../../server/src/visibility';
import { h, icon } from './dom';
import { confirmDialog, toast } from './sheet';
import { registry } from '../schemas/registry';

export interface EditorPrefs {
  wrap: boolean;
  lineNumbers: boolean;
  autosave: boolean;
  fontSize: number;
}

export interface SettingsDeps {
  prefs: EditorPrefs;
  savePrefs: () => void;
  applyPrefs: () => void;
  meta: { haConnected: boolean; readOnly: boolean };
  /** Called after the explorer rules changed on the server. */
  onVisibilityChanged: () => void;
}

const PRESETS: { label: string; hint: string; rules: VisibilityRule[] }[] = [
  { label: 'Dotfiles', hint: 'Hide files and folders starting with a dot', rules: [{ mode: 'hide', pattern: '**/.*' }] },
  { label: '.storage', hint: 'Hide Home Assistant\'s internal storage', rules: [{ mode: 'hide', pattern: '/config/.storage' }] },
  { label: 'Caches', hint: 'Hide __pycache__ and deps', rules: [{ mode: 'hide', pattern: '**/__pycache__' }, { mode: 'hide', pattern: '/config/deps' }] },
  { label: 'Databases & logs', hint: 'Hide *.db and *.log files', rules: [{ mode: 'hide', pattern: '**/*.db*' }, { mode: 'hide', pattern: '**/*.log*' }] },
];

function toggleRow(label: string, hint: string, get: () => boolean, set: (v: boolean) => void) {
  const input = h('input', { type: 'checkbox', class: 'switch' }) as HTMLInputElement;
  input.checked = get();
  input.addEventListener('change', () => set(input.checked));
  return h('label', { class: 'setting-row' }, h('span', { class: 'grow' }, h('span', { class: 'setting-name' }, label), h('span', { class: 'doc-path' }, hint)), input);
}

/** Full-screen settings page. Resolves when the user leaves it. */
export async function openSettings(deps: SettingsDeps): Promise<void> {
  let rules: VisibilityRule[] = [];
  try {
    rules = (await api.settings()).visibility;
  } catch (e) {
    toast((e as Error).message, 'error');
  }
  let saved = JSON.stringify(rules);
  const dirty = () => JSON.stringify(rules) !== saved;

  const rulesEl = h('div', { class: 'rules' });
  const saveBtn = h('button', { class: 'btn primary', tip: 'Apply the explorer rules', onclick: () => void save() }, 'Save rules');
  const testInput = h('input', { class: 'field', type: 'text', placeholder: '/config/.storage/core', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': 'Path to test' }) as HTMLInputElement;
  const testResult = h('div', { class: 'doc-path test-result' });

  const updateTest = () => {
    const p = testInput.value.trim();
    if (!p) return void (testResult.textContent = '');
    const visible = compileVisibility(rules.filter((r) => r.pattern.trim()))(p.startsWith('/') ? p : `/${p}`);
    testResult.textContent = visible ? 'Visible in the explorer' : 'Hidden from the explorer';
    testResult.className = `doc-path test-result ${visible ? 'ok' : 'bad'}`;
  };
  testInput.addEventListener('input', updateTest);

  function drawRules() {
    saveBtn.toggleAttribute('disabled', !dirty());
    rulesEl.replaceChildren(
      ...(rules.length
        ? rules.map((r, i) => {
            const mode = h('select', { class: `field mode ${r.mode}`, 'aria-label': 'Show or hide', tip: 'Show or hide matching paths' },
              h('option', { value: 'hide' }, 'Hide'), h('option', { value: 'show' }, 'Show')) as HTMLSelectElement;
            mode.value = r.mode;
            mode.addEventListener('change', () => { r.mode = mode.value as VisibilityRule['mode']; drawRules(); updateTest(); });
            const pattern = h('input', { class: 'field mono', type: 'text', value: r.pattern, placeholder: '/config/.storage or **/*.db', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': 'Path pattern' }) as HTMLInputElement;
            pattern.addEventListener('input', () => { r.pattern = pattern.value; saveBtn.toggleAttribute('disabled', !dirty()); updateTest(); });
            return h('div', { class: 'rule' }, mode, pattern,
              h('button', { class: 'icon-btn sm', tip: 'Remove this rule', onclick: () => { rules.splice(i, 1); drawRules(); updateTest(); } }, icon('trash', 18)));
          })
        : [h('p', { class: 'msg' }, 'No rules: everything under "/" is visible.')]),
    );
  }

  async function save() {
    const clean = rules.filter((r) => r.pattern.trim()).map((r) => ({ mode: r.mode, pattern: r.pattern.trim() }));
    try {
      const out = await api.saveSettings({ visibility: clean });
      rules = out.visibility;
      saved = JSON.stringify(rules);
      drawRules();
      deps.onVisibilityChanged();
      toast('Explorer rules saved');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  const addPreset = (p: (typeof PRESETS)[number]) => {
    for (const r of p.rules) if (!rules.some((x) => x.mode === r.mode && x.pattern === r.pattern)) rules.push({ ...r });
    drawRules();
    updateTest();
  };

  const page = h('div', { class: 'page', role: 'dialog', 'aria-label': 'Settings' });
  const close = async () => {
    if (dirty() && !(await confirmDialog('Unsaved rules', 'Leave without saving the explorer rules?', 'Discard', true))) return;
    page.classList.remove('open');
    setTimeout(() => page.remove(), 220);
    document.removeEventListener('keydown', onKey);
    done();
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.scrim')) void close(); };
  let done: () => void = () => {};
  const finished = new Promise<void>((r) => (done = r));

  page.append(
    h('header', { class: 'page-head' },
      h('button', { class: 'icon-btn', tip: 'Back to the editor', onclick: () => void close() }, icon('back')),
      h('h1', {}, 'Settings')),
    h('div', { class: 'page-body' },
      h('section', { class: 'card' },
        h('h2', {}, 'Explorer'),
        h('p', { class: 'help' },
          'By default everything under "/" is shown. Add rules to show or hide paths. Rules apply in order and the last matching rule wins; a rule on a folder applies to everything inside it. ',
          'Patterns: ', h('code', {}, '*'), ' any characters in one name, ', h('code', {}, '**'), ' across folders, ', h('code', {}, '?'), ' one character. Without a leading ', h('code', {}, '/'), ' a pattern matches at any depth.'),
        h('p', { class: 'help' }, 'Hidden paths are only removed from the file list and search. Includes, secrets and validation still use them.'),
        rulesEl,
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn', tip: 'Add an empty rule', onclick: () => { rules.push({ mode: 'hide', pattern: '' }); drawRules(); (rulesEl.querySelector('.rule:last-child input') as HTMLInputElement | null)?.focus(); } }, icon('plus', 16), ' Add rule'),
          h('button', { class: 'btn', tip: 'Remove all rules and show everything', onclick: () => { rules = []; drawRules(); updateTest(); } }, 'Show everything')),
        h('h3', {}, 'Quick add'),
        h('div', { class: 'row wrap' }, ...PRESETS.map((p) => h('button', { class: 'chip-btn', tip: p.hint, onclick: () => addPreset(p) }, `Hide ${p.label}`))),
        h('h3', {}, 'Test a path'),
        testInput,
        testResult,
        h('div', { class: 'row end' }, saveBtn)),
      h('section', { class: 'card' },
        h('h2', {}, 'Editor'),
        h('p', { class: 'help' }, 'These are stored on this device.'),
        toggleRow('Wrap long lines', 'Break long lines instead of scrolling sideways', () => deps.prefs.wrap, (v) => { deps.prefs.wrap = v; deps.savePrefs(); deps.applyPrefs(); }),
        toggleRow('Line numbers', 'Show line numbers in the gutter', () => deps.prefs.lineNumbers, (v) => { deps.prefs.lineNumbers = v; deps.savePrefs(); deps.applyPrefs(); }),
        toggleRow('Auto-save', 'Save automatically shortly after you stop typing', () => deps.prefs.autosave, (v) => { deps.prefs.autosave = v; deps.savePrefs(); }),
        (() => {
          const out = h('span', { class: 'hint' }, `${deps.prefs.fontSize}px`);
          const step = (d: number) => () => { deps.prefs.fontSize = Math.min(28, Math.max(11, deps.prefs.fontSize + d)); out.textContent = `${deps.prefs.fontSize}px`; deps.savePrefs(); deps.applyPrefs(); };
          return h('div', { class: 'setting-row' }, h('span', { class: 'grow' }, h('span', { class: 'setting-name' }, 'Text size'), h('span', { class: 'doc-path' }, 'Editor font size')),
            h('button', { class: 'btn sm', tip: 'Smaller text', onclick: step(-1) }, 'A−'), out, h('button', { class: 'btn sm', tip: 'Larger text', onclick: step(1) }, 'A+'));
        })()),
      h('section', { class: 'card' },
        h('h2', {}, 'Status'),
        h('div', { class: 'setting-row' }, h('span', { class: 'grow' }, 'Home Assistant API'), h('span', { class: deps.meta.haConnected ? 'ok-text' : 'bad-text' }, deps.meta.haConnected ? 'Connected' : 'Not connected')),
        h('div', { class: 'setting-row' }, h('span', { class: 'grow' }, 'Integration schemas'), h('span', {}, registry.haVersion ? `${Object.keys(registry.index).length} integrations · HA ${registry.haVersion}` : 'Not loaded')),
        h('div', { class: 'setting-row' }, h('span', { class: 'grow' }, 'Editing'), h('span', {}, deps.meta.readOnly ? 'Read-only' : 'Enabled')),
        h('p', { class: 'help' }, 'Folders that can be opened, read-only mode and the size limit are add-on options (Settings → Add-ons → Config Editor → Configuration).')),
    ),
  );
  document.getElementById('app')!.append(page);
  document.addEventListener('keydown', onKey);
  drawRules();
  requestAnimationFrame(() => page.classList.add('open'));
  return finished;
}
