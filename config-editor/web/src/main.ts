import './style.css';
import { EditorState, Text } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import { forEachDiagnostic } from '@codemirror/lint';
import { selectAll, undo, redo, indentMore, indentLess, selectLine } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { api, ApiError, type Entry } from './api';
import { copyText, readText } from './clipboard';
import { addKnownPath, onContextChange, refreshContext } from './ha/context';
import { createState, forceLinting, gutters, gutterCompartment, wrapCompartment } from './editor';
import { confirmDialog, menuSheet, openSheet, promptDialog, toast, type MenuItem } from './ui/sheet';
import { h, icon, keepFocus } from './ui/dom';
import { createTree } from './ui/tree';

// ---------------------------------------------------------------- preferences
interface Prefs {
  wrap: boolean;
  lineNumbers: boolean;
  autosave: boolean;
  fontSize: number;
}
const defaults: Prefs = { wrap: true, lineNumbers: false, autosave: false, fontSize: 15 };
function loadPrefs(): Prefs {
  try {
    return { ...defaults, ...(JSON.parse(localStorage.getItem('prefs') ?? '{}') as Partial<Prefs>) };
  } catch {
    return { ...defaults };
  }
}
const prefs = loadPrefs();
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
  del: (k: string) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};
const savePrefs = () => store.set('prefs', JSON.stringify(prefs));

// ---------------------------------------------------------------------- state
interface OpenFile {
  path: string;
  state: EditorState;
  saved: Text;
  mtime: number;
}
const files = new Map<string, OpenFile>();
let activePath: string | null = null;
let meta = { haConnected: false, readOnly: false };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const editorHost = $('editor');
const view = new EditorView({ parent: editorHost, state: EditorState.create({ doc: '' }) });
view.dom.style.display = 'none';
view.dom.classList.add('cm-host');

const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const isDirty = (f: OpenFile) => !f.state.doc.eq(f.saved);
const current = () => (activePath ? files.get(activePath) ?? null : null);

// ------------------------------------------------------------------- viewport
// Keep the layout the size of the *visible* area so the toolbar sits right above the keyboard.
function syncViewport() {
  const vv = window.visualViewport;
  document.documentElement.style.setProperty('--app-h', `${vv ? vv.height : window.innerHeight}px`);
  if (vv && vv.offsetTop) window.scrollTo(0, 0);
}
window.visualViewport?.addEventListener('resize', syncViewport);
window.visualViewport?.addEventListener('scroll', syncViewport);
window.addEventListener('resize', syncViewport);
syncViewport();
document.documentElement.style.setProperty('--editor-font', `${prefs.fontSize}px`);

// ----------------------------------------------------------------------- tabs
// Phones show the current file as a title plus a Chrome-style tab switcher button.
// Wide screens additionally show up to QUICK_TABS tabs (pinned first, then most recent).
const QUICK_TABS = 5;
const pinned = new Set<string>(JSON.parse(store.get('pinned') ?? '[]') as string[]);
let mru: string[] = [];
const persistPinned = () => store.set('pinned', JSON.stringify([...pinned]));
const baseName = (p: string) => p.split('/').pop()!;

function quickTabs(): OpenFile[] {
  const all = [...files.values()];
  const rank = (f: OpenFile) => (pinned.has(f.path) ? -1 : mru.indexOf(f.path) === -1 ? 999 : mru.indexOf(f.path));
  let chosen = [...all].sort((a, b) => rank(a) - rank(b)).slice(0, QUICK_TABS);
  const act = current();
  if (act && !chosen.includes(act)) chosen = [...chosen.slice(0, QUICK_TABS - 1), act];
  return all.filter((f) => chosen.includes(f)); // keep stable (opening) order
}

