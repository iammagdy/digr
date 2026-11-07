"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * The keyboard and focus rules of a window that opens over the page (a dialog, a drawer, a bottom sheet):
 *  - Escape closes it (only the one on top, when two are open);
 *  - Tab and Shift+Tab stay inside it;
 *  - focus moves in when it opens, and goes back to the button that opened it when it closes.
 * A window the page opened by itself (a panel that appears when a plan arrives) must not take the customer's focus away from what they are typing:
 * it opens with `trapFocus: false`, which keeps only Escape.
 * The markup (role="dialog", aria-modal, aria-labelledby or aria-label, the backdrop) stays with the window; this only drives the focus.
 */

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Windows that are open now, oldest first. Escape belongs to the last one opened; Tab and the focus pull-back belong to the last one that traps focus.
 * "Last opened" is also the one drawn on top in this app (each window's z-index grows with the order they can be opened in); it is not read from the page.
 */
const openWindows: Array<{ token: symbol; trap: boolean }> = [];

/** How many windows are open right now (for tests: it must be 0 once everything is closed or unmounted). */
export function openDialogCount(): number {
  return openWindows.length;
}

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0 && el.getAttribute("aria-hidden") !== "true");
}

/**
 * Starts the rules for one open window and returns the function that ends them (it removes every listener and the window's place in the stack).
 * Plain DOM, no React, so it can be tested without a browser: `doc` is the document the window lives in.
 */
export function trapDialog(
  doc: Document,
  container: HTMLElement,
  options: { onClose: () => void; initialFocus?: HTMLElement | null; trapFocus?: boolean },
): (end?: { restoreFocus?: boolean }) => void {
  const trap = options.trapFocus !== false;
  const entry = { token: Symbol("dialog"), trap };
  openWindows.push(entry);
  const opener = trap ? (doc.activeElement as HTMLElement | null) : null;
  if (trap) {
    if (!container.hasAttribute("tabindex")) container.tabIndex = -1;
    (options.initialFocus ?? focusableIn(container)[0] ?? container).focus({ preventScroll: true });
  }

  const ownsEscape = () => openWindows[openWindows.length - 1] === entry;
  const ownsFocus = () => trap && [...openWindows].reverse().find((w) => w.trap) === entry;

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      if (!ownsEscape()) return;
      event.stopPropagation();
      options.onClose();
      return;
    }
    if (event.key !== "Tab" || !ownsFocus()) return;
    const items = focusableIn(container);
    if (items.length === 0) { event.preventDefault(); container.focus(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const current = doc.activeElement;
    if (!current || !container.contains(current)) { event.preventDefault(); first.focus(); }
    else if (event.shiftKey && (current === first || current === container)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && current === last) { event.preventDefault(); first.focus(); }
  };
  // a click or a script that puts focus behind the window brings it back
  const onFocusIn = (event: FocusEvent) => {
    if (!ownsFocus()) return;
    const target = event.target as Node | null;
    if (target && !container.contains(target)) (focusableIn(container)[0] ?? container).focus({ preventScroll: true });
  };
  doc.addEventListener("keydown", onKey);
  if (trap) doc.addEventListener("focusin", onFocusIn);
  let ended = false;
  return (end) => {
    if (ended) return;
    ended = true;
    doc.removeEventListener("keydown", onKey);
    doc.removeEventListener("focusin", onFocusIn);
    const at = openWindows.indexOf(entry);
    if (at >= 0) openWindows.splice(at, 1);
    if (!trap || end?.restoreFocus === false) return;
    const stillInside = !doc.activeElement || doc.activeElement === doc.body || container.contains(doc.activeElement);
    if (opener && opener.isConnected && stillInside) opener.focus({ preventScroll: true });
  };
}

export function useDialogA11y({
  open,
  onClose,
  containerRef,
  enabled = true,
  trapFocus = true,
  initialFocusRef,
}: {
  open: boolean;
  onClose: () => void;
  containerRef: RefObject<HTMLElement | null>;
  /** False while the same markup is not a window (the results panel is a side column on a wide screen): nothing is trapped or closed by Escape. */
  enabled?: boolean;
  /** False for a window the page opened by itself: Escape still closes it, but focus is neither moved into it nor held in it. */
  trapFocus?: boolean;
  /** What takes focus first (the least harmful button of a confirmation); the first focusable element by default. */
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  // the latest values without re-running the effect (a re-run would throw focus back to the first element at every render)
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const initialRef = useRef(initialFocusRef);
  initialRef.current = initialFocusRef;
  const stateRef = useRef({ open, enabled });
  stateRef.current = { open, enabled };

  const active = open && enabled;
  useEffect(() => {
    const container = containerRef.current;
    if (!active || !container) return;
    const end = trapDialog(document, container, { onClose: () => onCloseRef.current(), initialFocus: initialRef.current?.current, trapFocus });
    return () => {
      // The window is still open but no longer a window (the screen grew wide and it became a side column): focus stays where it is.
      // Closed, or removed from the page: focus goes back to the button that opened it.
      const becameColumn = stateRef.current.open && !stateRef.current.enabled;
      end({ restoreFocus: !becameColumn });
    };
  }, [active, trapFocus, containerRef]);
}

/** True while the viewport matches the query (false on the server and on the first paint). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}

/** The width below which the results panel and the mission plan are bottom sheets (Tailwind's `lg`). */
export const BELOW_LG_QUERY = "(max-width: 1023px)";
