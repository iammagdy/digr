import { MISSION_TABLE } from "../constants";
import { ADDON_APPROVE_MESSAGES_AR, readAddonPlan } from "../addonSettlement";
import { ADDON_CREATE_REFUSALS_AR, listWithRecovery, reconcileOpenAddons } from "./addonRow";
import { createSupabaseAddonRowStore } from "./addonRowStore";
import { paidReviewVerdict, reviewReportPublished } from "./paidReview";

/**
 * SAFETY FIX B (docs/STAGE-4-FINANCIAL-SAFETY.md, docs/STAGE-4-APPROVAL-BOUNDARY.md): THE CHECKS THE PLANNED APPROVAL ROUTE MUST PASS BEFORE the approval function of addonSettlement.ts. UNWIRED: no route calls this file (tests/money7a-isolation.test.ts); the approval route itself is BLOCKED FOR OWNER APPROVAL. It decides nothing about money:
 * it reads, it may run the existing creation-protocol repair (`reconcileOpenAddons`: cancels UNPAID duplicates only), and it answers whether approval may START. It refuses, with nothing reserved:
 *   not_found       not the customer's request, not an add-on, missing
 *   not_ready       not `plan_ready` (already started, ended or cancelled)
 *   open_addon      another add-on of the file outranks this one (a started request first, then the lowest id): one open add-on per file
 *   review_exists   a completed review, or a published report, of this version already exists: it is shown free (decision D11)
 *   review_unresolved  an earlier review of this version was CHARGED and its report is not published (`paidReview.ts`): no second paid review is approved
 *   unavailable     a read failed: never «allowed» on a guess
 * The approval function itself stays as it is (it prices again, claims by compare-and-set and reserves through the existing functions).
 */
export type ApprovalGuardResult =
  | { ok: true }
  | { ok: false; status: 404 | 409 | 503; reason: "not_found" | "not_ready" | "price_mismatch" | "version_changed" | "open_addon" | "review_exists" | "review_unresolved" | "unavailable"; messageAr: string };

const NOTHING_HELD_AR = "تعذّر التحقق من الطلب الآن. لم يُحجز أو يُخصم شيء، فحاول بعد قليل.";
const no = (status: 404 | 409 | 503, reason: Extract<ApprovalGuardResult, { ok: false }>["reason"], messageAr: string): ApprovalGuardResult => ({ ok: false, status, reason, messageAr });

export async function guardApproval(client: any, input: { id: string; userId: string; /** The hold the page showed (the browser sends it; it is only COMPARED with the price the server computes, never used). */ expectedPoints?: number }): Promise<ApprovalGuardResult> {
  try {
    const { data: row, error } = await client.from(MISSION_TABLE).select("id,user_id,status,plan").eq("id", input.id).maybeSingle();
    if (error) return no(503, "unavailable", NOTHING_HELD_AR);
    const addon = row && row.user_id === input.userId ? readAddonPlan(row.plan) : null;
    if (!row || !addon) return no(404, "not_found", ADDON_APPROVE_MESSAGES_AR.not_found);
    if (row.status !== "plan_ready") return no(409, "not_ready", ADDON_APPROVE_MESSAGES_AR.not_ready);

    const store = createSupabaseAddonRowStore(client, input.userId);
    // one open add-on per file: repair first, and only the one that stays may start
    const { keeper } = await reconcileOpenAddons(store, addon.of);
    if (!keeper || keeper.id !== input.id) return no(409, "open_addon", ADDON_CREATE_REFUSALS_AR.open_addon);

    if (addon.kind === "review") {
      const rows = await listWithRecovery(store, addon.of);
      const completed = rows.some((r) => { const a = readAddonPlan(r.plan); return r.status === "completed" && a !== null && a.kind === "review" && a.baseVersion === addon.baseVersion && r.id !== input.id; });
      if (completed || (await reviewReportPublished(client, addon.of, addon.baseVersion))) return no(409, "review_exists", ADDON_CREATE_REFUSALS_AR.review_exists);
      const verdict = await paidReviewVerdict(client, { missionId: addon.of, baseVersion: addon.baseVersion, rows });
      if (verdict.kind === "report_published") return no(409, "review_exists", ADDON_CREATE_REFUSALS_AR.review_exists);
      if (verdict.kind === "unresolved") return no(409, "review_unresolved", ADDON_CREATE_REFUSALS_AR.review_unresolved);
    }
    return { ok: true };
  } catch {
    return no(503, "unavailable", NOTHING_HELD_AR);
  }
}