function renderTabs() {
  const f = current();
  const n = files.size;

  $('title-name').textContent = f ? baseName(f.path) : '';
  $('title-path').textContent = f ? parentOf(f.path) || '/config' : '';
  $('title-dot').hidden = !f || !isDirty(f);
  $('title-pin').hidden = !f || !pinned.has(f.path);
  $('title-pin').replaceChildren(...(f && pinned.has(f.path) ? [icon('pin', 12)] : []));
  $('doc-title').hidden = !f;
  $('btn-tabs').hidden = n === 0;
  $('tabs-count').textContent = n > 99 ? ':D' : String(n);

  $('tabstrip').replaceChildren(
    ...quickTabs().map((t) =>
      h(
        'div',
        { class: `tab${t.path === activePath ? ' active' : ''}`, role: 'tab', 'aria-selected': t.path === activePath },
        h('button', { class: 'tab-main', title: t.path, onclick: () => activate(t.path) },
          isDirty(t) ? h('span', { class: 'dot' }) : null,
          pinned.has(t.path) ? icon('pin', 12) : null,
          baseName(t.path)),
        h('button', { class: 'tab-close', 'aria-label': `Close ${baseName(t.path)}`, onclick: () => void closeFile(t.path) }, icon('close', 14)),
      ),
    ),
  );

  $('btn-save').toggleAttribute('disabled', !f || !isDirty(f) || meta.readOnly);
  $('btn-save').classList.toggle('attention', !!f && isDirty(f));
  $('keybar').hidden = !f;
  $('empty').style.display = f ? 'none' : '';
  view.dom.style.display = f ? '' : 'none';
  document.title = f ? `${isDirty(f) ? '• ' : ''}${baseName(f.path)} – Config Editor` : 'Config Editor';
}

/** The popup always lists every open tab; pinned ones get their own section on top. */
function tabsSheet() {
  const body = h('div', { class: 'tabs-list' });
  const handle = openSheet('Open tabs', body, { wide: true });
  const row = (f: OpenFile) =>
    h('div', { class: `tab-row${f.path === activePath ? ' active' : ''}` },
      h('button', { class: 'tab-row-main', onclick: () => { handle.close(); activate(f.path); } },
        icon('file', 18),
        h('span', { class: 'grow' },
          h('span', { class: 'tab-row-name' }, isDirty(f) ? h('span', { class: 'dot' }) : null, baseName(f.path)),
          h('span', { class: 'doc-path' }, parentOf(f.path) || '/config')),
      ),
      h('button', { class: `icon-btn sm pin-btn${pinned.has(f.path) ? ' on' : ''}`, 'aria-label': pinned.has(f.path) ? 'Unpin' : 'Pin',
        onclick: () => { pinned.has(f.path) ? pinned.delete(f.path) : pinned.add(f.path); persistPinned(); renderTabs(); draw(); } }, icon('pin', 18)),
      h('button', { class: 'icon-btn sm', 'aria-label': 'Close tab', onclick: async () => { await closeFile(f.path); if (!files.size) handle.close(); else draw(); } }, icon('close', 18)),
    );
  const draw = () => {
    const all = [...files.values()];
    const pins = all.filter((f) => pinned.has(f.path));
    const rest = all.filter((f) => !pinned.has(f.path));
    body.replaceChildren(
      ...(pins.length ? [h('h3', {}, 'Pinned'), ...pins.map(row)] : []),
      ...(rest.length ? [h('h3', {}, pins.length ? 'Other tabs' : 'Tabs'), ...rest.map(row)] : []),
      ...(rest.length > 1 ? [h('button', { class: 'btn block', onclick: async () => { for (const f of rest) await closeFile(f.path); if (!files.size) handle.close(); else draw(); } }, 'Close all unpinned')] : []),
    );
  };
  draw();
}
$('btn-tabs').addEventListener('click', tabsSheet);
$('doc-title').addEventListener('click', tabsSheet);

function onEditorUpdate(u: ViewUpdate) {
  const f = current();
  if (!f) return;
  if (u.docChanged || u.selectionSet) f.state = u.state;
  if (u.docChanged) {
    renderTabs();
    scheduleDraft(f);
    scheduleAutosave(f);
  }
  updateProblems(u.state);
}

// --------------------------------------------------------------------- drafts
// Mobile browsers discard background tabs aggressively, so unsaved edits are kept locally.
const draftTimers = new Map<string, number>();
function scheduleDraft(f: OpenFile) {
  clearTimeout(draftTimers.get(f.path));
  draftTimers.set(
    f.path,
    window.setTimeout(() => {
      const key = `draft:${f.path}`;
      if (isDirty(f)) store.set(key, JSON.stringify({ base: f.mtime, text: f.state.doc.toString() }));
      else store.del(key);
    }, 600),
  );
}
let autosaveTimer: number | undefined;
function scheduleAutosave(f: OpenFile) {
  if (!prefs.autosave || meta.readOnly) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => void save(f.path, { quiet: true }), 1500);
}

