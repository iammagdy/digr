import { AGENT_BUCKET_ALLOWED_MIME } from "../../src/lib/agentMission/constants";
import { guardEvent } from "../../src/lib/agentMission/eventText";
import type { AgentStore, CallRow, HeartbeatRow, MissionEventInput, MissionRecord } from "./types";

/** The store of the tests: everything in memory, nothing real. */
export interface MemoryStore extends AgentStore {
  files: Map<string, string | Buffer>;
  events: Array<{ mission_id: string } & MissionEventInput>;
  calls: CallRow[];
  missions: Map<string, MissionRecord>;
  heartbeats: HeartbeatRow[];
  settings: Record<string, unknown>;
  /** user id -> e-mail, for the tests of the test-account gate. */
  userEmails: Map<string, string>;
  published: Array<{ missionId: string; userId: string; jobId: string }>;
}

export function newMission(partial: Partial<MissionRecord> & { id: string; user_id: string }): MissionRecord {
  return {
    request_text: "", status: "queued", question_ar: null, answer_text: null, plan: null, job_id: null, quote_id: null, reserved_points: null, unit_price_points: null,
    planning_model: null, planning_llm_usd: 0, execution_model: null, execution_llm_usd: 0, planning_treg_usd: 0, execution_treg_usd: 0, delivered_units: null, charged_points: null,
    summary_ar: null, error: null, files: null, worker_id: null, lease_until: null, created_at: new Date().toISOString(), ...partial,
  };
}

export function createMemoryStore(initial: MissionRecord[] = []): MemoryStore {
  const files = new Map<string, string | Buffer>();
  const events: MemoryStore["events"] = [];
  const calls: CallRow[] = [];
  const missions = new Map<string, MissionRecord>(initial.map((m) => [m.id, m]));
  const heartbeats: HeartbeatRow[] = [];
  const settings: Record<string, unknown> = {};
  const userEmails = new Map<string, string>();
  const published: MemoryStore["published"] = [];
  const key = (missionId: string, relPath: string) => `${missionId}/${relPath}`;
  return {
    files, events, calls, missions, heartbeats, settings, userEmails, published,
    // the real bucket refuses any type outside its list (constants.ts: AGENT_BUCKET_ALLOWED_MIME): so does this one
    async putFile(missionId, relPath, content, contentType) {
      if (!(AGENT_BUCKET_ALLOWED_MIME as readonly string[]).includes(contentType)) throw new Error(`upload: mime type ${contentType} is not supported`);
      files.set(key(missionId, relPath), content);
    },
    async putNew(missionId, relPath, content, contentType) {
      if (!(AGENT_BUCKET_ALLOWED_MIME as readonly string[]).includes(contentType)) throw new Error(`upload: mime type ${contentType} is not supported`);
      // create-only, as the real bucket with upsert off: a path that exists is left as it is (the caller treats «already exists» as done)
      if (!files.has(key(missionId, relPath))) files.set(key(missionId, relPath), content);
    },
    async listFiles(missionId, folder) {
      const prefix = `${missionId}/${folder.replace(/\/+$/, "")}/`;
      return [...files.entries()].filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")).map(([k, v]) => ({ name: k.slice(`${missionId}/`.length), size: typeof v === "string" ? Buffer.byteLength(v) : v.length })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    async getFile(missionId, relPath) { const v = files.get(key(missionId, relPath)); return v === undefined ? null : typeof v === "string" ? v : v.toString("utf8"); },
    async getFileBytes(missionId, relPath) { const v = files.get(key(missionId, relPath)); return v === undefined ? null : Buffer.isBuffer(v) ? v : Buffer.from(v); },
    async addEvent(missionId, event) { const g = guardEvent(event); events.push({ mission_id: missionId, kind: g.kind, message_ar: g.message_ar, counts: g.counts }); },
    async addCall(row) { calls.push(row); },
    async listCalls(missionId) { return calls.filter((c) => c.mission_id === missionId); },
    async recentCalls(sinceMs) { return calls.map((c) => ({ ...c, created_at: (c as unknown as { created_at?: string | number }).created_at ?? Date.now() })).filter((c) => Number(typeof c.created_at === "number" ? c.created_at : Date.parse(c.created_at)) >= sinceMs); },
    async getMission(id) { return missions.get(id) ?? null; },
    async updateMission(id, patch) { const m = missions.get(id); if (m) Object.assign(m, patch); },
    async claimMission(workerId, leaseSeconds) {
      const now = Date.now();
      for (const m of missions.values()) {
        const leaseFree = !m.lease_until || new Date(m.lease_until).getTime() < now;
        const waiting = m.status === "queued" || m.status === "approved" || ((m.status === "planning" || m.status === "executing") && leaseFree);
        if (!waiting || (!leaseFree && (m.status === "planning" || m.status === "executing"))) continue;
        if ((m.status === "queued" || m.status === "approved") && !leaseFree) continue;
        const next = m.status === "queued" || m.status === "planning" ? "planning" : "executing";
        Object.assign(m, { status: next, worker_id: workerId, lease_until: new Date(now + leaseSeconds * 1000).toISOString() });
        return m;
      }
      return null;
    },
    async renewLeases(workerId, leaseSeconds, missionIds) {
      for (const m of missions.values()) if (missionIds.includes(m.id) && m.worker_id === workerId && (m.status === "planning" || m.status === "executing")) m.lease_until = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    },
    async writeHeartbeat(row) { heartbeats.push(row); },
    async readSettings() { return settings; },
    async readUserEmail(userId) { return userEmails.get(userId) ?? null; },
    async publishResult({ missionId, userId, jobId, xlsx, csv }) {
      files.set(`${missionId}/result/result.xlsx`, xlsx);
      files.set(`${missionId}/result/result.csv`, csv);
      published.push({ missionId, userId, jobId });
      return { resultPath: `${userId}/${jobId}/result.csv`, files: [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx" }, { name: "result.csv", path: "result/result.csv", kind: "csv" }] };
    },
  };
}
