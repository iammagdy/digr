import { randomBytes } from "node:crypto";
import { AGENT_EXCLUDED_ROWS_KEPT } from "../../../src/lib/agentMission/constants";
import type { RelevanceReason, RuleBasis } from "../../../src/lib/agentMission/relevance";
import { FILTER_REASONS, type FilterReason } from "../../../src/lib/agentMission/filters";
import type { AgentStore } from "../types";

/**
 * THE ONE ITEM STORE OF A MISSION: the single source of truth for every number the customer is shown or charged by (the live tracker, the completion panel, «طلباتي», the notification, the e-mail, the file's summary
 * sheet, the settlement).
 *
 * WHY IT IS BUILT THIS WAY (the live run of 2026-10-28: a tracker at 300 of 300, a charge for 192, a file of 77). The first design kept the saved items in ONE object (`rows/<stage>.json`) that every save read, extended
 * and OVERWROTE. Supabase Storage serves an overwritten object from its CDN edge nodes for up to 60 seconds with the OLD content (documented: "we advise against overwriting files ... the CDN will take some time to propagate the
 * changes to all the edge nodes leading to stale content; uploading to a new path is the recommended way"). A later save, the closing pass and the settlement each read an older version than the one just written, and wrote or
 * counted from it. An in-process lock could not help: the lost update is in the storage read, not in the process.
 *
 * So the store is an APPEND-ONLY LOG of IMMUTABLE objects: `items/seg_<seq>_<writer>.json`, each written ONCE with a create-only upload under a path nobody has ever read (a path that was never overwritten has no stale copy),
 * and read back through the LISTING (which reads the database, consistent right after a write) and then a download of exactly the names it returned. Nothing is ever read-modified-written: a commit appends one segment. The state is
 * a fold of the log in (seq, writer) order, deterministic and the same for every reader: the first appearance of an item id wins, a later `resolve` only moves a pending or unchecked item.
 *
 * Counts, by definition (one place; every screen reads these):
 *   found      = new + duplicates      (every item the source returned that had an id)
 *   new        = accepted + excluded + pending + unchecked
 *   saved      = accepted              (accepted and persisted in a segment: the commit returns only after the segment is stored)
 *   delivered  = the items in the final customer file (counted from the file itself at settlement, never from here)
 */
export type Row = Record<string, unknown>;
export type ItemState = "accepted" | "excluded" | "pending" | "unchecked";
/** Why a structurally valid item was not saved, besides the relevance reasons. */
export type StructuralReason = "unknown_parent" | "no_verified_contact";
export type ItemReason = RelevanceReason | StructuralReason | FilterReason | "target_reached";
export const STRUCTURAL_REASONS: ReadonlyArray<ItemReason> = ["unknown_parent", "no_verified_contact"];

/** Why a stage's collection stopped: recorded once, by code, and the only source of the shortfall sentence. */
export type StopReason = "target_reached" | "source_exhausted" | "no_new_items" | "budget" | "daily_cap" | "refused" | "time_limit" | "review_limit" | "failed" | "page_limit" | "no_parents" | "model_stopped"
  /** The source gave pages with items and NONE was stored: our own mapping or save failed. Never presented to the customer as an empty source: an internal failure (the hold is released whole, the admin is flagged). */
  | "internal_error";

export interface StoredItem {
  id: string;
  stage: string;
  state: ItemState;
  by?: "rule" | "model" | "legacy";
  basis?: RuleBasis;
  reason?: ItemReason;
  /** The final row. Kept for accepted, pending and unchecked items, and for the first AGENT_EXCLUDED_ROWS_KEPT excluded ones (the admin's sheet). */
  row: Row | null;
}

export type Op =
  | { t: "page"; stage: string; stream: string; call_id: string | null; cursor_in: string | null; cursor_next: string | null; has_more: boolean | null; ended: boolean; rows_in_page: number; /** Pages this record stands for (default 1: a source read by collect_pages writes one record for a whole call). */ pages?: number; /** The keys of the raw rows this record added to the stream (collect_pages: a later call returns only new rows). */ keys?: string[] }
  | { t: "item"; stage: string; id: string; state: ItemState; by?: "rule" | "model" | "legacy"; basis?: RuleBasis; reason?: ItemReason; row: Row | null }
  | { t: "resolve"; stage: string; id: string; state: "accepted" | "excluded"; by?: "rule" | "model"; basis?: RuleBasis; reason?: ItemReason }
  | { t: "dup"; stage: string; n: number }
  | { t: "stop"; stage: string; reason: StopReason };

export interface Segment { v: 1; seq: number; writer: string; at: string; ops: Op[] }

export interface StreamState { cursor: string | null; ended: boolean; pages: number; rows: number; /** Consecutive pages that gave no new item. */ barren: number; /** Keys of the raw rows the stream has returned (collect_pages). */ seen: Set<string> }

