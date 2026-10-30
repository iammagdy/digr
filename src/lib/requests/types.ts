import type { RequestTab } from "./tabs";

/** Why a request that never became a job ended (shown as its state, never the stored words). */
export type EndedKind = "cancelled" | "expired" | "failed" | "unserved";

/** A request that became a job: the page reads the job itself (status, files, points) for the listed ids. */
export interface JobIndexRow { type: "job"; id: string; createdAt: string; tab: "running" | "done" | "refunded"; title: string | null }

/** A request that is not a job: queued or being planned (running), or ended before approval. Everything the row shows is here. */
export interface MissionIndexRow {
  type: "mission";
  id: string;
  createdAt: string;
  tab: "running" | "ended";
  title: string;
  endedKind: EndedKind | null;
  /** The state sentence of the row (Arabic, customer-safe). */
  noteAr: string;
  conversationId: string | null;
}

export type IndexRow = JobIndexRow | MissionIndexRow;

/** A question or a plan that waits for the customer (the block on top of «طلباتي»). */
export interface PendingIndexRow { id: string; status: string; stateAr: string; requestText: string; createdAt: string | null; cancellable: boolean; conversationId: string | null }

export interface RequestIndex {
  /** The number of requests each tab holds for the current search (the tab's count is exactly what it lists). */
  counts: Record<RequestTab, number>;
  rows: IndexRow[];
  /** Only on the «all» tab; empty on every other tab. */
  pending: PendingIndexRow[];
  hasMore: boolean;
  nextOffset: number;
}
