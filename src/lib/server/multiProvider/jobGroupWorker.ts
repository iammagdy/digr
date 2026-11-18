import { withTimeout, TIMED_OUT } from "./jobGroupShared";

const GROUP_ID_REGEX = /^grp_[0-9a-f]{32}$/;
const TOTAL_BUDGET_MS = 15_000;
const PAGE_TIMEOUT_MS = 4_000;
const PAGE_SIZE = 1_000;

export function isGroupPartSpec(
  spec: { params?: any } | null | undefined,
  isChainJob?: boolean
): boolean {
  return Boolean(isChainJob && Number(spec?.params?.split?.v) === 3);
}

export async function loadGroupKeys(
  admin: any,
  groupId: unknown
): Promise<string[]> {
  if (typeof groupId !== "string" || !GROUP_ID_REGEX.test(groupId)) {
    throw new Error("group_keys_unavailable");
  }

  const startMs = Date.now();
  const deadlineMs = startMs + TOTAL_BUDGET_MS;
  const keys: string[] = [];
  let offset = 0;

  try {
    while (true) {
      const timeLeft = deadlineMs - Date.now();
      if (timeLeft <= 0) {
        throw new Error("group_keys_unavailable");
      }
      const pageTimeout = Math.min(PAGE_TIMEOUT_MS, timeLeft);
      const query = admin
        .from("job_group_keys")
        .select("key")
        .eq("group_id", groupId)
        .order("key", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);

      const res: any = await withTimeout(query, pageTimeout);
      if (res === TIMED_OUT || !res || res.error) {
        throw new Error("group_keys_unavailable");
      }

      const rows = res.data;
      if (!Array.isArray(rows)) {
        throw new Error("group_keys_unavailable");
      }

      for (const row of rows) {
        if (typeof row?.key === "string") {
          keys.push(row.key);
        }
      }

      if (rows.length < PAGE_SIZE) {
        break;
      }
      offset += rows.length;
    }
  } catch (err: any) {
    if (err?.message === "group_keys_unavailable") {
      throw err;
    }
    throw new Error("group_keys_unavailable");
  }

  return keys;
}
