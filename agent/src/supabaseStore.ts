import { AGENT_BUCKET, AGENT_HEARTBEAT_TABLE, AGENT_SETTINGS_TABLE, MISSION_CALLS_TABLE, MISSION_EVENTS_TABLE, MISSION_TABLE } from "../../src/lib/agentMission/constants";
import { guardEvent } from "../../src/lib/agentMission/eventText";
import { artifactVersionRowId } from "../../src/functions/shared/artifactVersions";
import type { AgentStore, CallRow, HeartbeatRow, MissionEventInput, MissionRecord } from "./types";
import type { RecordedCallFact } from "../../src/lib/agentMission/sourceRanking";
import { illFormedPaths, wellFormedDeep } from "../../src/lib/agentMission/wellFormed";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Did the storage service itself say that the requested OBJECT does not exist? The service answers a missing object with the body {statusCode: "404", error: "not_found", message: "Object not found"} (HTTP 400 on older versions,
 * 404 on newer ones); the client (`@supabase/storage-js`) turns it into a StorageApiError with `status` (HTTP) and `statusCode` (the body's). A missing BUCKET is also a 404 but says «Bucket not found»; a gateway's 404 has no such
 * message. Only the exact object message with a 400/404 status and the body's 404 counts: anything ambiguous is NOT proof that an object is absent.
 */
export function isObjectNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { status?: unknown; statusCode?: unknown; message?: unknown };
  const status = Number(e.status);
  return (status === 400 || status === 404) && String(e.statusCode ?? "") === "404" && typeof e.message === "string" && /^object not found$/i.test(e.message.trim());
}

