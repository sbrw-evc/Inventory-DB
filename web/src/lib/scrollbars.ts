import { OverlayScrollbars, type PartialOptions } from 'overlayscrollbars';
import 'overlayscrollbars/overlayscrollbars.css';

// Replaces native scrollbars with OverlayScrollbars on scroll containers, so they look the same
// in Chrome, Firefox and Safari (the Umbrella approach). Containers are found by their computed
// overflow; the element itself is the viewport, so React-owned children are never moved.
// Virtualised and drag-heavy surfaces (the grid, kanban, calendar) keep the CSS-styled native
// scrollbars from app.css, which look the same.

const OPTIONS: PartialOptions = {
  scrollbars: { theme: 'os-theme-app', autoHide: 'never', clickScroll: 'instant' },
};

const SKIP_TREE = '[data-native-scroll], .os-scrollbar, .grid-scroll, .kanban-scroll, .kanban-cards, .calendar-grid, .gallery-scroll, .popover, .m-shell';
const SKIP = `textarea, select, input, iframe, ${SKIP_TREE}`;

function scrolls(el: HTMLElement) {
  const s = getComputedStyle(el);
  return /auto|scroll/.test(s.overflowX) || /auto|scroll/.test(s.overflowY);
}

function attach(el: Element) {
  if (!(el instanceof HTMLElement) || el === document.body || el === document.documentElement) return;
  if (el.matches(SKIP) || OverlayScrollbars(el) || !scrolls(el)) return;
  OverlayScrollbars({ target: el, elements: { viewport: el } }, OPTIONS);
}

function scan(root: Element) {
  attach(root);
  for (const el of root.querySelectorAll('.os-target, .sidebar, .app-main, .modal, .modal-body, .nb-panel-body, .page')) if (!el.closest(SKIP_TREE)) attach(el);
}

export function installScrollbars() {
  if (typeof window === 'undefined' || !('MutationObserver' in window)) return;
  const pending = new Set<Element>();
  const removed = new Set<Element>();
  let frame = 0;
  const flush = () => {
    frame = 0;
    for (const el of removed) {
      if (el.isConnected) continue;
      for (const t of [el, ...el.querySelectorAll('[data-overlayscrollbars]')]) OverlayScrollbars(t as HTMLElement)?.destroy();
    }
    removed.clear();
    for (const el of pending) if (el.isConnected) scan(el);
    pending.clear();
  };
  const queue = (el: Element) => {
    if (el.closest(SKIP_TREE)) return;
    pending.add(el);
    frame ||= requestAnimationFrame(flush);
  };
  new MutationObserver((records) => {
    for (const r of records) {
      r.addedNodes.forEach((n) => n instanceof Element && queue(n));
      r.removedNodes.forEach((n) => {
        if (n instanceof Element) {
          removed.add(n);
          frame ||= requestAnimationFrame(flush);
        }
      });
    }
  }).observe(document.body, { childList: true, subtree: true });
  queue(document.body);
}