// ---------------------------------------------------------------- file actions
function applyPrefs() {
  view.dispatch({
    effects: [
      wrapCompartment.reconfigure(prefs.wrap ? EditorView.lineWrapping : []),
      gutterCompartment.reconfigure(gutters(prefs.lineNumbers)),
    ],
  });
  document.documentElement.style.setProperty('--editor-font', `${prefs.fontSize}px`);
}

function makeState(path: string, doc: string) {
  return createState({ path, doc, wrap: prefs.wrap, lineNumbers: prefs.lineNumbers, onSave: () => void save(), onChange: onEditorUpdate });
}

function activate(path: string, line?: number) {
  const f = files.get(path);
  if (!f) return;
  const prev = current();
  if (prev && prev !== f) prev.state = view.state;
  activePath = path;
  mru = [path, ...mru.filter((p) => p !== path)];
  view.setState(f.state);
  applyPrefs();
  if (line) {
    const l = view.state.doc.line(Math.min(line, view.state.doc.lines));
    view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'center' }) });
  }
  tree.setActive(path);
  store.set('active', path);
  persistOpen();
  renderTabs();
  updateProblems(view.state);
  if (!matchMedia('(pointer: coarse)').matches) view.focus();
}

function persistOpen() {
  store.set('open', JSON.stringify([...files.keys()]));
}

async function openFile(path: string, line?: number) {
  closeDrawer();
  if (files.has(path)) return activate(path, line);
  try {
    const r = await api.read(path);
    let doc = r.content;
    let draft = false;
    const raw = store.get(`draft:${path}`);
    if (raw) {
      try {
        const d = JSON.parse(raw) as { base: number; text: string };
        if (Math.abs(d.base - r.mtime) < 2 && d.text !== r.content) {
          doc = d.text;
          draft = true;
        } else store.del(`draft:${path}`);
      } catch {
        store.del(`draft:${path}`);
      }
    }
    const state = makeState(path, doc);
    files.set(path, { path, state, saved: Text.of(r.content.split('\n')), mtime: r.mtime });
    activate(path, line);
    if (draft) toast('Restored unsaved changes');
  } catch (e) {
    toast(errMsg(e), 'error');
  }
}

async function closeFile(path: string) {
  const f = files.get(path);
  if (!f) return;
  if (isDirty(f)) {
    const choice = await confirmDialog('Unsaved changes', `Close ${path} without saving?`, 'Discard', true, [{ label: 'Save', value: 'save' }]);
    if (!choice) return;
    if (choice === 'save' && !(await save(path))) return;
  }
  store.del(`draft:${path}`);
  pinned.delete(path);
  persistPinned();
  mru = mru.filter((p) => p !== path);
  const keys = [...files.keys()];
  const idx = keys.indexOf(path);
  files.delete(path);
  if (activePath === path) {
    activePath = null;
    const next = keys[idx + 1] ?? keys[idx - 1];
    if (next) activate(next);
    else {
      store.del('active');
      persistOpen();
      renderTabs();
      updateProblems(null);
    }
  } else {
    persistOpen();
    renderTabs();
  }
}

const errMsg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

async function save(path = activePath, opts: { quiet?: boolean } = {}): Promise<boolean> {
  const f = path ? files.get(path) : null;
  if (!f || !path) return false;
  if (path === activePath) f.state = view.state;
  if (!isDirty(f)) return true;
  if (meta.readOnly) {
    toast('Editor is read-only', 'error');
    return false;
  }
  const text = f.state.doc.toString();
  const doSave = async (expected: number | null) => {
    const r = await api.write(path, text, expected);
    f.mtime = r.mtime;
    f.saved = f.state.doc;
    store.del(`draft:${path}`);
    addKnownPath(path);
    if (path === 'secrets.yaml') void refreshContext();
    renderTabs();
    if (!opts.quiet) toast('Saved');
  };
  try {
    await doSave(f.mtime);
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      const choice = await confirmDialog('File changed on disk', `${path} was modified outside the editor.`, 'Overwrite', true, [{ label: 'Reload from disk', value: 'reload' }]);
      if (choice === 'ok') return doSave(null).then(() => true, (err) => (toast(errMsg(err), 'error'), false));
      if (choice === 'reload') {
        const r = await api.read(path);
        f.mtime = r.mtime;
        f.saved = Text.of(r.content.split('\n'));
        if (path === activePath) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: r.content } });
        else f.state = makeState(path, r.content);
        f.saved = view.state.doc;
        renderTabs();
      }
      return false;
    }
    toast(errMsg(e), 'error');
    return false;
  }
}

