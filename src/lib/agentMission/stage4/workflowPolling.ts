import type { FileWorkflowView, WorkflowItemView } from "./fileWorkflowLabels";

/**
 * AUDIT D2: the status panel read the server once, so after an approval the customer saw «اعتُمد الطلب ويجري تنفيذه» for ever and version 2 or the report appeared only after a manual reload. These pure rules decide WHEN the panel
 * asks again (only while a request is in flight, every 10 seconds, for at most an hour, never while the tab is hidden) and WHEN something finished (a request that was in flight and no longer is), which re-reads the versions and the report.
 * Client-safe, no I/O, no money.
 */
export const WORKFLOW_POLL_MS = 10_000;
export const WORKFLOW_POLL_MAX_MS = 60 * 60_000;

/** The phases that change by themselves (a person is not needed): the worker is running, the approval is being verified, or the delivery is being published. */
const IN_FLIGHT = new Set<WorkflowItemView["phase"]>(["processing", "approval_unverified", "delivery_pending", "charged_delivery_pending"]);

export const isInFlight = (item: WorkflowItemView): boolean => IN_FLIGHT.has(item.phase);

export const needsPolling = (view: FileWorkflowView | null | undefined): boolean => Boolean(view?.items.some(isInFlight));

const keyOf = (item: WorkflowItemView): string => `${item.kind}:${item.version}`;

/** The requests that were in flight in `prev` and are not in `next` (they finished, failed or ended). Empty when there is no previous reading. */
export function finishedSince(prev: FileWorkflowView | null | undefined, next: FileWorkflowView | null | undefined): string[] {
  if (!prev || !next) return [];
  const stillOpen = new Set(next.items.filter(isInFlight).map(keyOf));
  return prev.items.filter(isInFlight).map(keyOf).filter((k) => !stillOpen.has(k));
}