export interface StageLog {
  items: Map<string, StoredItem>;
  duplicates: number;
  pages: number;
  /** Rows of every source page read (with or without an id): what the source returned. */
  sourceRows: number;
  excludedRowsKept: number;
  streams: Map<string, StreamState>;
  stop: StopReason | null;
}
const newStageLog = (): StageLog => ({ items: new Map(), duplicates: 0, pages: 0, sourceRows: 0, excludedRowsKept: 0, streams: new Map(), stop: null });

export interface StageCounts {
  found: number;
  new: number;
  duplicates: number;
  accepted: number;
  /** Items left out because they do not match the request (what the customer reads as «استُبعد»). */
  excludedRelevance: number;
  /** Every excluded item, structural ones included. */
  excluded: number;
  pending: number;
  unchecked: number;
  /** Items looked at (everything new except the unchecked): «فُحص». */
  checked: number;
  saved: number;
  pages: number;
  acceptedByRule: number;
  acceptedByModel: number;
  acceptedByRuleBasis: Partial<Record<RuleBasis, number>>;
  excludedByReason: Partial<Record<ItemReason, number>>;
}

/** The reasons that read to the customer as «استُبعد لأنه لا يخص طلبك»: the relevance reasons and what a filter of the card rejects. */
const RELEVANCE_REASONS: ReadonlyArray<string> = ["no_text", "no_term", "mention_only", "other_person", "uncertain", "not_reviewed", "review_no", "review_failed", ...FILTER_REASONS];

function applyOp(logs: Map<string, StageLog>, op: Op): void {
  const log = logs.get(op.stage) ?? (logs.set(op.stage, newStageLog()), logs.get(op.stage)!);
  switch (op.t) {
    case "page": {
      const n = op.pages === undefined ? 1 : Math.max(0, Math.floor(op.pages) || 0);
      log.pages += n;
      log.sourceRows += Math.max(0, Math.floor(op.rows_in_page) || 0);
      const s = log.streams.get(op.stream) ?? { cursor: null, ended: false, pages: 0, rows: 0, barren: 0, seen: new Set<string>() };
      s.pages += n;
      for (const k of op.keys ?? []) s.seen.add(k);
      s.rows += Math.max(0, Math.floor(op.rows_in_page) || 0);
      s.cursor = op.cursor_next;
      s.ended = op.ended;
      log.streams.set(op.stream, s);
      return;
    }
    case "item": {
      // the first appearance of an id wins (a second writer's copy, if one ever exists, is ignored the same way by every reader)
      if (log.items.has(op.id)) return;
      let row = op.row;
      if (op.state === "excluded") { if (log.excludedRowsKept >= AGENT_EXCLUDED_ROWS_KEPT) row = null; else log.excludedRowsKept += 1; }
      log.items.set(op.id, { id: op.id, stage: op.stage, state: op.state, ...(op.by ? { by: op.by } : {}), ...(op.basis ? { basis: op.basis } : {}), ...(op.reason ? { reason: op.reason } : {}), row });
      return;
    }
    case "resolve": {
      const it = log.items.get(op.id);
      if (!it || (it.state !== "pending" && it.state !== "unchecked")) return;
      it.state = op.state;
      if (op.by) it.by = op.by; else delete it.by;
      if (op.reason) it.reason = op.reason; else delete it.reason;
      if (op.basis) it.basis = op.basis; else delete it.basis;
      if (op.state === "excluded") { if (log.excludedRowsKept >= AGENT_EXCLUDED_ROWS_KEPT) it.row = null; else log.excludedRowsKept += 1; }
      return;
    }
    case "dup": log.duplicates += Math.max(0, Math.floor(op.n) || 0); return;
    case "stop": log.stop = op.reason; return;
  }
}

/** Every barren-page counter is derived from the log (a page that added no new item), so a resumed run counts them as the first run did. The page op carries no «new items» field: the engine writes its items in the SAME segment. */
function foldSegments(segments: ReadonlyArray<Segment>): Map<string, StageLog> {
  const logs = new Map<string, StageLog>();
  for (const seg of segments) {
    const itemsInSegment = new Map<string, number>();
    for (const op of seg.ops) {
      if (op.t === "item") itemsInSegment.set(op.stage, (itemsInSegment.get(op.stage) ?? 0) + 1);
    }
    for (const op of seg.ops) {
      applyOp(logs, op);
      if (op.t === "page") {
        const s = logs.get(op.stage)!.streams.get(op.stream)!;
        s.barren = (itemsInSegment.get(op.stage) ?? 0) === 0 ? s.barren + 1 : 0;
      }
    }
  }
  return logs;
}

