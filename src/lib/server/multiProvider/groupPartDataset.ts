import { createHash } from "node:crypto";
import { GROUP_PART_FILE_PENDING_AR, GROUP_PART_FILE_UNAVAILABLE_AR } from "@/lib/multiProvider/copy";
import { frozenPathFor, isMissingSchema, TIMED_OUT, withTimeout } from "./jobGroupShared";

export type GroupPartServe =
  | { kind: "not_group" }
  | { kind: "frozen"; text: string; rowCount: number; sha256: string }
  | { kind: "refuse"; status: 409 | 503; errorAr: string };

const refuse = (status: 409 | 503): GroupPartServe => ({
  kind: "refuse",
  status,
  errorAr: status === 409 ? GROUP_PART_FILE_PENDING_AR : GROUP_PART_FILE_UNAVAILABLE_AR,
});

export async function groupPartDataset(
  admin: any,
  job: { id: string; user_id: string; status?: string | null }
): Promise<GroupPartServe> {
  try {
    const part: any = await withTimeout(
      admin.from("job_group_parts").select("group_id, part_index").eq("job_id", job.id).maybeSingle(),
      4_000
    );
    if (part === TIMED_OUT) return refuse(503);
    if (part?.error) return isMissingSchema(part.error) ? { kind: "not_group" } : refuse(503);
    if (!part?.data) return { kind: "not_group" };

    const frozen: any = await withTimeout(
      admin.from("job_group_frozen").select("path, sha256, row_count").eq("job_id", job.id).maybeSingle(),
      4_000
    );
    if (frozen === TIMED_OUT || frozen?.error) return refuse(503);
    if (!frozen?.data) {
      if (job.status === "completed") console.error("[job-groups:completed-unfrozen]", { jobId: job.id });
      return refuse(job.status === "completed" ? 503 : 409);
    }

    const { path, sha256, row_count: rowCount } = frozen.data;
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256) ||
      path !== frozenPathFor(job.user_id, job.id, sha256) || !Number.isInteger(rowCount) || rowCount < 0) {
      return refuse(503);
    }
    const downloaded: any = await withTimeout(admin.storage.from("results").download(path), 5_000);
    if (downloaded === TIMED_OUT || downloaded?.error || !downloaded?.data) return refuse(503);
    const bytes = Buffer.from(await downloaded.data.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
      console.error("[job-groups:frozen-hash-mismatch]", { jobId: job.id });
      return refuse(503);
    }
    const text = bytes.toString("utf8");
    const payload = JSON.parse(text);
    if (!Array.isArray(payload?.rows) || payload.rows.length !== rowCount) return refuse(503);
    return { kind: "frozen", text, rowCount, sha256 };
  } catch {
    return refuse(503);
  }
}
