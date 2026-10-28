import type { AgentStore, CallRow, HeartbeatRow, MissionEventInput, MissionRecord } from "./types";

/** The store of the tests: everything in memory, nothing real. */
export interface MemoryStore extends AgentStore {
  files: Map<string, string | Buffer>;
  events: Array<{ mission_id: string } & MissionEventInput>;
  calls: CallRow[];
  missions: Map<string, MissionRecord>;
  heartbeats: HeartbeatRow[];
  settings: Record<string, unknown>;
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
  const published: MemoryStore["published"] = [];
  const key = (missionId: string, relPath: string) => `${missionId}/${relPath}`;
  return {
    files, events, calls, missions, heartbeats, settings, published,
    async putFile(missionId, relPath, content) { files.set(key(missionId, relPath), content); },
    async getFile(missionId, relPath) { const v = files.get(key(missionId, relPath)); return v === undefined ? null : typeof v === "string" ? v : v.toString("utf8"); },
    async getFileBytes(missionId, relPath) { const v = files.get(key(missionId, relPath)); return v === undefined ? null : Buffer.isBuffer(v) ? v : Buffer.from(v); },
    async addEvent(missionId, event) { events.push({ mission_id: missionId, ...event }); },
    async addCall(row) { calls.push(row); },
    async listCalls(missionId) { return calls.filter((c) => c.mission_id === missionId); },
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
    async renewLeases(workerId, leaseSeconds) {
      for (const m of missions.values()) if (m.worker_id === workerId && (m.status === "planning" || m.status === "executing")) m.lease_until = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    },
    async writeHeartbeat(row) { heartbeats.push(row); },
    async readSettings() { return settings; },
    async publishResult({ missionId, userId, jobId, xlsx, csv }) {
      files.set(`${missionId}/result/result.xlsx`, xlsx);
      files.set(`${missionId}/result/result.csv`, csv);
      published.push({ missionId, userId, jobId });
      return { resultPath: `${userId}/${jobId}/result.csv`, files: [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx" }, { name: "result.csv", path: "result/result.csv", kind: "csv" }] };
    },
  };
}
