import { AGENT_STUCK_PLANNING_AFTER_MS } from "../agentMission/constants";
import { ADDON_MARKER_COLUMN } from "../agentMission/addonMarker";
import { requestedRowsOf } from "../agentMission/customerView";

/**
 * THE OVERVIEW'S MISSION NUMBERS (DT-20261118-06 phase 1A). Pure: the route reads the rows, this file counts them (tested on fakes).
 * Every number reads the `missions` table: a customer request is inserted there only (customerActions.ts createCustomerMission). The old `jobs` table holds only the
 * money record of an approved mission, so it never sees a request that failed, waited or was refused before approval.
 */

export const OVERVIEW_RANGES = [7, 30, 90] as const;
export type OverviewRange = (typeof OVERVIEW_RANGES)[number];
export const parseOverviewRange = (raw: string | null | undefined): OverviewRange => OVERVIEW_RANGES.find((r) => String(r) === raw) ?? 30;

/** The worker holds a mission in these two (readQueue in customerActions.ts counts the same two as «running»). */
export const RUNNING_STATUSES = ["planning", "executing"] as const;
/** Ended after a worker took it: the base of the success rate. Cancelled and unserved requests are not failures of delivery. */
export const ENDED_STATUSES = ["completed", "failed"] as const;
/** A running status whose lease ran out this long ago has no live worker: «متوقفة» (the same limit openMissions.ts uses for a stuck plan). */
export const MISSION_STALLED_AFTER_MS = AGENT_STUCK_PLANNING_AFTER_MS;
export const FAILED_RECENT_MS = 24 * 60 * 60 * 1000;
/** At most this many rows per read; more sets `truncated` (the card then says the numbers are a lower bound). */
export const OVERVIEW_ROW_CAP = 5000;
export const OVERVIEW_COLUMNS = `id,status,delivered_units,reserved_points,charged_points,plan_public,lease_until,created_at,updated_at,${ADDON_MARKER_COLUMN}`;
const DAY_MS = 86_400_000;

export interface OverviewMissionRow {
  id: string;
  status: string;
  delivered_units?: number | null;
  reserved_points?: number | null;
  charged_points?: number | null;
  plan_public?: unknown;
  lease_until?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface MissionOverview {
  range: OverviewRange;
  missions: {
    /** missions created in the range */
    total: number;
    /** completed + failed */
    ended: number;
    /** completed with at least one delivered item */
    succeeded: number;
    failed: number;
    /** succeeded / ended, in percent; null when nothing ended */
    successPct: number | null;
    /** the same rate in the period before (for the change arrow); null when nothing ended then */
    successPctPrev: number | null;
    /** Σ delivered items and Σ «المطلوب» (requestedRowsOf) over the ended missions that had a plan */
    delivered: number;
    requested: number;
    /** ended missions whose hold was released in full or in part (reserve above the charge: the rest is released, DIGER-TRUTH §5) and the points released */
    released: number;
    releasedPoints: number;
  };
  live: { running: number; stalled: number; stalledMinMinutes: number | null; failed24h: number };
  truncated: boolean;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const isEnded = (r: OverviewMissionRow) => (ENDED_STATUSES as readonly string[]).includes(r.status);
const isSuccess = (r: OverviewMissionRow) => r.status === "completed" && num(r.delivered_units) >= 1;
const rate = (rows: OverviewMissionRow[]) => {
  const ended = rows.filter(isEnded);
  return ended.length ? Math.round((rows.filter(isSuccess).length / ended.length) * 1000) / 10 : null;
};

/** `rows`: missions created in the last 2 x range days (add-on rows already removed); `liveRows`: every mission in a running status, whatever its age. */
export function summarizeMissions(input: { rows: OverviewMissionRow[]; liveRows: OverviewMissionRow[]; range: OverviewRange; now: number; truncated: boolean }): MissionOverview {
  const { range, now } = input;
  const start = now - range * DAY_MS;
  const current = input.rows.filter((r) => at(r.created_at) >= start);
  const previous = input.rows.filter((r) => at(r.created_at) < start && at(r.created_at) >= start - range * DAY_MS);
  const ended = current.filter(isEnded);

  let delivered = 0, requested = 0, released = 0, releasedPoints = 0;
  for (const r of ended) {
    const asked = requestedRowsOf(r.plan_public);
    if (asked > 0) { requested += asked; delivered += num(r.delivered_units); }
    const hold = num(r.reserved_points);
    const charged = num(r.charged_points);
    if (hold > 0 && charged < hold) { released += 1; releasedPoints += hold - charged; }
  }

  let running = 0, stalled = 0;
  let stalledMin: number | null = null;
  for (const r of input.liveRows) {
    if (!(RUNNING_STATUSES as readonly string[]).includes(r.status)) continue;
    const lease = at(r.lease_until);
    if (!Number.isFinite(lease)) continue;
    if (lease > now) { running += 1; continue; }
    if (lease < now - MISSION_STALLED_AFTER_MS) {
      stalled += 1;
      const idle = Math.floor((now - lease) / 60_000);
      stalledMin = stalledMin === null ? idle : Math.min(stalledMin, idle);
    }
  }

  return {
    range,
    missions: {
      total: current.length,
      ended: ended.length,
      succeeded: current.filter(isSuccess).length,
      failed: current.filter((r) => r.status === "failed").length,
      successPct: rate(current),
      successPctPrev: rate(previous),
      delivered,
      requested,
      released,
      releasedPoints,
    },
    live: { running, stalled, stalledMinMinutes: stalledMin, failed24h: current.filter((r) => r.status === "failed" && at(r.updated_at) >= now - FAILED_RECENT_MS).length },
    truncated: input.truncated,
  };
}