// -------------------------------------------------------------------- problems
const chip = $('btn-problems');
function collect(state: EditorState) {
  const out: { from: number; severity: string; message: string; line: number }[] = [];
  forEachDiagnostic(state, (d, from) => out.push({ from, severity: d.severity, message: d.message, line: state.doc.lineAt(from).number }));
  return out.sort((a, b) => a.from - b.from);
}
function updateProblems(state: EditorState | null) {
  if (!state || !current()) return void (chip.hidden = true);
  const all = collect(state);
  const errors = all.filter((d) => d.severity === 'error').length;
  const warnings = all.length - errors;
  chip.hidden = false;
  chip.className = `chip ${errors ? 'bad' : warnings ? 'warn' : 'ok'}`;
  chip.replaceChildren(icon(errors || warnings ? 'warn' : 'check', 16), h('span', {}, errors || warnings ? `${errors}/${warnings}` : 'OK'));
}
chip.addEventListener('click', () => {
  const list = h('div', { class: 'menu' });
  const items = collect(view.state);
  if (!items.length) list.append(h('p', { class: 'msg' }, 'No problems found.'));
  for (const d of items) {
    list.append(
      h('button', { class: 'menu-item problem', onclick: () => { handle.close(); view.dispatch({ selection: { anchor: d.from }, effects: EditorView.scrollIntoView(d.from, { y: 'center' }) }); view.focus(); } },
        h('span', { class: `sev ${d.severity}` }),
        h('span', { class: 'grow' }, d.message),
        h('span', { class: 'hint' }, `Ln ${d.line}`),
      ),
    );
  }
  const handle = openSheet('Problems', list);
});
onContextChange(() => {
  if (current()) forceLinting(view);
});

// --------------------------------------------------------------------- keybar
function exec(fn: (v: EditorView) => unknown) {
  fn(view);
  view.focus();
}
function insert(text: string) {
  view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true, userEvent: 'input.type' });
  view.focus();
}
function selectionText(): string {
  const { state } = view;
  return state.selection.ranges.filter((r) => !r.empty).map((r) => state.sliceDoc(r.from, r.to)).join('\n');
}
async function doCopy(cut: boolean) {
  const { state } = view;
  let text = selectionText();
  let range: { from: number; to: number } | null = null;
  if (!text) {
    // Like VS Code: an empty selection copies the whole line.
    const l = state.doc.lineAt(state.selection.main.head);
    text = l.text + '\n';
    range = { from: l.from, to: Math.min(state.doc.length, l.to + 1) };
  }
  const ok = await copyText(text);
  if (!ok) return toast('Copy blocked by browser — use long-press → Copy', 'error');
  if (cut) {
    if (range) view.dispatch({ changes: range, userEvent: 'delete.cut' });
    else view.dispatch(state.replaceSelection(''), { userEvent: 'delete.cut' });
  }
  toast(cut ? 'Cut' : 'Copied');
  view.focus();
}
async function doPaste() {
  let text = await readText();
  if (text === null) {
    // No programmatic access (plain http, denied permission): ask the user to paste into a field.
    text = await promptDialog('Paste text', '', 'Insert', true);
    if (!text) return view.focus();
  }
  view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true, userEvent: 'input.paste' });
  view.focus();
}
function moveCursor(dx: number, dy: number) {
  const sel = view.state.selection.main;
  const r = dy ? view.moveVertically(sel, dy > 0) : view.moveByChar(sel, dx > 0);
  view.dispatch({ selection: r, scrollIntoView: true });
  view.focus();
}

