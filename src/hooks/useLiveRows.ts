"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { LiveData, LiveWindow } from "@/lib/agentMission/stage2/livePoller";
import type { LiveRow } from "@/lib/agentMission/stage2/liveSheet";
import { ARRIVAL_MS, MAX_WINDOW_ROWS, WINDOW_ROWS, colKindOf, revealGapMs, type ColKind } from "@/lib/agentMission/stage2/liveSheetView";

/**
 * THE LIVE SHEET'S ROWS ON THE SCREEN (the Claude Design handoff «Diger live sheet», 16 Nov 2026). The route answers one window of one sheet per poll; this hook keeps every row it has
 * received, per sheet and by row index (a row never changes once saved, so a row seen once is drawn again without asking), and REVEALS new rows one at a time (420 ms apart, faster when many
 * wait), so the customer sees the sheet filling. Honest motion only: the rows already saved when the screen opened are shown at once, never animated; only rows the route reported after that,
 * at the end of a sheet, land one by one. The counter follows the rows shown (`shownDelivered`), not the poll.
 *
 * It also picks the window to ask: the sheet's NEWEST rows while the screen follows them (`follow`), or the rows around what the customer scrolled to (`viewRange`).
 */
export type LiveRowX = LiveRow & { cut?: true };
export interface LiveRowsSheet { stageKey: string; nameAr: string; headers: string[]; total: number; shown: number }
export interface LiveReveal { sheet: string; index: number; at: number; seq: number }
export interface LiveRows {
  sheets: LiveRowsSheet[];
  active: LiveRowsSheet | null;
  setActive: (key: string) => void;
  /** The active sheet's row at an index (undefined while not received). */
  rowAt: (i: number) => LiveRowX | undefined;
  /** When a row landed on this screen (ms), for its arrival look; undefined for rows that were already there. */
  arrivedAt: (id: string) => number | undefined;
  /** The active sheet's column kinds (fixed once its first rows are known, so the grid never jumps). */
  kinds: ColKind[];
  pending: number;
  shownDelivered: number;
  /** Every row the done snapshot holds is on screen. */
  doneShown: boolean;
  lastRowAt: number | null;
  sinceMs: number;
  lastReveal: LiveReveal | null;
  follow: () => void;
  viewRange: (first: number, last: number) => void;
}

const sampleOf = (m: Map<number, LiveRowX> | undefined, n = 40): LiveRowX[] => (m ? [...m.entries()].sort((a, b) => a[0] - b[0]).slice(0, n).map(([, r]) => r) : []);

