type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'html') el.innerHTML = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

const P: Record<string, string> = {
  menu: 'M3 6h18M3 12h18M3 18h18',
  save: 'M5 3h11l3 3v15H5zM8 3v5h7V3M8 21v-7h8v7',
  more: 'M12 5v.01M12 12v.01M12 19v.01',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  cut: 'M6 3l12 14M18 3L6 17M6 17a3 3 0 1 0 0 .01M18 17a3 3 0 1 0 0 .01',
  paste: 'M9 3h6v3H9zM7 5H5v16h14V5h-2',
  folder: 'M3 6h6l2 2h10v11H3z',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l5 5 9-10',
  warn: 'M12 3l10 18H2zM12 10v5M12 18v.01',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  refresh: 'M20 11a8 8 0 1 0-2 6M20 4v7h-7',
  chevron: 'M9 6l6 6-6 6',
  indent: 'M4 6h16M10 12h10M4 18h16M3 9l4 3-4 3',
  outdent: 'M4 6h16M10 12h10M4 18h16M7 9l-4 3 4 3',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  selectall: 'M4 4h16v16H4zM8 8h8v8H8z',
  home: 'M3 12l9-8 9 8M5 10v10h14V10',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14',
  edit: 'M4 20h4L19 9l-4-4L4 16z',
};

export function icon(name: string, size = 20): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', P[name] ?? '');
  svg.appendChild(path);
  return svg;
}

/** Buttons that must not steal focus from the editor (keeps the soft keyboard open). */
export function keepFocus(el: HTMLElement) {
  el.addEventListener('pointerdown', (e) => e.preventDefault());
  el.addEventListener('mousedown', (e) => e.preventDefault());
}
