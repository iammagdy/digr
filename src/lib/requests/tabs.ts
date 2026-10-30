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
