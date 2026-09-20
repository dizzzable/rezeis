/**
 * Take the operator to the exact control they searched for, once the page it
 * lives on has rendered.
 *
 * Panel search can answer with a setting rather than a page — «ID кассы
 * (terminal_id)», not «Платёжные шлюзы». Landing on the page is only half of
 * that answer: the gateway form is forty fields long, and a search that says
 * "it is somewhere on this screen" has handed the hunt back to the operator.
 *
 * HOW IT FINDS THE CONTROL
 * ------------------------
 * By its text, the same way Ctrl+F does. Nothing is tagged, no component is
 * touched, and a page written next year works without knowing this exists.
 * The cost of that generality is that it can fail — text split across two
 * elements, a collapsed section, a virtualised list — and failing SILENTLY is
 * the whole design: the operator is already on the right page, which is what
 * the search promised.
 *
 * It polls rather than reading the DOM once because the target page is lazy:
 * at the moment of navigation the route chunk, its data and its translations
 * are all still in flight.
 */
import { foldForHighlight } from '@/components/quick-search/search-text';

/** How often to look, and for how long, before giving up quietly. */
const POLL_INTERVAL_MS = 120;
const DEFAULT_TIMEOUT_MS = 3000;
/** How long the found control stays marked. */
const FLASH_DURATION_MS = 2400;

interface FlashOptionsInterface {
  readonly timeoutMs?: number;
}

/** Inline styles, not a class: no stylesheet rule, no keyframes, no gates. */
interface SavedStyleInterface {
  readonly outline: string;
  readonly outlineOffset: string;
  readonly borderRadius: string;
  readonly transition: string;
  readonly scrollMarginTop: string;
}

function fold(value: string): string {
  return (foldForHighlight(value) ?? value.toLowerCase()).replace(/\s+/g, ' ').trim();
}

/**
 * Whether the operator can actually see this.
 *
 * `checkVisibility` is the browser's own answer and covers `display: none`, an
 * unmounted tab panel and a collapsed section in one call. Where it does not
 * exist the attribute check is all there is — deliberately permissive, because
 * marking a control that turns out to be hidden costs nothing, while refusing
 * to mark a visible one is the whole feature failing.
 */
function isVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.hidden || element.closest('[hidden], [aria-hidden="true"]') !== null) return false;
  const check = (element as { checkVisibility?: (options?: unknown) => boolean }).checkVisibility;
  return typeof check === 'function' ? check.call(element) : true;
}

interface MatchesInterface {
  /** The control itself. */
  readonly content: HTMLElement | null;
  /** A tab whose NAME carries the text — the control may be behind it. */
  readonly tab: HTMLElement | null;
}

/**
 * The elements whose own text carries `needle`, split by what they are.
 *
 * Text nodes, so the match is the element that actually renders the words: a
 * `<label>` inside a `<form>` inside `<main>` all "contain" the text, and
 * marking `<main>` marks the whole page.
 *
 * Tabs are kept apart because they are usually a signpost rather than the
 * answer. «Вебхуки» names the tab AND the heading inside it; marking the tab
 * while the operator asked for what is in it stops one step short.
 */
function findMatches(needle: string): MatchesInterface {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let tab: HTMLElement | null = null;
  let node = walker.nextNode();
  while (node !== null) {
    const parent = node.parentElement;
    if (parent && fold(node.textContent ?? '').includes(needle) && isVisible(parent)) {
      const owningTab = parent.closest('[role="tab"]');
      if (owningTab instanceof HTMLElement) {
        tab ??= owningTab;
      } else {
        return { content: parent, tab };
      }
    }
    node = walker.nextNode();
  }
  return { content: null, tab };
}

function markElement(element: HTMLElement): void {
  const saved: SavedStyleInterface = {
    outline: element.style.outline,
    outlineOffset: element.style.outlineOffset,
    borderRadius: element.style.borderRadius,
    transition: element.style.transition,
    scrollMarginTop: element.style.scrollMarginTop,
  };
  const reducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // The panel's topbar is sticky; without this the control scrolls to exactly
  // where the header covers it.
  element.style.scrollMarginTop = '6rem';
  element.scrollIntoView?.({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
  element.style.outline = '2px solid var(--primary)';
  element.style.outlineOffset = '4px';
  element.style.borderRadius = element.style.borderRadius || '6px';
  if (!reducedMotion) element.style.transition = 'outline-color 200ms ease';

  window.setTimeout(() => {
    element.style.outline = saved.outline;
    element.style.outlineOffset = saved.outlineOffset;
    element.style.borderRadius = saved.borderRadius;
    element.style.transition = saved.transition;
    element.style.scrollMarginTop = saved.scrollMarginTop;
  }, FLASH_DURATION_MS);
}

/**
 * Looks for `text` on the page and marks it when it appears.
 *
 * Gives up without a trace on timeout, and abandons the search the moment the
 * operator navigates somewhere else — a highlight that lands on a page nobody
 * asked for is worse than none.
 */
export function flashTextOnPage(text: string, options: FlashOptionsInterface = {}): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const needle = fold(text);
  if (needle.length < 2) return;

  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const route = window.location.pathname;

  const look = (): void => {
    if (window.location.pathname !== route) return;
    if (document.body) {
      const { content, tab } = findMatches(needle);
      if (content) {
        markElement(content);
        return;
      }
      if (tab) {
        // The control is behind an unopened tab. Clicking a tab is inert — it
        // switches panels and nothing else — so it is the one control this may
        // press on the operator's behalf. An already-open tab whose name is
        // the match IS the answer.
        if (tab.getAttribute('aria-selected') === 'false') tab.click();
        else {
          markElement(tab);
          return;
        }
      }
    }
    if (Date.now() - startedAt >= timeoutMs) return;
    window.setTimeout(look, POLL_INTERVAL_MS);
  };

  // One tick of slack so the navigation this follows has been committed.
  window.setTimeout(look, POLL_INTERVAL_MS);
}
