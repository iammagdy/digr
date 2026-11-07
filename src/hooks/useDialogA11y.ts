"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * The keyboard and focus rules of a window that opens over the page (a dialog, a drawer, a bottom sheet):
 *  - Escape closes it (only the one on top, when two are open);
 *  - Tab and Shift+Tab stay inside it;
 *  - focus moves in when it opens, and goes back to the button that opened it when it closes.
 * The markup (role="dialog", aria-modal, aria-labelledby or aria-label, the backdrop) stays with the window; this only drives the focus.
 */

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Windows that are open now, oldest first: Escape and the focus trap belong to the last one. */
const openWindows: symbol[] = [];

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0 && el.getAttribute("aria-hidden") !== "true");
}

/**
 * Starts the rules for one open window and returns the function that ends them. Plain DOM, no React, so it can be tested without a browser:
 * `doc` is the document the window lives in.
 */
export function trapDialog(doc: Document, container: HTMLElement, options: { onClose: () => void; initialFocus?: HTMLElement | null }): () => void {
  const token = Symbol("dialog");
  openWindows.push(token);
  const opener = doc.activeElement as HTMLElement | null;
  if (!container.hasAttribute("tabindex")) container.tabIndex = -1;
  (options.initialFocus ?? focusableIn(container)[0] ?? container).focus({ preventScroll: true });

  const onKey = (event: KeyboardEvent) => {
    if (openWindows[openWindows.length - 1] !== token) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      options.onClose();
      return;
    }
    if (event.key !== "Tab") return;
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
    if (openWindows[openWindows.length - 1] !== token) return;
    const target = event.target as Node | null;
    if (target && !container.contains(target)) (focusableIn(container)[0] ?? container).focus({ preventScroll: true });
  };
  doc.addEventListener("keydown", onKey);
  doc.addEventListener("focusin", onFocusIn);
  return () => {
    doc.removeEventListener("keydown", onKey);
    doc.removeEventListener("focusin", onFocusIn);
    const at = openWindows.indexOf(token);
    if (at >= 0) openWindows.splice(at, 1);
    const stillInside = !doc.activeElement || doc.activeElement === doc.body || container.contains(doc.activeElement);
    if (opener && opener.isConnected && stillInside) opener.focus({ preventScroll: true });
  };
}

export function useDialogA11y({
  open,
  onClose,
  containerRef,
  enabled = true,
  initialFocusRef,
}: {
  open: boolean;
  onClose: () => void;
  containerRef: RefObject<HTMLElement | null>;
  /** False while the same markup is not a window (the results panel is a side column on a wide screen): nothing is trapped or closed by Escape. */
  enabled?: boolean;
  /** What takes focus first (the least harmful button of a confirmation); the first focusable element by default. */
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  // the latest values without re-running the effect (a re-run would throw focus back to the first element at every render)
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const initialRef = useRef(initialFocusRef);
  initialRef.current = initialFocusRef;

  const active = open && enabled;
  useEffect(() => {
    const container = containerRef.current;
    if (!active || !container) return;
    return trapDialog(document, container, { onClose: () => onCloseRef.current(), initialFocus: initialRef.current?.current });
  }, [active, containerRef]);
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
