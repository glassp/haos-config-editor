import { api, type Entry } from '../api';
import { h, icon } from './dom';

export interface TreeHandlers {
  open: (path: string) => void;
  actions: (entry: Entry | { path: ''; type: 'dir'; name: string }) => void;
}

/** Lazy file tree. Directories load on first expand. */
export function createTree(container: HTMLElement, handlers: TreeHandlers) {
  const expanded = new Set<string>(JSON.parse(localStorage.getItem('tree:expanded') ?? '[]') as string[]);
  const cache = new Map<string, Entry[]>();
  let active = '';

  const persist = () => {
    try {
      localStorage.setItem('tree:expanded', JSON.stringify([...expanded]));
    } catch {
      /* private mode */
    }
  };

  async function load(path: string, force = false): Promise<Entry[]> {
    if (!force && cache.has(path)) return cache.get(path)!;
    const { entries } = await api.tree(path);
    cache.set(path, entries);
    return entries;
  }

  async function renderDir(path: string, depth: number, into: HTMLElement) {
    let entries: Entry[];
    try {
      entries = await load(path);
    } catch (e) {
      into.append(h('div', { class: 'tree-error' }, (e as Error).message));
      return;
    }
    for (const e of entries) {
      const row = h(
        'div',
        { class: `tree-row${e.path === active ? ' active' : ''}`, style: `padding-left:${8 + depth * 14}px`, 'data-path': e.path },
        h('button', { class: 'tree-main', onclick: () => void onTap(e) },
          e.type === 'dir' ? icon(expanded.has(e.path) ? 'down' : 'chevron', 16) : h('span', { class: 'icon-pad sm' }),
          icon(e.type === 'dir' ? 'folder' : 'file', 18),
          h('span', { class: 'tree-name' }, e.name),
        ),
        h('button', { class: 'icon-btn sm', 'aria-label': `Actions for ${e.name}`, onclick: () => handlers.actions(e) }, icon('more', 18)),
      );
      into.append(row);
      if (e.type === 'dir' && expanded.has(e.path)) {
        const child = h('div', { class: 'tree-children' });
        into.append(child);
        await renderDir(e.path, depth + 1, child);
      }
    }
  }

  async function onTap(e: Entry) {
    if (e.type === 'file') return handlers.open(e.path);
    if (expanded.has(e.path)) expanded.delete(e.path);
    else expanded.add(e.path);
    persist();
    await render();
  }

  async function render() {
    const top = container.scrollTop;
    const frag = h('div');
    await renderDir('', 0, frag);
    container.replaceChildren(frag);
    container.scrollTop = top;
  }

  return {
    render,
    async refresh(dir?: string) {
      if (dir === undefined) cache.clear();
      else cache.delete(dir);
      await render();
    },
    invalidate: (dir: string) => cache.delete(dir),
    setActive(path: string) {
      active = path;
      container.querySelectorAll('.tree-row').forEach((r) => r.classList.toggle('active', r.getAttribute('data-path') === path));
    },
    reveal(path: string) {
      const parts = path.split('/').slice(0, -1);
      let acc = '';
      for (const p of parts) {
        acc = acc ? `${acc}/${p}` : p;
        expanded.add(acc);
      }
      persist();
    },
  };
}