export function useLiveRows(data: LiveData, onWindow: (w: Partial<LiveWindow>) => void, opts: { animate?: boolean } = {}): LiveRows {
  const animate = opts.animate !== false;
  const cache = useRef(new Map<string, Map<number, LiveRowX>>());
  const shown = useRef(new Map<string, number>());
  const primed = useRef(false);
  const arrived = useRef(new Map<string, number>());
  const kindsLocked = useRef(new Map<string, ColKind[]>());
  const lastRowAt = useRef<number | null>(null);
  const lastReveal = useRef<LiveReveal | null>(null);
  const seq = useRef(0);
  const lastAsk = useRef<string | null>(null);
  const [sinceMs] = useState(() => Date.now());
  const [ver, bump] = useReducer((x: number) => x + 1, 0);
  const [activeKey, setActiveKey] = useState<string>(() => data.window.stageKey || data.sheets[0]?.stageKey || "");

  // take in the answer (idempotent: the same answer twice changes nothing)
  useMemo(() => {
    const key = data.window.stageKey;
    if (key) {
      let m = cache.current.get(key);
      if (!m) { m = new Map(); cache.current.set(key, m); }
      const rows = data.window.rows as LiveRowX[];
      // a row at a known index with another id: the sheet was laid out again (the final file's order); what this screen held of it is dropped
      if (rows.some((r, i) => { const old = m!.get(data.window.offset + i); return old !== undefined && old.id !== r.id; })) m.clear();
      rows.forEach((r, i) => m!.set(data.window.offset + i, r));
    }
    for (const s of data.sheets) {
      const m = cache.current.get(s.stageKey);
      if (m) for (const i of [...m.keys()]) if (i >= s.total) m.delete(i);
      const before = shown.current.get(s.stageKey);
      if (!primed.current || !animate) shown.current.set(s.stageKey, s.total);
      else shown.current.set(s.stageKey, Math.min(before ?? 0, s.total));
    }
    primed.current = true;
  }, [data, animate]);

  const pendingOf = useCallback((): number => data.sheets.reduce((a, s) => a + Math.max(0, s.total - (shown.current.get(s.stageKey) ?? 0)), 0), [data]);

  // one row at a time: the active sheet first, then the others in the file's order
  useEffect(() => {
    const pend = pendingOf();
    if (pend === 0) return undefined;
    const t = setTimeout(() => {
      const order = [...data.sheets].sort((a, b) => (a.stageKey === activeKey ? -1 : b.stageKey === activeKey ? 1 : 0));
      const s = order.find((x) => (shown.current.get(x.stageKey) ?? 0) < x.total);
      if (!s) return;
      const index = shown.current.get(s.stageKey) ?? 0;
      shown.current.set(s.stageKey, index + 1);
      const now = Date.now();
      const row = cache.current.get(s.stageKey)?.get(index);
      if (row) arrived.current.set(row.id, now);
      for (const [id, at] of arrived.current) if (now - at > ARRIVAL_MS * 2) arrived.current.delete(id);
      lastRowAt.current = now;
      seq.current += 1;
      lastReveal.current = { sheet: s.stageKey, index, at: now, seq: seq.current };
      bump();
    }, revealGapMs(pend));
    return () => clearTimeout(t);
  }, [data, ver, activeKey, pendingOf]);

  const sheets: LiveRowsSheet[] = data.sheets.map((s) => ({ stageKey: s.stageKey, nameAr: s.nameAr, headers: s.headers, total: s.total, shown: Math.min(s.total, shown.current.get(s.stageKey) ?? 0) }));
  const active = sheets.find((s) => s.stageKey === activeKey) ?? sheets.find((s) => s.stageKey === data.window.stageKey) ?? sheets[0] ?? null;
  const activeMap = active ? cache.current.get(active.stageKey) : undefined;

  let kinds = active ? kindsLocked.current.get(active.stageKey) : undefined;
  if (active && (!kinds || kinds.length !== active.headers.length)) {
    const sample = sampleOf(activeMap);
    const headers = active.headers;
    kinds = headers.map((h, i) => colKindOf(h, sample.map((r) => (i < r.cells.length ? r.cells[i] : i === r.cells.length ? { k: "text" as const, v: r.id } : r.parentId ? { k: "text" as const, v: r.parentId } : { k: "empty" as const, v: "" }))));
    if (sample.length > 0) kindsLocked.current.set(active.stageKey, kinds);
  }

  const ask = useCallback((w: LiveWindow) => {
    const k = JSON.stringify(w);
    if (k === lastAsk.current) return;
    lastAsk.current = k;
    onWindow(w);
  }, [onWindow]);
  const activeStage = active?.stageKey ?? null;
  const activeShown = active?.shown ?? 0;
  const follow = useCallback(() => ask({ sheet: activeStage, tail: true, offset: 0, limit: WINDOW_ROWS }), [ask, activeStage]);
  const viewRange = useCallback((first: number, last: number) => {
    if (!activeStage) return;
    const m = cache.current.get(activeStage);
    const lo = Math.max(0, first - 10);
    const hi = Math.min(activeShown - 1, last + 10);
    let missing = false;
    for (let i = lo; i <= hi; i += 1) if (!m?.has(i)) { missing = true; break; }
    if (!missing) return;
    ask({ sheet: activeStage, tail: false, offset: Math.max(0, first - 20), limit: Math.min(MAX_WINDOW_ROWS, last - first + 60) });
  }, [ask, activeStage, activeShown]);
  const setActive = useCallback((key: string) => {
    setActiveKey(key);
    lastAsk.current = null;
  }, []);

  const pending = pendingOf();
  return {
    sheets,
    active,
    setActive,
    rowAt: (i) => activeMap?.get(i),
    arrivedAt: (id) => arrived.current.get(id),
    kinds: kinds ?? [],
    pending,
    shownDelivered: Math.max(0, data.delivered - pending),
    doneShown: data.status === "done" && pending === 0,
    lastRowAt: lastRowAt.current,
    sinceMs,
    lastReveal: lastReveal.current,
    follow,
    viewRange,
  };
}

/** A clock that ticks every `everyMs` while given (null: still). */
export function useNow(everyMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (everyMs === null) return undefined;
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
