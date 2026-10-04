/**
 * Tooltips for anything with a `data-tip` attribute.
 *  - mouse: shown on hover
 *  - touch: shown on long press (and the click that would follow is swallowed, so a long press
 *    explains a button instead of triggering it)
 * Elements that need the long press for something else (hold-to-repeat) opt out of touch
 * tooltips with `data-tip-notouch`.
 */
const HOVER_DELAY = 450;
const LONG_PRESS = 450;

export function initTooltips() {
  const tip = document.createElement('div');
  tip.id = 'tooltip';
  tip.setAttribute('role', 'tooltip');
  document.body.append(tip);

  let timer: number | undefined;
  let hideTimer: number | undefined;
  let swallowClick = false;
  let swallowTimer: number | undefined;
  let startX = 0;
  let startY = 0;

  const find = (t: EventTarget | null) => (t instanceof Element ? (t.closest('[data-tip]') as HTMLElement | null) : null);

  function show(el: HTMLElement) {
    const text = el.dataset.tip;
    if (!text) return;
    tip.textContent = text;
    tip.className = 'show';
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const hgt = tip.offsetHeight;
    let top = r.top - hgt - 10;
    if (top < 8) top = r.bottom + 10; // no room above: go below
    const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    tip.style.top = `${top}px`;
    tip.style.left = `${left}px`;
  }
  function hide() {
    clearTimeout(timer);
    clearTimeout(hideTimer);
    tip.className = '';
  }

  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = find(e.target);
    hide();
    if (el) timer = window.setTimeout(() => show(el), HOVER_DELAY);
  });
  document.addEventListener('pointerout', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = find(e.target);
    if (el && !el.contains(e.relatedTarget as Node | null)) hide();
  });

  document.addEventListener('pointerdown', (e) => {
    hide();
    if (e.pointerType === 'mouse') return;
    const el = find(e.target);
    if (!el || el.hasAttribute('data-tip-notouch')) return;
    startX = e.clientX;
    startY = e.clientY;
    timer = window.setTimeout(() => {
      show(el);
      swallowClick = true;
      navigator.vibrate?.(8);
    }, LONG_PRESS);
  });
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' || timer === undefined) return;
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > 10) clearTimeout(timer);
  });
  const release = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    clearTimeout(timer);
    if (swallowClick) {
      // the click that follows this pointerup must not run the action
      clearTimeout(swallowTimer);
      swallowTimer = window.setTimeout(() => (swallowClick = false), 500);
      hideTimer = window.setTimeout(hide, 1800);
    }
  };
  document.addEventListener('pointerup', release);
  document.addEventListener('pointercancel', release);

  document.addEventListener(
    'click',
    (e) => {
      if (swallowClick) {
        swallowClick = false;
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
  document.addEventListener('contextmenu', (e) => {
    if (find(e.target) && (e as PointerEvent).pointerType !== 'mouse') e.preventDefault();
  });
  document.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
}
