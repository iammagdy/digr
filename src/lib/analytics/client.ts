"use client";

import { isExcludedPath } from "./privacy";

/**
 * The browser side of the visit beacon. Small on purpose: one beacon when a page is viewed, one when it is left (with the seconds spent), nothing else.
 * It sends the path (no query), the session id the page made for itself, and, on the first view of a session, the page that linked here. It never
 * reads the page's content, a form, a cookie or the account, and it is silent for a visitor who asked not to be tracked.
 */
const ENDPOINT = "/api/analytics/collect";
const SESSION_KEY = "dgr_sid";
const REFERRER_SENT_KEY = "dgr_ref";

/** «Do Not Track» and «Global Privacy Control»: either one means nothing is sent. */
export function trackingAllowed(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  const nav = navigator as Navigator & { msDoNotTrack?: string; globalPrivacyControl?: boolean };
  const win = window as Window & { doNotTrack?: string };
  if (nav.doNotTrack === "1" || nav.doNotTrack === "yes" || win.doNotTrack === "1" || nav.msDoNotTrack === "1") return false;
  if (nav.globalPrivacyControl === true) return false;
  return true;
}

let memorySession: string | null = null;
function randomHex(bytes: number): string {
  const array = new Uint8Array(bytes);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") crypto.getRandomValues(array);
  else for (let i = 0; i < bytes; i += 1) array[i] = Math.floor(Math.random() * 256);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The session id lives in this tab's session storage only (gone when the tab closes); it is a random number, not a fingerprint. */
export function sessionId(): string {
  try {
    const stored = window.sessionStorage.getItem(SESSION_KEY);
    if (stored && /^[a-f0-9]{16,32}$/.test(stored)) return stored;
    const fresh = randomHex(12);
    window.sessionStorage.setItem(SESSION_KEY, fresh);
    return fresh;
  } catch {
    memorySession ||= randomHex(12);
    return memorySession;
  }
}

/** The referrer is sent once per session (the first page view); later views are the visitor moving inside the site. */
function referrerForThisView(): string {
  try {
    if (window.sessionStorage.getItem(REFERRER_SENT_KEY)) return "";
    window.sessionStorage.setItem(REFERRER_SENT_KEY, "1");
  } catch {
    return "";
  }
  try {
    const host = document.referrer ? new URL(document.referrer).host : "";
    return host === window.location.host ? "" : host;
  } catch {
    return "";
  }
}

export function send(payload: Record<string, unknown>, leaving = false): void {
  try {
    const body = JSON.stringify(payload);
    if (leaving && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
      return;
    }
    void fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true, credentials: "same-origin" }).catch(() => {});
  } catch {
    // fail-open: a beacon that cannot be sent is simply not sent
  }
}

export function trackView(path: string): { leave: () => void; resume: () => void } | null {
  if (!trackingAllowed() || !path || isExcludedPath(path)) return null;
  const s = sessionId();
  let startedAt = Date.now();
  let open = true;
  send({ k: "view", s, p: path, r: referrerForThisView() });
  return {
    leave: () => {
      if (!open) return;
      open = false;
      send({ k: "leave", s, p: path, d: Math.round((Date.now() - startedAt) / 1000) }, true);
    },
    resume: () => { if (!open) { open = true; startedAt = Date.now(); } },
  };
}

/** After a successful sign-in or sign-up: the server checks the account itself, the page only says that it happened. */
export function trackAuthEvent(kind: "login" | "signup"): void {
  // Never throws: a sign-in or sign-up must not fail or change its result because of analytics.
  try {
    if (!trackingAllowed()) return;
    send({ k: kind, s: sessionId() });
  } catch {
    // ignore
  }
}
