import type { EventKind, MissionStatus } from "../../src/lib/agentMission/constants";
import type { PricedPlan } from "../../src/lib/agentMission/plan";

export interface MissionRecord {
  id: string;
  user_id: string;
  request_text: string;
  status: MissionStatus;
  /** The customer's answer to the one question the agent asked (null until answered). */
  question_ar: string | null;
  answer_text: string | null;
  plan: PricedPlan | null;
  /** What a customer may read of the plan (Arabic titles, rows, links between stages, sample rows, the price in points): no endpoint, no USD. */
  plan_public?: Record<string, unknown> | null;
  job_id: string | null;
  quote_id: string | null;
  reserved_points: number | null;
  unit_price_points: number | null;
  planning_model: string | null;
  planning_llm_usd: number;
  execution_model: string | null;
  execution_llm_usd: number;
  planning_treg_usd: number;
  execution_treg_usd: number;
  delivered_units: number | null;
  charged_points: number | null;
  summary_ar: string | null;
  error: string | null;
  files: Array<{ name: string; path: string; kind: string }> | null;
  worker_id: string | null;
  lease_until: string | null;
  created_at: string;
}

export interface MissionEventInput { kind: EventKind; message_ar: string; counts?: Record<string, number> }

export type CallPhase = "planning" | "execution";

export interface CallRow {
  id: string;
  mission_id: string;
  phase: CallPhase;
  endpoint_id: string;
  params_digest: Record<string, unknown>;
  /** ok | failed | empty | refused */
  status: "ok" | "failed" | "empty" | "refused";
  refused_reason: string | null;
  http_status: number | null;
  rows_returned: number | null;
  cost_usd: number;
  estimate_usd: number;
  provider_cost_id: number | null;
  storage_path: string | null;
  duration_ms: number | null;
}

export interface HeartbeatRow {
  worker_id: string;
  beat_at: string;
  active_missions: number;
  model: string;
  version: string;
  /** Resident memory of the worker process (MB). */
  rss_mb: number;
  /** The worker process plus the processes it started (MB), or null when it cannot be measured. */
  tree_rss_mb: number | null;
}

/** Everything the worker and the tools need from storage and the database. Two implementations: Supabase (store.ts) and memory (the tests). */
export interface AgentStore {
  putFile(missionId: string, relPath: string, content: string | Buffer, contentType: string): Promise<void>;
  /** A file of THIS mission only (the path is always under the mission's own prefix). Null when absent. */
  getFile(missionId: string, relPath: string): Promise<string | null>;
  getFileBytes(missionId: string, relPath: string): Promise<Buffer | null>;
  /** A note on the live panel / admin page. NEVER throws: a lost note must not break a mission. */
  addEvent(missionId: string, event: MissionEventInput): Promise<void>;
  addCall(row: CallRow): Promise<void>;
  listCalls(missionId: string): Promise<CallRow[]>;
  getMission(id: string): Promise<MissionRecord | null>;
  updateMission(id: string, patch: Partial<MissionRecord> & Record<string, unknown>): Promise<void>;
  /** Takes the next mission to plan (`queued`) or execute (`approved`), or a mission whose lease ran out; null when there is none. */
  claimMission(workerId: string, leaseSeconds: number): Promise<MissionRecord | null>;
  /** Extends the lease of EXACTLY these missions (the ones the worker is really running in memory) and of no other: a mission this worker no longer runs must be free to be taken over. */
  renewLeases(workerId: string, leaseSeconds: number, missionIds: string[]): Promise<void>;
  writeHeartbeat(row: HeartbeatRow): Promise<void>;
  /** The settings the owner sets from the admin page (e.g. planning_model). */
  readSettings(): Promise<Record<string, unknown>>;
  /**
   * Saves the result files of a settled mission: in the mission's own prefix of the private bucket, and where the website's results screen looks for a job's files
   * (results/<user>/<job>/result.xlsx|csv) with the artifact_versions row the website reads them through. Returns the path settle_job_atomic stores as the result file.
   */
  publishResult(input: { missionId: string; userId: string; jobId: string; xlsx: Buffer; csv: string }): Promise<{ resultPath: string; files: Array<{ name: string; path: string; kind: string }> }>;
}