type Key = { icon?: string; label?: string; title: string; run: () => void; cls?: string } | '|';
const keys: Key[] = [
  { icon: 'undo', title: 'Undo', run: () => exec(undo) },
  { icon: 'redo', title: 'Redo', run: () => exec(redo) },
  '|',
  { icon: 'copy', title: 'Copy', run: () => void doCopy(false) },
  { icon: 'cut', title: 'Cut', run: () => void doCopy(true) },
  { icon: 'paste', title: 'Paste', run: () => void doPaste() },
  { icon: 'selectall', title: 'Select all', run: () => exec(selectAll) },
  { label: 'Ln', title: 'Select line', run: () => exec(selectLine) },
  '|',
  { icon: 'indent', title: 'Indent', run: () => exec(indentMore) },
  { icon: 'outdent', title: 'Outdent', run: () => exec(indentLess) },
  '|',
  { icon: 'left', title: 'Left', run: () => moveCursor(-1, 0), cls: 'rep' },
  { icon: 'right', title: 'Right', run: () => moveCursor(1, 0), cls: 'rep' },
  { icon: 'up', title: 'Up', run: () => moveCursor(0, -1), cls: 'rep' },
  { icon: 'down', title: 'Down', run: () => moveCursor(0, 1), cls: 'rep' },
  '|',
  ...[':', '-', '"', "'", '[', ']', '{', '}', '!', '#', '_', '/', '%', '|', '>', '*', '&'].map((c): Key => ({ label: c, title: `Insert ${c}`, run: () => insert(c === '"' || c === "'" ? c + c : c) })),
];
const keybar = $('keybar');
for (const k of keys) {
  if (k === '|') {
    keybar.append(h('span', { class: 'sep' }));
    continue;
  }
  const b = h('button', { class: `key ${k.cls ?? ''}`, title: k.title, 'aria-label': k.title }, k.icon ? icon(k.icon, 20) : k.label);
  keepFocus(b);
  let timer: number | undefined;
  const stop = () => clearInterval(timer);
  b.addEventListener('click', k.run);
  if (k.cls === 'rep') {
    // Hold an arrow key to repeat (replaces the click handler for pointer input).
    b.addEventListener('pointerdown', () => {
      stop();
      timer = window.setTimeout(() => (timer = window.setInterval(k.run, 60)), 350);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, stop);
  }
  keybar.append(b);
}
// A closing quote/bracket button should still work when text is selected: wrap it.

// ------------------------------------------------------------------ tree + menu
const drawer = $('drawer');
const drawerScrim = $('drawer-scrim');
const openDrawer = () => {
  drawer.classList.add('open');
  drawerScrim.classList.add('open');
};
function closeDrawer() {
  drawer.classList.remove('open');
  drawerScrim.classList.remove('open');
}
drawerScrim.addEventListener('click', closeDrawer);

const tree = createTree($('tree'), { open: (p) => void openFile(p), actions: (e) => entryMenu(e) });

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

async function createEntry(dir: string, type: 'file' | 'dir') {
  const name = await promptDialog(type === 'file' ? 'New file' : 'New folder', '', 'Create');
  if (!name?.trim()) return;
  const path = join(dir, name.trim());
  try {
    await api.fs(type === 'file' ? 'create-file' : 'create-dir', path);
    addKnownPath(path);
    tree.reveal(path);
    await tree.refresh(dir);
    if (type === 'file') await openFile(path);
  } catch (e) {
    toast(errMsg(e), 'error');
  }
}

function entryMenu(e: Entry | { path: ''; type: 'dir'; name: string }) {
  const dir = e.type === 'dir' ? e.path : parentOf(e.path);
  const items: (MenuItem | null)[] = [
    { label: 'New file here', icon: 'plus', run: () => createEntry(dir, 'file') },
    { label: 'New folder here', icon: 'folder', run: () => createEntry(dir, 'dir') },
  ];
  if (e.path) {
    items.push(
      null,
      {
        label: 'Rename / move',
        icon: 'edit',
        run: async () => {
          const to = await promptDialog('Rename / move', e.path, 'Rename');
          if (!to || to === e.path) return;
          try {
            await api.fs('rename', e.path, to.trim());
            const f = files.get(e.path);
            if (f) {
              await closeFile(e.path);
              await openFile(to.trim());
            }
            await tree.refresh();
          } catch (err) {
            toast(errMsg(err), 'error');
          }
        },
      },
      {
        label: 'Duplicate',
        icon: 'copy',
        run: async () => {
          const to = await promptDialog('Duplicate as', e.path.replace(/(\.[^./]+)?$/, '_copy$1'), 'Duplicate');
          if (!to) return;
          try {
            await api.fs('copy', e.path, to.trim());
            await tree.refresh();
          } catch (err) {
            toast(errMsg(err), 'error');
          }
        },
      },
      { label: 'Copy path', icon: 'copy', run: async () => void ((await copyText(e.path)) && toast('Path copied')) },
      {
        label: 'Delete',
        icon: 'trash',
        danger: true,
        run: async () => {
          if (!(await confirmDialog('Delete', `Delete ${e.path}${e.type === 'dir' ? ' and everything in it' : ''}?`, 'Delete', true))) return;
          try {
            await api.fs('delete', e.path);
            for (const p of [...files.keys()]) if (p === e.path || p.startsWith(e.path + '/')) { files.get(p)!.saved = files.get(p)!.state.doc; await closeFile(p); }
            await tree.refresh();
          } catch (err) {
            toast(errMsg(err), 'error');
          }
        },
      },
    );
  }
  menuSheet(e.path || 'Config folder', items);
}

$('btn-files').addEventListener('click', openDrawer);
$('btn-open-files').addEventListener('click', openDrawer);
$('btn-refresh').addEventListener('click', () => void refreshAll());
$('btn-new').addEventListener('click', () => entryMenu({ path: '', type: 'dir', name: '' }));
$('btn-search').addEventListener('click', () => searchSheet());
$('btn-save').addEventListener('click', () => void save());

async function refreshAll() {
  await Promise.all([tree.refresh(), refreshContext()]);
  toast('Refreshed');
}

// ----------------------------------------------------------------------- search
function searchSheet() {
  const input = h('input', { class: 'field', type: 'search', placeholder: 'Search file names and contents', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
  const results = h('div', { class: 'menu' });
  const handle = openSheet('Search', [input, results], { wide: true });
  let timer: number | undefined;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) return results.replaceChildren();
      try {
        const { results: rs } = await api.search(q, true);
        results.replaceChildren(
          ...(rs.length ? rs.map((r) => h('button', { class: 'menu-item problem', onclick: () => { handle.close(); void openFile(r.path, r.line); } },
            icon('file', 18),
            h('span', { class: 'grow' }, h('div', { class: 'res-path' }, r.line ? `${r.path}:${r.line}` : r.path), r.text ? h('div', { class: 'res-text' }, r.text) : null),
          )) : [h('p', { class: 'msg' }, 'No matches.')]),
        );
      } catch (e) {
        toast(errMsg(e), 'error');
      }
    }, 300);
  });
  setTimeout(() => input.focus(), 50);
}

