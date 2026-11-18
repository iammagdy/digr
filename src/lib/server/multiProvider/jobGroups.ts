import { withTimeout, TIMED_OUT, isMissingSchema } from "./jobGroupShared";
import { freezeGroupPart } from "./jobGroupFreeze";
import {
  GROUP_CLOSING_NOTICE_AR,
  GROUP_PART_STOPPED_AR,
  groupDrawLineAr,
  groupFinalLineAr,
} from "../../multiProvider/copy";
import {
  getConfiguredJobPointsCap,
  DEFAULT_JOB_POINTS_CAP,
} from "../../../functions/shared/providerSpend";

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
        const gid = group.id;
        const L = (group.next_part ?? 1) - 1;
        const jobL = claimData.current;
        const resFrozen = Boolean(claimData.frozen);

        const isRunningOrQueued = jobL?.status === "queued" || jobL?.status === "running";
        const isAwaitingFreeze = jobL?.status === "running" && jobL?.current_cursor === "completed";

        if (isAwaitingFreeze) {
          const f = await freezeGroupPart(admin, {
            groupId: gid,
            partIndex: L,
            job: {
              id: jobL.id,
              user_id: group.user_id,
              delivered_units: jobL.delivered_units ?? 0,
            },
            now,
          });

          if (f === "frozen") {
            frozen += 1;
            // continue to R3 reads
          } else if (f === "unfreezable") {
            // T08 handles RELEASE
            continue;
          } else if (f === "retry") {
            const updatedAgo = now() - Date.parse(jobL.updated_at ?? "1970-01-01");
            const overdue2h = now() >= Date.parse(group.deadline_at) + 2 * 3_600_000;
            if (updatedAgo >= FREEZE_GIVE_UP_MS || overdue2h) {
              // T08 handles RELEASE
              continue;
            } else {
              continue;
            }
          }
        } else if (isRunningOrQueued) {
          if (now() < Date.parse(group.deadline_at)) {
            continue;
          }

          const stale = jobL?.lease_until
            ? Date.parse(jobL.lease_until) < now() - 30 * 60_000
            : Date.parse(jobL?.updated_at ?? "1970-01-01") < now() - 30 * 60_000;
          const overdue2h = now() >= Date.parse(group.deadline_at) + 2 * 3_600_000;

          if (stale || overdue2h) {
            // Stuck: read parts and close deadline_stuck
            const partsRes = await withTimeout(
              admin.from("job_group_parts").select("part_index, job_id").eq("group_id", gid),
              4_000
            );
            if (partsRes === TIMED_OUT || partsRes?.error || !Array.isArray(partsRes?.data)) {
              continue;
            }

            const partRows = partsRes.data;
            const jobIds = partRows.map((p: any) => p.job_id).filter(Boolean);

            let jobs: any[] = [];
            if (jobIds.length > 0) {
              const jobsRes = await withTimeout(
                admin
                  .from("jobs")
                  .select("id, status, current_cursor, delivered_units, charged_credits, updated_at")
                  .in("id", jobIds),
                4_000
              );
              if (jobsRes === TIMED_OUT || jobsRes?.error || !Array.isArray(jobsRes?.data)) {
                continue;
              }
              jobs = jobsRes.data;
            }

            const jobMap = new Map<string, any>();
            for (const j of jobs) {
              jobMap.set(j.id, j);
            }

            let Z = 0;
            let C = 0;
            for (const p of partRows) {
              if (p.part_index === L) {
                // Active part ends with 0 delivered and 0 charged
                continue;
              }
              const j = jobMap.get(p.job_id);
              if (j) {
                if (j.status === "completed") {
                  Z += (j.delivered_units ?? 0);
                }
                C += (j.charged_credits ?? 0);
              }
            }

            const closeRes = await withTimeout(
              admin.rpc("close_job_group_atomic", {
                p_group_id: gid,
                p_reason: "deadline_stuck",
                p_final_line_ar: groupFinalLineAr({
                  reason: "deadline_stuck",
                  Z,
                  X: group.asked_original,
                  Y: group.reachable,
                  C,
                }),
                p_delivered_total: Z,
                p_charged_total: C,
                p_part_release_ar: GROUP_PART_STOPPED_AR,
              }),
              4_000
            );

            if (closeRes === TIMED_OUT || closeRes?.error) {
              continue;
            }
            if (closeRes?.data?.success === true) {
              closed += 1;
            }
            continue;
          } else {
            // Not stuck yet
            continue;
          }
        }

        // R3 reads
        const partsRes = await withTimeout(
          admin.from("job_group_parts").select("part_index, job_id").eq("group_id", gid),
          4_000
        );
        if (partsRes === TIMED_OUT || partsRes?.error || !Array.isArray(partsRes?.data)) {
          continue;
        }

        const partRows = partsRes.data;
        const jobIds = partRows.map((p: any) => p.job_id).filter(Boolean);

        let jobs: any[] = [];
        if (jobIds.length > 0) {
          const jobsRes = await withTimeout(
            admin
              .from("jobs")
              .select("id, status, current_cursor, delivered_units, charged_credits, updated_at")
              .in("id", jobIds),
            4_000
          );
          if (jobsRes === TIMED_OUT || jobsRes?.error || !Array.isArray(jobsRes?.data)) {
            continue;
          }
          jobs = jobsRes.data;
        }

        const jobMap = new Map<string, any>();
        for (const j of jobs) {
          jobMap.set(j.id, j);
        }

        const sortedParts = [...partRows].sort((a: any, b: any) => a.part_index - b.part_index);
        const orderedJobs: any[] = sortedParts.map((p: any) => jobMap.get(p.job_id)).filter(Boolean);

        let Z = 0;
        let C = 0;
        for (const j of orderedJobs) {
          if (j.status === "completed") {
            Z += (j.delivered_units ?? 0);
          }
          C += (j.charged_credits ?? 0);
        }

        let E = 0;
        for (let i = orderedJobs.length - 1; i >= 0; i--) {
          const j = orderedJobs[i];
          if (j.status === "failed" || (j.delivered_units ?? 0) === 0) {
            E++;
          } else {
            break;
          }
        }

        const halted =
          group.halted_at != null ||
          (jobL?.status === "failed" &&
            jobL?.current_cursor === "completed" &&
            resFrozen === false);

        let reason: string | null = null;
        if (halted) {
          reason = "part_unfrozen";
        } else if (L === group.parts_planned) {
          reason = "all_parts_done";
        } else if (now() >= Date.parse(group.deadline_at)) {
          reason = "deadline";
        } else if (STOP_AFTER_EMPTY_PARTS > 0 && E >= STOP_AFTER_EMPTY_PARTS) {
          reason = "empty_parts";
        }

        if (reason) {
          const closeRes = await withTimeout(
            admin.rpc("close_job_group_atomic", {
              p_group_id: gid,
              p_reason: reason,
              p_final_line_ar: groupFinalLineAr({
                reason: reason as any,
                Z,
                X: group.asked_original,
                Y: group.reachable,
                C,
              }),
              p_delivered_total: Z,
              p_charged_total: C,
              p_part_release_ar: reason === "deadline_stuck" ? GROUP_PART_STOPPED_AR : null,
            }),
            4_000
          );

          if (closeRes === TIMED_OUT || closeRes?.error) {
            continue;
          }

          if (closeRes?.data?.success === true) {
            closed += 1;
          }
          continue;
        }

        // R5 DRAW
        const quoteRes = await withTimeout(
          admin.from("plans_quotes").select("items").eq("id", group.quote_id).maybeSingle(),
          4_000
        );
        if (quoteRes === TIMED_OUT || quoteRes?.error || !quoteRes?.data?.items?.[0]) {
          continue;
        }

        const firstItem = quoteRes.data.items[0];
        const nextPartIndex = L + 1;
        const item = buildPartItem(firstItem, nextPartIndex, gid);

        const drawRes = await withTimeout(
          admin.rpc("draw_next_group_part_atomic", {
            p_group_id: gid,
            p_part_index: nextPartIndex,
            p_items: [item],
            p_event_ar: groupDrawLineAr({
              k: nextPartIndex,
              K: group.parts_planned,
              Z,
              Y: group.reachable,
            }),
            p_delivered_so_far: Z,
            p_points_cap: Math.min(getConfiguredJobPointsCap(), DEFAULT_JOB_POINTS_CAP),
          }),
          4_000
        );

        if (drawRes === TIMED_OUT || drawRes?.error) {
          continue;
        }

        if (drawRes?.data?.success === true && !drawRes?.data?.already_drawn) {
          drawn += 1;
        }
        continue;
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