/** The real store: the tables and the private bucket of docs/proposals/agent-worker/ through the service-role client. Only the worker (and the admin routes) hold that key. */
export function createSupabaseStore(client: any): AgentStore {
  const bucket = () => client.storage.from(AGENT_BUCKET);
  const path = (missionId: string, rel: string) => `${missionId}/${rel}`;
  const must = <T>(res: { data: T; error: any }, what: string): T => {
    if (res.error) throw new Error(`${what}: ${String(res.error.message ?? res.error.code ?? "failed").slice(0, 160)}`);
    return res.data;
  };
  // ROUND 19: every write that carries text from outside (a provider's captions, a customer's words, our own cut strings) is repaired first (a lone UTF-16 surrogate becomes U+FFFD, a NUL is dropped): the database's JSON parser refuses a body holding either
  // («Empty or invalid json», 400: TikTok 4 Nov 2026, the plan could not be saved). The worker logs WHERE (keys only, never the text) when it repaired something.
  const clean = <T>(value: T, what: string, id?: string): T => {
    const at = illFormedPaths(value);
    if (at.length > 0) console.error(`[agent] text_repaired ${what}${id ? ` ${id}` : ""} at ${at.join(",")}`);
    return wellFormedDeep(value);
  };
  return {
    async putFile(missionId, rel, content, contentType) {
      const body = typeof content === "string" ? Buffer.from(content, "utf8") : content;
      must(await bucket().upload(path(missionId, rel), body, { contentType, upsert: true }), "upload");
    },
    async putNew(missionId, rel, content, contentType) {
      const body = typeof content === "string" ? Buffer.from(content, "utf8") : content;
      // create-only (upsert off): the item store never overwrites an object, so no read of it can be stale. An object that already exists is the same write seen twice (the path carries its own nonce): done.
      const res = await bucket().upload(path(missionId, rel), body, { contentType, upsert: false, cacheControl: "31536000" });
      if (res.error) {
        const e = res.error as { statusCode?: string | number; message?: string };
        const exists = String(e.statusCode ?? "") === "409" || /already exists|duplicate/i.test(String(e.message ?? ""));
        if (!exists) throw new Error(`upload: ${String(e.message ?? "failed").slice(0, 160)}`);
      }
    },
    async putNewStrict(missionId, rel, content, contentType) {
      const body = typeof content === "string" ? Buffer.from(content, "utf8") : content;
      // the same create-only upload as putNew (upsert off), but an object that already exists is REPORTED, not taken for done
      const res = await bucket().upload(path(missionId, rel), body, { contentType, upsert: false, cacheControl: "31536000" });
      if (!res.error) return { created: true };
      const e = res.error as { statusCode?: string | number; message?: string };
      const exists = String(e.statusCode ?? "") === "409" || /already exists|duplicate/i.test(String(e.message ?? ""));
      if (exists) return { created: false };
      throw new Error(`upload: ${String(e.message ?? "failed").slice(0, 160)}`);
    },
    async listFiles(missionId, folder) {
      const dir = path(missionId, folder.replace(/\/+$/, ""));
      const out: Array<{ name: string; size: number }> = [];
      // the storage listing reads the database (not the CDN) in pages of at most 1000: consistent right after a write
      for (let offset = 0; offset < 100_000; offset += 1000) {
        const { data, error } = await bucket().list(dir, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
        if (error) throw new Error(`list: ${String(error.message ?? "failed").slice(0, 160)}`);
        const page = (data ?? []) as Array<{ name: string; id?: string | null; metadata?: { size?: number } | null }>;
        for (const o of page) if (o.id) out.push({ name: `${folder.replace(/\/+$/, "")}/${o.name}`, size: Number(o.metadata?.size ?? 0) });
        if (page.length < 1000) break;
      }
      return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    async getFileBytes(missionId, rel) {
      // null means ONE thing: the storage service said THIS object does not exist. Any other failure (permission, rate limit, 5xx, a missing bucket, a network error, an answer of an unexpected shape) is an error the caller must see:
      // the add-on runner decides «the published path is free» from this answer, and a failed read is not proof of an empty path. A thrown exception of the client is not caught here.
      const { data, error } = await bucket().download(path(missionId, rel));
      if (error) {
        if (isObjectNotFound(error)) return null;
        throw new Error(`download: ${String((error as { message?: unknown }).message ?? "failed").slice(0, 160)}`);
      }
      if (!data) throw new Error("download: no data and no error");
      return Buffer.from(await data.arrayBuffer());
    },
    async getFile(missionId, rel) {
      const bytes = await this.getFileBytes(missionId, rel);
      return bytes ? bytes.toString("utf8") : null;
    },
    async addEvent(missionId: string, event: MissionEventInput) {
      // the event text guard: nothing but Arabic, Arabic-Indic digits and no technical name ever reaches a screen; the numbers are in `counts`
      // a lost note never breaks a mission: the error is logged and the work goes on
      try {
        const g = guardEvent(event);
        must(await client.from(MISSION_EVENTS_TABLE).insert(clean({ mission_id: missionId, kind: g.kind, message_ar: g.message_ar, counts: g.counts }, "event", missionId)), "event");
      } catch (e) {
        console.error(`[agent] event_not_saved ${missionId} ${String((e as Error)?.message ?? e).slice(0, 120)}`);
      }
    },
    async addCall(row: CallRow) { must(await client.from(MISSION_CALLS_TABLE).insert(clean(row, "call", row.id)), "call"); },
    async listCalls(missionId) {
      // EVERY call of the mission, in pages (the API answers at most its row limit, 1000 by default, whatever limit is asked): a mission of thousands of pages must still find its last call number after a restart and count what it spent
      const out: CallRow[] = [];
      for (let from = 0; from < 100_000; from += 1000) {
        const data = must(await client.from(MISSION_CALLS_TABLE).select("*").eq("mission_id", missionId).order("id", { ascending: true }).range(from, from + 999), "calls");
        const page = (data ?? []) as CallRow[];
        out.push(...page);
        if (page.length < 1000) break;
      }
      return out;
    },
    async recentCalls(sinceMs) {
      const data = must(await client.from(MISSION_CALLS_TABLE).select("endpoint_id,status,refused_reason,http_status,rows_returned,cost_usd,created_at,params_digest").gte("created_at", new Date(sinceMs).toISOString()).order("created_at", { ascending: false }).limit(5000), "recent calls");
      return (data ?? []) as RecordedCallFact[];
    },
    async getMission(id) {
      const { data, error } = await client.from(MISSION_TABLE).select("*").eq("id", id).maybeSingle();
      if (error) throw new Error(`mission: ${String(error.message ?? "failed").slice(0, 160)}`);
      return (data ?? null) as MissionRecord | null;
    },
    async updateMission(id, patch) { must(await client.from(MISSION_TABLE).update(clean({ ...patch, updated_at: new Date().toISOString() }, "mission update", id)).eq("id", id), "mission update"); },
    async claimMission(workerId, leaseSeconds) {
      const { data, error } = await client.rpc("agent_claim_mission", { p_worker_id: workerId, p_lease_seconds: leaseSeconds });
      if (error) throw new Error(`claim: ${String(error.message ?? "failed").slice(0, 160)}`);
      const row = Array.isArray(data) ? data[0] : data;
      return row && row.id ? (row as MissionRecord) : null;
    },
    async renewLeases(workerId, leaseSeconds, missionIds) {
      // only the missions this worker really runs: a mission it no longer runs keeps its old lease, which ends, and another worker takes it over
      if (missionIds.length === 0) return [];
      const until = new Date(Date.now() + leaseSeconds * 1000).toISOString();
      const res = await client.from(MISSION_TABLE).update({ lease_until: until }).eq("worker_id", workerId).in("id", missionIds).in("status", ["planning", "executing"]).select("id");
      must(res, "renew");
      // the ids really renewed: a running mission missing here may belong to another worker now (ownership.ts)
      return Array.isArray(res.data) ? (res.data as Array<{ id: unknown }>).map((r) => String(r.id)) : undefined;
    },
    async writeHeartbeat(row: HeartbeatRow) { must(await client.from(AGENT_HEARTBEAT_TABLE).upsert(wellFormedDeep(row), { onConflict: "worker_id" }), "heartbeat"); },
    async publishResult({ missionId, userId, jobId, xlsx, csv }) {
      const csvBuf = Buffer.from(csv, "utf8");
      must(await bucket().upload(path(missionId, "result/result.xlsx"), xlsx, { contentType: XLSX_TYPE, upsert: true }), "result xlsx");
      must(await bucket().upload(path(missionId, "result/result.csv"), csvBuf, { contentType: "text/csv", upsert: true }), "result csv");
      const results = client.storage.from("results");
      const xlsxPath = `${userId}/${jobId}/result.xlsx`;
      const csvPath = `${userId}/${jobId}/result.csv`;
      must(await results.upload(xlsxPath, xlsx, { contentType: XLSX_TYPE, upsert: true }), "results xlsx");
      must(await results.upload(csvPath, csvBuf, { contentType: "text/csv", upsert: true }), "results csv");
      // the row the website's results screen reads a job's files through (the existing worker writes the same shape before it settles)
      must(await client.from("artifact_versions").upsert({ id: artifactVersionRowId(jobId, 1), job_id: jobId, user_id: userId, version_number: 1, file_id_xlsx: xlsxPath, file_id_pdf: null, file_id_csv: csvPath, created_at: new Date().toISOString() }), "artifact version");
      return { resultPath: csvPath, files: [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx" }, { name: "result.csv", path: "result/result.csv", kind: "csv" }] };
    },
    async readSettings() {
      const { data, error } = await client.from(AGENT_SETTINGS_TABLE).select("key,value");
      if (error || !Array.isArray(data)) return {};
      return Object.fromEntries(data.map((r: any) => [String(r.key), r.value]));
    },
    async readUserEmail(userId: string) {
      const { data, error } = await client.from("profiles").select("email").eq("id", userId).maybeSingle();
      return error || !data || typeof (data as { email?: unknown }).email !== "string" ? null : String((data as { email: string }).email);
    },
  };
}
