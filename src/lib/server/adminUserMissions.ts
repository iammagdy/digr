import { MISSION_TABLE } from "../agentMission/constants";
import { ADDON_MARKER_COLUMN, withoutAddonRows } from "../agentMission/addonMarker";
import { requestedRowsOf } from "../agentMission/customerView";

/**
 * THE MISSIONS OF ONE CUSTOMER, as the admin's users screens read them (DT-20261118-06 phase 1B). Every read here is of the `missions` table (a customer request is inserted there only;
 * the old `jobs` table holds only the money record of an approved mission) and drops the add-on rows (addonMarker.ts: a review or an edit of a delivered file is not a mission of its own).
 * Read only: nothing here writes, and no money table is read.
 */

/** The profile's «المهام» tab and the e-mail composer show the newest 20. */
export const USER_MISSIONS_LIMIT = 20;
/** The columns both readers need (the composer: files; the tab: delivered, asked, charged), plus the add-on marker. */
export const USER_MISSION_COLUMNS = `id,status,request_text,files,created_at,delivered_units,charged_points,plan_public,${ADDON_MARKER_COLUMN}`;
/** A profile's request count reads at most this many rows (newest first). */
export const USER_MISSION_COUNT_CAP = 1000;
/** The list page counts the requests of one page of people in one read of at most this many rows. */
export const PAGE_MISSION_COUNT_CAP = 5000;

export interface UserMissionRow {
  id: string;
  status?: string | null;
  request_text?: string | null;
  files?: unknown;
  created_at?: string | null;
  delivered_units?: number | null;
  charged_points?: number | null;
  plan_public?: unknown;
}

/** The newest missions of one customer (at most 20, add-on rows removed). `failed` is true when the table could not be read (the rows are then empty). */
export async function readUserMissions(client: any, userId: string): Promise<{ rows: UserMissionRow[]; failed: boolean }> {
  const { data, error } = await client.from(MISSION_TABLE).select(USER_MISSION_COLUMNS).eq("user_id", userId).order("created_at", { ascending: false }).limit(USER_MISSIONS_LIMIT);
  return { rows: withoutAddonRows(Array.isArray(data) ? (data as UserMissionRow[]) : []), failed: Boolean(error) };
}

export interface AdminUserMission { id: string; created_at: string | null; status: string; request: string; delivered: number | null; asked: number; charged_points: number | null }

const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** One row of the «المهام» tab: the first 60 characters of the request, delivered of «المطلوب» (the customer card's own definition), the points charged. */
export function adminUserMission(row: UserMissionRow): AdminUserMission {
  return {
    id: String(row.id),
    created_at: row.created_at ?? null,
    status: String(row.status ?? ""),
    request: String(row.request_text ?? "").slice(0, 60),
    delivered: numOrNull(row.delivered_units),
    asked: requestedRowsOf(row.plan_public),
    charged_points: numOrNull(row.charged_points),
  };
}

/** How many requests one customer has, and when the newest was made (add-on rows not counted). */
export async function countUserMissions(client: any, userId: string): Promise<{ count: number; lastAt: string | null }> {
  const { data } = await client.from(MISSION_TABLE).select(`id,created_at,${ADDON_MARKER_COLUMN}`).eq("user_id", userId).order("created_at", { ascending: false }).limit(USER_MISSION_COUNT_CAP);
  const rows = withoutAddonRows(Array.isArray(data) ? (data as Array<{ id: string; created_at?: string | null }>) : []);
  return { count: rows.length, lastAt: rows[0]?.created_at ?? null };
}

/** The request count of each person on one page of the list: pages of 1,000 rows (the API's cap per request), at most 5 pages; never one read per person. */
export async function countMissionsByUser(client: any, userIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (userIds.length === 0) return out;
  for (let page = 0; page < 5; page += 1) {
    const from = page * 1000;
    const { data, error } = await client.from(MISSION_TABLE).select(`id,user_id,${ADDON_MARKER_COLUMN}`).in("user_id", userIds).order("id", { ascending: true }).range(from, from + 999);
    if (error) break;
    const rows = Array.isArray(data) ? (data as Array<{ user_id: string }>) : [];
    for (const r of withoutAddonRows(rows)) out.set(r.user_id, (out.get(r.user_id) ?? 0) + 1);
    if (rows.length < 1000) break;
  }
  return out;
}
