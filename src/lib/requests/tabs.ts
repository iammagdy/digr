import type { RequestKind } from "../jobs/requestStatus";

/**
 * THE TABS OF «طلباتي», the page size and the address fragment, shared by the page and the server list (the labels stay in the page, as before).
 *
 *   all       every request, plus the requests that wait for the customer (the block on top)
 *   running   queued / planning / approved / executing
 *   done      completed (fully or partly)
 *   ended     a request that never became a job: cancelled, expired (not approved within 72 hours), or failed before approval
 *   refunded  a job that did not settle: its temporary hold was released
 *
 * The address keeps the selected tab as an ASCII name after `#` (`#running`), so a reload keeps it. An unknown name is «all».
 */
export type RequestTab = "all" | "running" | "done" | "ended" | "refunded";

/** In the order the tabs are shown. */
export const REQUEST_TAB_IDS: readonly RequestTab[] = ["all", "running", "done", "ended", "refunded"];

export const REQUESTS_PAGE_SIZE = 20;
export const REQUESTS_MAX_LIMIT = 400;

export const isRequestTab = (v: unknown): v is RequestTab => typeof v === "string" && (REQUEST_TAB_IDS as readonly string[]).includes(v);

/** `#running` → "running"; anything else → "all". */
export function tabFromHash(hash: string | null | undefined): RequestTab {
  const name = String(hash ?? "").replace(/^#/, "").trim().toLowerCase();
  return isRequestTab(name) ? name : "all";
}

/** The fragment for a tab: ASCII only. */
export const hashOfTab = (tab: RequestTab): string => `#${tab}`;

/** A job's kind decides its tab; «partial» is still a completed request. */
export function tabOfKind(kind: RequestKind): "done" | "running" | "refunded" {
  return kind === "partial" ? "done" : kind;
}

/**
 * THE TWO NUMBERS OF THE LIST, FROM ONE SOURCE. The tab's number is what the tab holds (`counts[tab]`, from the server); the footer says how many of THOSE are on the page right now. On the «all» tab the requests that wait
 * for the customer (the block above the list) are part of the tab's number and are on the page, so they count as shown: «يظهر ٢٤ من ٢٢٥» next to a tab that says «الكل ٢٢٥», never «٢٠ من ٢٢١».
 */
export function requestsShownCounts(input: { tab: RequestTab; counts: Record<RequestTab, number>; listed: number; pending: number }): { shown: number; total: number } {
  const total = input.counts[input.tab] ?? 0;
  const shown = input.listed + (input.tab === "all" ? input.pending : 0);
  // the page can never show more than the tab holds (a count read a moment before the list is the only way they differ)
  return { shown, total: Math.max(total, shown) };
}
