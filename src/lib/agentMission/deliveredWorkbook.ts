import { createHash } from "node:crypto";
import { AGENT_BUCKET, MISSION_TABLE } from "./constants";
import { hasAddonMarker } from "./addonMarker";
import { deliveredNothing, resultsReleasable } from "../producedFormats";

export const DELIVERED_SHAPE_MAX_BYTES = 15 * 1024 * 1024; // 15 MB

export interface CustomerFileDescriptor {
  name: string;
  path: string;
  kind?: string;
  sha256?: unknown;
}

export function isSealedWorkbook(file: CustomerFileDescriptor): boolean {
  return (
    file.kind === "xlsx" &&
    file.name === "result.xlsx" &&
    file.path === "result/result.xlsx" &&
    typeof file.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(file.sha256)
  );
}

export type DeliveredWorkbookResult =
  | {
      ok: true;
      bytes: Buffer;
      sealed: boolean;
      mission: any;
    }
  | {
      ok: false;
      reason: "not_found" | "not_released" | "hash_mismatch" | "too_large" | "storage";
    };

const isMissingObject = (error: unknown): boolean => {
  const e = error as { status?: unknown; statusCode?: unknown; message?: unknown } | null;
  return (
    String(e?.status ?? e?.statusCode ?? "") === "404" ||
    /not.?found|does not exist|no such/i.test(String(e?.message ?? ""))
  );
};

export async function readDeliveredWorkbook(
  client: any,
  options: {
    job: {
      id?: string;
      user_id?: string;
      status?: unknown;
      charged_credits?: unknown;
      chargedCredits?: unknown;
      delivered?: unknown;
      delivered_units?: unknown;
    };
  }
): Promise<DeliveredWorkbookResult> {
  const { job } = options;
  if (!job || !job.id || !job.user_id) {
    return { ok: false, reason: "not_found" };
  }

  if (
    !resultsReleasable(job) ||
    deliveredNothing({ status: job.status, delivered: job.delivered_units ?? job.delivered })
  ) {
    return { ok: false, reason: "not_released" };
  }

  const { data: mission, error: missionErr } = await client
    .from(MISSION_TABLE)
    .select("id,user_id,files,plan,request_text,delivered_units,updated_at")
    .eq("job_id", job.id)
    .eq("user_id", job.user_id)
    .maybeSingle();

  if (missionErr || !mission || mission.user_id !== job.user_id || hasAddonMarker(mission)) {
    return { ok: false, reason: "not_found" };
  }

  const files = Array.isArray(mission.files) ? (mission.files as CustomerFileDescriptor[]) : [];
  const source = files.find(
    (f) => typeof f?.path === "string" && (f.kind === "xlsx" || String(f.name ?? "").toLowerCase().endsWith(".xlsx"))
  );
  if (!source) {
    return { ok: false, reason: "not_found" };
  }

  const sealed = files.some((file) => file && Object.hasOwn(file, "sha256"));
  if (sealed && !isSealedWorkbook(source)) {
    return { ok: false, reason: "hash_mismatch" };
  }

  let bytes: Buffer;
  try {
    const { data, error } = await client.storage.from(AGENT_BUCKET).download(`${mission.id}/${source.path}`);
    if (error || !data) {
      return { ok: false, reason: isMissingObject(error) || !error ? "not_found" : "storage" };
    }
    bytes = typeof data.arrayBuffer === "function" ? Buffer.from(await data.arrayBuffer()) : Buffer.from(data as Uint8Array);
  } catch (e) {
    return { ok: false, reason: isMissingObject(e) ? "not_found" : "storage" };
  }

  if (bytes.length > DELIVERED_SHAPE_MAX_BYTES) {
    return { ok: false, reason: "too_large" };
  }

  if (sealed) {
    const calculatedHash = createHash("sha256").update(bytes).digest("hex");
    if (calculatedHash !== source.sha256) {
      return { ok: false, reason: "hash_mismatch" };
    }
  }

  return { ok: true, bytes, sealed, mission };
}
