import { createHash } from "node:crypto";
import { dedupeIdentityFor } from "../rowDedupe";
import { TIMED_OUT, withTimeout, frozenPathFor } from "./jobGroupShared";

async function downloadWithin(
  call: PromiseLike<{ data: any; error: any }>,
  ms: number
): Promise<{ data: Buffer | null; error: any } | typeof TIMED_OUT> {
  return withTimeout(
    (async () => {
      const res = await call;
      if (res.error || !res.data) {
        return { data: null, error: res.error ?? null };
      }
      const raw = res.data;
      const buf: Buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(await raw.arrayBuffer());
      return { data: buf, error: null };
    })(),
    ms
  );
}

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

  const now = args.now ?? Date.now;
  const deadline = now() + (args.budgetMs ?? FREEZE_BUDGET_MS);

  const candidates = freezeCandidates(job.user_id, job.id);
  const dedupe = dedupeIdentityFor("company");

  let selectedCandidate: { candidate: { bucket: "partials"; path: string }; bytes: Buffer; ids: string[] } | null = null;

  for (let index = 0; index < candidates.length; index++) {
    if (deadline - now() < FREEZE_IO_TIMEOUT_MS) {
      return "retry";
    }

    const candidate = candidates[index];
    let downloadResult: any;
    try {
      downloadResult = await downloadWithin(
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

    const bytes: Buffer = data;

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

  const sha = createHash("sha256").update(selectedCandidate.bytes).digest("hex");
  const path = frozenPathFor(job.user_id, job.id, sha);

  if (deadline - now() < FREEZE_IO_TIMEOUT_MS) {
    return "retry";
  }

  let uploadResult: any;
  try {
    uploadResult = await withTimeout(
      admin.storage.from("results").upload(path, selectedCandidate.bytes, {
        contentType: "application/json",
        upsert: false,
      }),
      FREEZE_IO_TIMEOUT_MS
    );
  } catch {
    return "retry";
  }

  if (uploadResult === TIMED_OUT) {
    return "retry";
  }

  if (uploadResult.error) {
    const err = uploadResult.error;
    const status = Number(err?.statusCode ?? err?.status ?? 0);
    const msg = String(err?.message ?? "");
    const isConflict = status === 409 || /exists|duplicate/i.test(msg);
    if (!isConflict) {
      return "retry";
    }

    if (deadline - now() < FREEZE_IO_TIMEOUT_MS) {
      return "retry";
    }

    let dlExisting: any;
    try {
      dlExisting = await downloadWithin(
        admin.storage.from("results").download(path),
        FREEZE_IO_TIMEOUT_MS
      );
    } catch {
      return "retry";
    }

    if (dlExisting === TIMED_OUT || dlExisting.error || !dlExisting.data) {
      return "retry";
    }

    const existingBytes: Buffer = dlExisting.data;

    const existingSha = createHash("sha256").update(existingBytes).digest("hex");
    if (existingSha !== sha) {
      console.error("[job-groups:frozen-object-mismatch]", { jobId: job.id });
      return "retry";
    }
  }

  const sortedKeys = [...selectedCandidate.ids].sort();

  if (deadline - now() < FREEZE_RPC_TIMEOUT_MS) {
    return "retry";
  }

  let rpcResult: any;
  try {
    rpcResult = await withTimeout(
      admin.rpc("freeze_and_settle_group_part_atomic", {
        p_group_id: args.groupId,
        p_part_index: args.partIndex,
        p_job_id: job.id,
        p_path: path,
        p_sha256: sha,
        p_row_count: job.delivered_units,
        p_keys: sortedKeys,
      }),
      FREEZE_RPC_TIMEOUT_MS
    );
  } catch {
    return "retry";
  }

  if (rpcResult === TIMED_OUT || !rpcResult) {
    return "retry";
  }

  if (rpcResult.error) {
    return "retry";
  }

  const data = rpcResult.data;
  if (!data || typeof data !== "object") {
    return "retry";
  }

  if (data.success === true || data.error === "freeze_conflict") {
    return "frozen";
  }

  const errCode = data.error;
  if (
    errCode === "invalid_path" ||
    errCode === "count_mismatch" ||
    errCode === "keys_mismatch" ||
    errCode === "keys_overlap"
  ) {
    return "unfreezable";
  }

  if (errCode === "part_not_awaiting_freeze") {
    return "retry";
  }

  return "retry";
}
