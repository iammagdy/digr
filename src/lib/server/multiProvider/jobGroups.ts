import { withTimeout, TIMED_OUT, isMissingSchema } from "./jobGroupShared";
import { GROUP_CLOSING_NOTICE_AR } from "../../multiProvider/copy";

export const TICK_BUDGET_MS = 45_000;
export const MIN_LEFT_FOR_CLAIM_MS = 35_000;
export const MAX_CLAIMS_PER_TICK = 10;
export const QUIET_SECONDS = 180;
export const FREEZE_GIVE_UP_MS = 20 * 60_000;
export const OVERDUE_AFTER_MS = (2 * 60 + 15) * 60_000;
export const STOP_AFTER_EMPTY_PARTS = 0;

export type { GroupCloseReason } from "../../multiProvider/copy";

export function buildPartItem(firstItem: any, partIndex: number, groupId: string): any {
  const clone = JSON.parse(JSON.stringify(firstItem));
  const V = firstItem.params?.split?.partVolumes?.[partIndex - 1];
  clone.targetVolumeMax = V;
  clone.targetVolumeMin = Math.min(firstItem.targetVolumeMin ?? 1, V);
  clone.params = {
    ...clone.params,
    split: {
      ...firstItem.params?.split,
      part: partIndex,
      groupId,
    },
  };
  delete clone.params.excludeRowKeys;
  return clone;
}

export async function reconcileJobGroups(
  admin: any,
  opts: {
    nowMs: number;
    source: "drive" | "watchdog";
    budgetMs: number;
    now?: () => number;
  }
): Promise<{
  installed: boolean;
  claims: number;
  frozen: number;
  released: number;
  drawn: number;
  closed: number;
}> {
  try {
    const tickDeadline = opts.nowMs + opts.budgetMs;
    const now = opts.now ?? Date.now;
    let logged = false;

    if (tickDeadline - now() >= 4_000) {
      let q: any;
      try {
        q = await withTimeout(
          admin
            .from("job_groups")
            .select("id", { count: "exact", head: true })
            .eq("status", "open")
            .lt("deadline_at", new Date(opts.nowMs - OVERDUE_AFTER_MS).toISOString()),
          4_000
        );
      } catch (err) {
        if (isMissingSchema(err)) {
          return { installed: false, claims: 0, frozen: 0, released: 0, drawn: 0, closed: 0 };
        }
        if (!logged) {
          console.error("[job-groups:overdue-check-failed]", { source: opts.source });
          logged = true;
        }
        q = null;
      }

      if (q === TIMED_OUT) {
        if (!logged) {
          console.error("[job-groups:overdue-check-failed]", { source: opts.source });
          logged = true;
        }
      } else if (q?.error) {
        if (isMissingSchema(q.error)) {
          return { installed: false, claims: 0, frozen: 0, released: 0, drawn: 0, closed: 0 };
        }
        if (!logged) {
          console.error("[job-groups:overdue-check-failed]", { source: opts.source });
          logged = true;
        }
      } else if (typeof q?.count === "number" && q.count > 0) {
        console.error("[job-groups:overdue]", { count: q.count, source: opts.source });
      }
    }

    let claims = 0;
    let frozen = 0;
    let released = 0;
    let drawn = 0;
    let closed = 0;

    while (claims < MAX_CLAIMS_PER_TICK && tickDeadline - now() >= MIN_LEFT_FOR_CLAIM_MS) {
      let claimRes: any;
      try {
        claimRes = await withTimeout(
          admin.rpc("claim_next_job_group", {
            p_quiet_seconds: QUIET_SECONDS,
            p_closing_notice_ar: GROUP_CLOSING_NOTICE_AR,
          }),
          4_000
        );
      } catch (err) {
        if (isMissingSchema(err)) {
          return { installed: false, claims, frozen, released, drawn, closed };
        }
        if (!logged) {
          console.error("[job-groups:claim-failed]", { source: opts.source });
          logged = true;
        }
        break;
      }

      if (claimRes === TIMED_OUT) {
        break;
      }

      if (claimRes?.error) {
        if (isMissingSchema(claimRes.error)) {
          return { installed: false, claims, frozen, released, drawn, closed };
        }
        if (!logged) {
          console.error("[job-groups:claim-failed]", { source: opts.source });
          logged = true;
        }
        break;
      }

      const claimData = claimRes?.data;
      if (
        claimData?.success !== true ||
        !claimData.group ||
        typeof claimData.group !== "object"
      ) {
        break;
      }

      claims += 1;
      const group = claimData.group;

      try {
        // Processing of group will be implemented in T04+
      } catch (groupErr) {
        if (!logged) {
          console.error("[job-groups:group-failed]", { source: opts.source });
          logged = true;
        }
      }
    }

    return {
      installed: true,
      claims,
      frozen,
      released,
      drawn,
      closed,
    };
  } catch (err) {
    if (isMissingSchema(err)) {
      return { installed: false, claims: 0, frozen: 0, released: 0, drawn: 0, closed: 0 };
    }
    return {
      installed: true,
      claims: 0,
      frozen: 0,
      released: 0,
      drawn: 0,
      closed: 0,
    };
  }
}