// ---------------------------------------------------------------------- history
async function historySheet() {
  const f = current();
  if (!f) return;
  const { versions } = await api.history(f.path);
  const list = h('div', { class: 'menu' });
  const handle = openSheet('Previous versions', list);
  if (!versions.length) list.append(h('p', { class: 'msg' }, 'No earlier versions yet. A copy is kept every time you save.'));
  for (const v of versions) {
    list.append(
      h('button', { class: 'menu-item', onclick: async () => {
        handle.close();
        const { content } = await api.historyVersion(f.path, v.id);
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content }, userEvent: 'input.restore' });
        toast('Version restored — review and save');
      } },
        icon('history'),
        h('span', { class: 'grow' }, new Date(Number(v.id)).toLocaleString()),
        h('span', { class: 'hint' }, `${v.size} B`),
      ),
    );
  }
}

// -------------------------------------------------------------- HA tools sheet
const RELOADS: [string, string][] = [
  ['Automations', 'automation.reload'],
  ['Scripts', 'script.reload'],
  ['Scenes', 'scene.reload'],
  ['Core config', 'homeassistant.reload_core_config'],
  ['Templates', 'template.reload'],
  ['Input helpers', 'input_boolean.reload'],
  ['All YAML', 'homeassistant.reload_all'],
];
function haSheet() {
  const out = h('div', { class: 'ha-result' });
  const body: Node[] = [];
  if (!meta.haConnected) body.push(h('p', { class: 'msg' }, 'Not connected to the Home Assistant API: entity/service completion and config checks are unavailable.'));
  const check = h('button', { class: 'btn primary block', onclick: async () => {
    out.textContent = 'Checking…';
    out.className = 'ha-result';
    try {
      const r = await api.checkConfig();
      const ok = r.result === 'valid';
      out.className = `ha-result ${ok ? 'ok' : 'bad'}`;
      out.textContent = ok ? 'Configuration valid ✔' : (r.errors ?? 'Invalid configuration');
    } catch (e) {
      out.className = 'ha-result bad';
      out.textContent = errMsg(e);
    }
  } }, 'Check configuration');
  body.push(check, out, h('h3', {}, 'Reload'));
  const grid = h('div', { class: 'grid' });
  for (const [label, svc] of RELOADS) {
    grid.append(h('button', { class: 'btn', onclick: async () => {
      try {
        await api.reload(svc);
        toast(`${label} reloaded`);
      } catch (e) {
        toast(errMsg(e), 'error');
      }
    } }, label));
  }
  body.push(grid, h('h3', {}, 'Editor'), h('button', { class: 'btn block', onclick: () => void refreshAll() }, 'Refresh entities, services & files'));
  openSheet('Home Assistant', body);
}

