import { AGENT_BUCKET, MISSION_TABLE } from "../constants";
import { stage4FlagMode } from "./flags";
import type { VersionReason } from "./versions";
import type { VersionSummary } from "./versionLabels";
export type { VersionSummary } from "./versionLabels";

/**
 * STAGE 4, S2 (docs/STAGE-4.md section 8): THE LIST OF A MISSION'S FILE VERSIONS, behind DIGER_STAGE4_VERSIONS. Read-only: it lists the create-only objects `versions/vNNNN.json` of the mission's own folder
 * and returns only { version, parent, reason, createdAt, digest } of each, never a cell of the file. No table, no write, no charge, no price. The customer's words for a version are in versionLabels.ts (client-safe).
 */

/** At most this many versions are read for one list (a mission's file is changed a handful of times, never hundreds). */
export const VERSION_LIST_MAX = 100;
const NAME = /^v(\d{4,})\.json$/;
const REASONS: ReadonlyArray<VersionReason> = ["delivery", "edit", "review_fix"];

/**
 * What the flag says for this request: only «on» shows the list. «test» is NOT served here: telling a test account apart needs the test-account list, and customer-side code must never import it (tests/admin-calls-log.test.ts guards that);
 * the worker's version 1 (agent/src/stage4/firstVersion.ts) does honour «test». Unset or any other word is off.
 */
export function versionsAvailable(env?: Readonly<Record<string, string | undefined>>): boolean {
  return stage4FlagMode("DIGER_STAGE4_VERSIONS", env) === "on";
}

/** The mission belongs to this user (the same predicate as the mission route: a row that is not theirs reads as «not found»). */
export async function ownsMission(client: any, missionId: string, userId: string): Promise<boolean> {
  const { data } = await client.from(MISSION_TABLE).select("id,user_id").eq("id", missionId).maybeSingle();
  return Boolean(data) && data.user_id === userId;
}

const isSummary = (v: any, n: number): v is VersionSummary =>
  Boolean(v) && v.v === 1 && Number.isInteger(v.version) && v.version === n && (v.parent === null || (Number.isInteger(v.parent) && v.parent >= 1 && v.parent < v.version)) &&
  REASONS.includes(v.reason) && typeof v.createdAt === "string" && v.createdAt !== "" && typeof v.digest === "string" && /^[0-9a-f]{64}$/.test(v.digest);

/** The versions of a mission, oldest first. An object that is not a well-formed version is left out; a listing that fails throws (the route answers an error, never a partial list). */
export async function listVersionSummaries(client: any, missionId: string): Promise<VersionSummary[]> {
  const bucket = client.storage.from(AGENT_BUCKET);
  const { data, error } = await bucket.list(`${missionId}/versions`, { limit: 1000, sortBy: { column: "name", order: "asc" } });
  if (error) throw new Error("list failed");
  const names = ((data ?? []) as Array<{ name: string; id?: string | null }>).filter((o) => o.id && NAME.test(o.name)).map((o) => o.name).sort().slice(0, VERSION_LIST_MAX);
  const out: VersionSummary[] = [];
  for (const name of names) {
    const { data: blob, error: e } = await bucket.download(`${missionId}/versions/${name}`);
    if (e || !blob) throw new Error("read failed");
    let parsed: any;
    try { parsed = JSON.parse(await blob.text()); } catch { continue; }
    const n = Number(NAME.exec(name)![1]);
    if (isSummary(parsed, n)) out.push({ version: parsed.version, parent: parsed.parent, reason: parsed.reason, createdAt: parsed.createdAt, digest: parsed.digest });
  }
  return out.sort((a, b) => a.version - b.version);
}
