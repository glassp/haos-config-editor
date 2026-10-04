import { h, icon } from './dom';

const root = () => document.getElementById('sheet-root')!;

export interface SheetHandle {
  close: () => void;
  body: HTMLElement;
}

/** Bottom sheet on phones, centred dialog on wide screens. */
export function openSheet(title: string, content: Node | Node[], opts: { onClose?: () => void; wide?: boolean } = {}): SheetHandle {
  const body = h('div', { class: 'sheet-body' }, ...(Array.isArray(content) ? content : [content]));
  const close = () => {
    scrim.remove();
    document.removeEventListener('keydown', onKey);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  const scrim = h(
    'div',
    { class: 'scrim', onclick: (e: Event) => e.target === scrim && close() },
    h(
      'div',
      { class: `sheet${opts.wide ? ' wide' : ''}`, role: 'dialog', 'aria-label': title },
      h('div', { class: 'sheet-grab' }),
      h(
        'div',
        { class: 'sheet-head' },
        h('h2', {}, title),
        h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('close')),
      ),
      body,
    ),
  );
  document.addEventListener('keydown', onKey);
  root().append(scrim);
  return { close, body };
}

export interface MenuItem {
  label: string;
  icon?: string;
  hint?: string;
  danger?: boolean;
  run: () => void | Promise<void>;
}

export function menuSheet(title: string, items: (MenuItem | null)[]) {
  const list = h('div', { class: 'menu' });
  const handle = openSheet(title, list);
  for (const it of items) {
    if (!it) {
      list.append(h('hr'));
      continue;
    }
    list.append(
      h(
        'button',
        {
          class: `menu-item${it.danger ? ' danger' : ''}`,
          onclick: () => {
            handle.close();
            void it.run();
          },
        },
        it.icon ? icon(it.icon) : h('span', { class: 'icon-pad' }),
        h('span', { class: 'grow' }, it.label),
        it.hint ? h('span', { class: 'hint' }, it.hint) : null,
      ),
    );
  }
  return handle;
}

export function promptDialog(title: string, value = '', okLabel = 'OK', multiline = false): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const input = multiline
      ? h('textarea', { class: 'field mono', rows: 8, autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' })
      : h('input', { class: 'field', type: 'text', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
    input.value = value;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      handle.close();
      resolve(v);
    };
    const handle = openSheet(
      title,
      [
        input,
        h(
          'div',
          { class: 'row end' },
          h('button', { class: 'btn', onclick: () => finish(null) }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: () => finish(input.value) }, okLabel),
        ),
      ],
      { onClose: () => finish(null) },
    );
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter' && !multiline) finish((input as HTMLInputElement).value);
    });
    setTimeout(() => {
      input.focus();
      if (!multiline) (input as HTMLInputElement).setSelectionRange(0, value.lastIndexOf('.') > 0 ? value.lastIndexOf('.') : value.length);
    }, 50);
  });
}

export function confirmDialog(title: string, message: string, okLabel = 'OK', danger = false, extra?: { label: string; value: string }[]): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      handle.close();
      resolve(v);
    };
    const handle = openSheet(
      title,
      [
        h('p', { class: 'msg' }, message),
        h(
          'div',
          { class: 'row end wrap' },
          h('button', { class: 'btn', onclick: () => finish(null) }, 'Cancel'),
          ...(extra ?? []).map((x) => h('button', { class: 'btn', onclick: () => finish(x.value) }, x.label)),
          h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => finish('ok') }, okLabel),
        ),
      ],
      { onClose: () => finish(null) },
    );
  });
}

let toastTimer: number | undefined;
export function toast(message: string, kind: 'info' | 'error' = 'info') {
  const el = document.getElementById('toast')!;
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.className = 'toast'), kind === 'error' ? 5000 : 2200);
}
