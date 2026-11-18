import { dedupeIdentityFor } from "../rowDedupe";
import { TIMED_OUT, withTimeout } from "./jobGroupShared";

export const FREEZE_BUDGET_MS = 30_000;
export const FREEZE_IO_TIMEOUT_MS = 5_000;
export const FREEZE_RPC_TIMEOUT_MS = 4_000;

export function freezeCandidates(userId: string, jobId: string): Array<{ bucket: "partials"; path: string }> {
  return [
    { bucket: "partials", path: `${userId}/${jobId}/data.json` },
    { bucket: "partials", path: `${jobId}/data.json` },
  ];
}

export type FreezeOutcome = "frozen" | "retry" | "unfreezable";

export async function freezeGroupPart(
  admin: any,
  args: {
    groupId: string;
    partIndex: number;
    job: { id: string; user_id: string; delivered_units: number };
    now?: () => number;
    budgetMs?: number;
  }
): Promise<FreezeOutcome> {
  const { job } = args;
  if (!job || job.delivered_units < 1) {
    return "unfreezable";
  }

  const candidates = freezeCandidates(job.user_id, job.id);
  const dedupe = dedupeIdentityFor("company");

  let selectedCandidate: { candidate: { bucket: "partials"; path: string }; bytes: Buffer; ids: string[] } | null = null;

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    let downloadResult: any;
    try {
      downloadResult = await withTimeout(
        admin.storage.from(candidate.bucket).download(candidate.path),
        FREEZE_IO_TIMEOUT_MS
      );
    } catch {
      return "retry";
    }

    if (downloadResult === TIMED_OUT) {
      return "retry";
    }

    if (downloadResult.error) {
      const err = downloadResult.error;
      const status = Number(err?.statusCode ?? err?.status ?? 0);
      const msg = String(err?.message ?? "");
      const isAbsent = status === 400 || status === 404 || /not.?found/i.test(msg);
      if (isAbsent) {
        continue;
      }
      return "retry";
    }

    const data = downloadResult.data;
    if (!data) {
      return "retry";
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.isBuffer(data) ? data : Buffer.from(await data.arrayBuffer());
    } catch {
      return "retry";
    }

    let parsed: any;
    try {
      parsed = JSON.parse(bytes.toString("utf-8"));
    } catch {
      console.warn("[job-groups:freeze-candidate-rejected]", { jobId: job.id, index });
      continue;
    }

    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.rows)) {
      console.warn("[job-groups:freeze-candidate-rejected]", { jobId: job.id, index });
      continue;
    }

    const rows = parsed.rows;
    if (rows.length !== job.delivered_units) {
      console.warn("[job-groups:freeze-candidate-rejected]", { jobId: job.id, index });
      continue;
    }

    let validRows = true;
    const ids: string[] = [];
    for (const row of rows) {
      const id = dedupe(row);
      if (!id || typeof id !== "string" || id.length === 0 || id.length > 300) {
        validRows = false;
        break;
      }
      ids.push(id);
    }

    if (!validRows || new Set(ids).size !== job.delivered_units) {
      console.warn("[job-groups:freeze-candidate-rejected]", { jobId: job.id, index });
      continue;
    }

    selectedCandidate = { candidate, bytes, ids };
    break;
  }

  if (!selectedCandidate) {
    return "unfreezable";
  }

  return "retry";
}