const segName = (seq: number, writer: string): string => `items/seg_${String(seq).padStart(9, "0")}_${writer}.json`;
const SEG_RE = /^items\/seg_(\d{9})_([a-z0-9]+)\.json$/;

async function mapLimit<T, R>(list: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) { const i = next; next += 1; out[i] = await fn(list[i]); }
  }));
  return out;
}

/** Reads EVERY segment of a mission: the listing first (consistent), then a download of exactly the names it returned (immutable objects: never stale). An unreadable segment is an error, never a silent gap. */
export async function loadSegments(store: AgentStore, missionId: string): Promise<Segment[]> {
  const listed = (await store.listFiles(missionId, "items")).filter((f) => SEG_RE.test(f.name));
  const segments = await mapLimit(listed, 6, async (f) => {
    let last: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const raw = await store.getFile(missionId, f.name);
        if (raw === null) { last = new Error("missing"); continue; }
        const parsed = JSON.parse(raw) as Segment;
        if (parsed && parsed.v === 1 && Array.isArray(parsed.ops) && Number.isFinite(parsed.seq)) return parsed;
        last = new Error("not a segment");
      } catch (e) { last = e; }
    }
    throw new Error(`item segment ${f.name} could not be read (${String((last as Error)?.message ?? last).slice(0, 80)})`);
  });
  return segments.sort((a, b) => (a.seq - b.seq) || (a.writer < b.writer ? -1 : a.writer > b.writer ? 1 : 0));
}

export interface ItemSnapshot {
  segments: number;
  /** Highest segment number seen. */
  lastSeq: number;
  stage(key: string): StageLog;
  counts(key: string): StageCounts;
  /** The first `limit` accepted rows of a stage, in log order: what the customer's file is built from. */
  acceptedRows(key: string, limit?: number): Row[];
  excludedItems(key: string): StoredItem[];
  pendingItems(key: string): StoredItem[];
  uncheckedItems(key: string): StoredItem[];
}

function viewOf(logs: Map<string, StageLog>, segments: number, lastSeq: number): ItemSnapshot {
  const stage = (key: string): StageLog => logs.get(key) ?? newStageLog();
  const by = (key: string, state: ItemState): StoredItem[] => [...stage(key).items.values()].filter((i) => i.state === state);
  return {
    segments, lastSeq, stage,
    counts(key) {
      const log = stage(key);
      const c: StageCounts = { found: 0, new: log.items.size, duplicates: log.duplicates, accepted: 0, excludedRelevance: 0, excluded: 0, pending: 0, unchecked: 0, checked: 0, saved: 0, pages: log.pages, acceptedByRule: 0, acceptedByModel: 0, acceptedByRuleBasis: {}, excludedByReason: {} };
      for (const it of log.items.values()) {
        if (it.state === "accepted") {
          c.accepted += 1;
          if (it.by === "model") c.acceptedByModel += 1;
          else { c.acceptedByRule += 1; if (it.basis) c.acceptedByRuleBasis[it.basis] = (c.acceptedByRuleBasis[it.basis] ?? 0) + 1; }
        } else if (it.state === "excluded") {
          c.excluded += 1;
          if (it.reason) { c.excludedByReason[it.reason] = (c.excludedByReason[it.reason] ?? 0) + 1; if (RELEVANCE_REASONS.includes(it.reason)) c.excludedRelevance += 1; }
        } else if (it.state === "pending") c.pending += 1;
        else c.unchecked += 1;
      }
      c.found = c.new + c.duplicates;
      c.checked = c.new - c.unchecked;
      c.saved = c.accepted;
      return c;
    },
    acceptedRows(key, limit = Number.POSITIVE_INFINITY) {
      const out: Row[] = [];
      for (const it of stage(key).items.values()) { if (out.length >= limit) break; if (it.state === "accepted" && it.row) out.push(it.row); }
      return out;
    },
    excludedItems: (key) => by(key, "excluded"),
    pendingItems: (key) => by(key, "pending"),
    uncheckedItems: (key) => by(key, "unchecked"),
  };
}

/** A fresh reading of the whole log from storage, independent of any writer's memory: what the settlement and the files are built from. */
export async function readSnapshot(store: AgentStore, missionId: string): Promise<ItemSnapshot> {
  const segments = await loadSegments(store, missionId);
  return viewOf(foldSegments(segments), segments.length, segments.reduce((m, s) => Math.max(m, s.seq), 0));
}

export const newWriterId = (): string => randomBytes(4).toString("hex");

/**
 * The writer's handle on the log. Its memory is the fold of every segment it has read or written (it applies an op to memory only AFTER the segment holding it was stored, so memory is never ahead of storage). One
 * writer per mission at a time is the normal case; a second one (a worker that took over a mission whose old worker is still finishing) writes segments under its own name, never over anything.
 */