// -------------------------------------------------------------------- main menu
$('btn-menu').addEventListener('click', () => {
  const f = current();
  const toggle = (label: string, key: 'wrap' | 'lineNumbers' | 'autosave'): MenuItem => ({
    label,
    icon: prefs[key] ? 'check' : undefined,
    run: () => {
      prefs[key] = !prefs[key];
      savePrefs();
      applyPrefs();
    },
  });
  const font = (d: number): MenuItem => ({
    label: d > 0 ? 'Larger text' : 'Smaller text',
    hint: `${prefs.fontSize}px`,
    run: () => {
      prefs.fontSize = Math.min(28, Math.max(11, prefs.fontSize + d));
      savePrefs();
      applyPrefs();
    },
  });
  menuSheet('Menu', [
    f ? { label: 'Find & replace', icon: 'search', run: () => { openSearchPanel(view); } } : null,
    { label: 'Search all files', icon: 'search', run: () => searchSheet() },
    f ? { label: 'Previous versions', icon: 'history', run: () => void historySheet() } : null,
    f ? { label: 'Copy entire file', icon: 'copy', run: async () => void ((await copyText(view.state.doc.toString())) && toast('File copied')) } : null,
    f ? { label: 'Copy file path', icon: 'copy', run: async () => void ((await copyText(f.path)) && toast('Path copied')) } : null,
    { label: 'Home Assistant tools', icon: 'home', run: haSheet },
    null,
    toggle('Wrap long lines', 'wrap'),
    toggle('Line numbers', 'lineNumbers'),
    toggle('Auto-save', 'autosave'),
    font(1),
    font(-1),
  ]);
});

// ------------------------------------------------------------------- lifecycle
window.addEventListener('beforeunload', (e) => {
  if ([...files.values()].some(isDirty)) e.preventDefault();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && prefs.autosave) for (const f of files.values()) if (isDirty(f)) void save(f.path, { quiet: true });
});

async function boot() {
  try {
    meta = await api.meta();
  } catch (e) {
    toast(errMsg(e), 'error');
  }
  if (meta.readOnly) {
    $('btn-save').hidden = true;
    toast('Read-only mode');
  }
  $('btn-files').append(icon('menu'));
  $('btn-save').append(icon('save'));
  $('btn-menu').append(icon('more'));
  $('btn-search').append(icon('search'));
  $('btn-new').append(icon('plus'));
  $('btn-refresh').append(icon('refresh'));
  renderTabs();
  void refreshContext();
  const open = JSON.parse(store.get('open') ?? '[]') as string[];
  for (const p of open) await openFile(p).catch(() => {});
  const active = store.get('active');
  if (active && files.has(active)) activate(active);
  await tree.render();
  if (!files.size) openDrawer();
}
void boot();