export class ItemStore {
  private logs = new Map<string, StageLog>();
  private seq = 0;
  private segments = 0;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(private readonly store: AgentStore, readonly missionId: string, readonly writerId: string) {}

  /** Opens the log: reads every existing segment (a resumed mission continues from them). `legacy` lists stages whose rows an older version of the worker kept in `rows/<stage>.json`: imported once, only when the stage has no item yet. */
  static async open(store: AgentStore, missionId: string, options: { writerId?: string; legacyStages?: ReadonlyArray<string> } = {}): Promise<ItemStore> {
    const s = new ItemStore(store, missionId, options.writerId ?? newWriterId());
    const segments = await loadSegments(store, missionId);
    s.logs = foldSegments(segments);
    s.segments = segments.length;
    s.seq = segments.reduce((m, x) => Math.max(m, x.seq), 0);
    for (const key of options.legacyStages ?? []) {
      if ((s.logs.get(key)?.items.size ?? 0) > 0) continue;
      let rows: Row[] = [];
      try { const raw = await store.getFile(missionId, `rows/${key}.json`); rows = raw ? (JSON.parse(raw) as Row[]) : []; } catch { rows = []; }
      const ops: Op[] = rows.filter((r) => r && typeof r === "object" && String(r.id ?? "").trim()).map((row) => ({ t: "item" as const, stage: key, id: String(row.id).trim(), state: "accepted" as const, by: "legacy" as const, row }));
      if (ops.length > 0) await s.commit(ops);
    }
    return s;
  }

  /** Runs `fn` alone: the checks of a batch, the review and the commit of one stage happen one after another, so the memory a batch is checked against is the memory its commit extends. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Appends ONE segment holding `ops` (create-only, retried, idempotent by its path), then applies them to memory. Throws when the segment cannot be stored: memory is then unchanged and nothing was lost. */
  async commit(ops: Op[]): Promise<void> {
    if (ops.length === 0) return;
    const seq = this.seq + 1;
    const path = segName(seq, this.writerId);
    const body = JSON.stringify({ v: 1, seq, writer: this.writerId, at: new Date().toISOString(), ops } satisfies Segment);
    let last: unknown = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try { await this.store.putNew(this.missionId, path, body, "application/json"); last = null; break; } catch (e) { last = e; }
    }
    if (last) throw new Error(`item segment not stored: ${String((last as Error)?.message ?? last).slice(0, 120)}`);
    this.seq = seq;
    this.segments += 1;
    for (const op of ops) applyOp(this.logs, op);
    // barren pages: a page whose segment added no item of its stage
    const added = new Set(ops.filter((o) => o.t === "item").map((o) => o.stage));
    for (const op of ops) if (op.t === "page") { const st = this.logs.get(op.stage)!.streams.get(op.stream)!; st.barren = added.has(op.stage) ? 0 : st.barren + 1; }
  }

  private view(): ItemSnapshot { return viewOf(this.logs, this.segments, this.seq); }
  stage(key: string): StageLog { return this.view().stage(key); }
  has(stageKey: string, id: string): boolean { return this.logs.get(stageKey)?.items.has(id) ?? false; }
  item(stageKey: string, id: string): StoredItem | undefined { return this.logs.get(stageKey)?.items.get(id); }
  counts(key: string): StageCounts { return this.view().counts(key); }
  acceptedRows(key: string, limit?: number): Row[] { return this.view().acceptedRows(key, limit); }
  acceptedIds(key: string): string[] { return [...(this.logs.get(key)?.items.values() ?? [])].filter((i) => i.state === "accepted").map((i) => i.id); }
  excludedItems(key: string): StoredItem[] { return this.view().excludedItems(key); }
  pendingItems(key: string): StoredItem[] { return this.view().pendingItems(key); }
  uncheckedItems(key: string): StoredItem[] { return this.view().uncheckedItems(key); }
  streamState(stageKey: string, stream: string): StreamState | null { return this.logs.get(stageKey)?.streams.get(stream) ?? null; }
  stopReason(stageKey: string): StopReason | null { return this.logs.get(stageKey)?.stop ?? null; }
  segmentCount(): number { return this.segments; }
  snapshotOfMemory(): ItemSnapshot { return this.view(); }

  /** A best-effort copy of a stage's accepted rows in `rows/<stage>.json` (the admin's and the older tools' habit). Never read by this code to decide anything: it may be stale, and a failure to write it is ignored. */
  async mirror(stageKey: string): Promise<void> {
    try { await this.store.putFile(this.missionId, `rows/${stageKey}.json`, JSON.stringify(this.acceptedRows(stageKey)), "application/json"); } catch { /* a mirror is a convenience, never a requirement */ }
  }
}
