import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "./helpers/fakeSupabase";
import { groupMissionRows } from "../src/lib/walletView";
import { missionWalletLineAr } from "../src/lib/agentMission/walletLine";
import { moneyLineAr } from "../src/lib/agentMission/moneyText";
import { knownItemNoun } from "../src/lib/agentMission/itemNoun";
import { readFileSync } from "node:fs";

const state = vi.hoisted(() => ({ user: null as any, admin: null as any }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => state.admin),
}));
import { GET as walletHistory } from "../src/app/api/wallet/history/route";

/**
 * THE WALLET LISTS A MISSION ONCE: the hold, the charge and the released hold stay exactly as they are in the ledger and appear under ONE line («خُصم ١٢٨ نقطة مقابل ١٩٢ تغريدة») with collapsible details.
 */
const USER = "11111111-1111-1111-1111-111111111111";
const customer = { id: USER, email: "c@x.test", app_metadata: {}, user_metadata: {} };
const tweet = knownItemNoun("تغريدة")!;
const plan = { stages: [{ key: "t", title_ar: "التغريدات", deliver: true }] };
const mission = (over: Record<string, unknown> = {}) => ({ id: "msn_1", user_id: USER, job_id: "job_a", status: "completed", delivered_units: 192, charged_points: 128, reserved_points: 200, plan_public: plan, ...over });

describe("the one line of a finished mission (the same text as the panel, the notification and the e-mail)", () => {
  it("what was charged and for how many items", () => {
    expect(missionWalletLineAr(mission() as any)).toBe("خُصم ١٢٨ نقطة مقابل ١٩٢ تغريدة");
    expect(missionWalletLineAr(mission() as any)).toBe(moneyLineAr({ reservedPoints: 200, chargedPoints: 128, delivered: 192, noun: tweet }));
    expect(missionWalletLineAr(mission({ delivered_units: 1, charged_points: 50 }) as any)).toBe("خُصم ٥٠ نقطة مقابل تغريدة واحدة");
  });
  it("nothing delivered: nothing was charged and the hold is «حجز مؤقت مُحرَّر»", () => {
    expect(missionWalletLineAr(mission({ status: "unserved", delivered_units: 0, charged_points: 0 }) as any)).toBe("لم يُخصم شيء؛ حجز مؤقت مُحرَّر ٢٠٠ نقطة");
    expect(missionWalletLineAr(mission({ status: "failed", delivered_units: 0, charged_points: 0 }) as any)).toBe("لم يُخصم شيء؛ حجز مؤقت مُحرَّر ٢٠٠ نقطة");
  });
  it("a mission that is still running, or has no stored charge, has no line (its rows are listed one by one)", () => {
    expect(missionWalletLineAr(mission({ status: "executing", charged_points: null }) as any)).toBeNull();
    expect(missionWalletLineAr(mission({ charged_points: null }) as any)).toBeNull();
    expect(missionWalletLineAr(mission({ job_id: null }) as any)).toBeNull();
  });
});

describe("grouping: the rows of one mission under its line, the others untouched", () => {
  const row = (id: string, delta: number, jobId: string | null, line: string | null, createdAt: string) => ({ id, $id: id, delta, jobId, missionLineAr: line, createdAt });
  const LINE = "خُصم ١٢٨ نقطة مقابل ١٩٢ تغريدة";
  const rows = [
    row("rel_job_a", 200, "job_a", LINE, "2026-10-29T00:52:00Z"),
    row("chg_job_a", -128, "job_a", LINE, "2026-10-29T00:52:00Z"),
    row("res_job_b", -200, "job_b", null, "2026-10-29T00:50:00Z"),
    row("res_job_a", -200, "job_a", LINE, "2026-10-29T00:49:00Z"),
    row("top_1", 500, null, null, "2026-10-28T10:00:00Z"),
  ];
  it("one group at the place of its newest row; a running mission's hold and a top-up stay single entries; the ledger rows are the same objects, in the same order", () => {
    const entries = groupMissionRows(rows);
    expect(entries.map((e) => (e.kind === "row" ? e.row.id : `mission:${e.jobId}:${e.rows.map((r) => r.id).join(",")}`))).toEqual(["mission:job_a:rel_job_a,chg_job_a,res_job_a", "res_job_b", "top_1"]);
    const group = entries[0];
    expect(group.kind === "mission" && group.lineAr).toBe(LINE);
    // nothing is added or removed: the group's rows net to minus what was charged
    expect(group.kind === "mission" && group.rows.reduce((n, r) => n + r.delta, 0)).toBe(-128);
    expect(entries.flatMap((e) => (e.kind === "row" ? [e.row] : e.rows))).toHaveLength(rows.length);
  });
});

describe("the wallet history answer carries the line of each finished mission", () => {
  it("rows of a finished mission carry its line; a top-up and the rows of another customer's mission carry none", async () => {
    state.user = customer;
    state.admin = fakeSupabase({
      missing: ["credit_ledger_typed"],
      tables: {
        credit_ledger: [
          { id: "top_t1", user_id: USER, delta: 500, type: "topup", topup_id: "t1", created_at: "2026-10-28T10:00:00Z" },
          { id: "res_job_a", user_id: USER, delta: -200, type: "reserve", job_id: "job_a", created_at: "2026-10-29T00:49:00Z" },
          { id: "chg_job_a", user_id: USER, delta: -128, type: "charge", job_id: "job_a", created_at: "2026-10-29T00:52:00Z" },
          { id: "rel_job_a", user_id: USER, delta: 200, type: "release", job_id: "job_a", created_at: "2026-10-29T00:52:00Z" },
        ],
        missions: [mission(), { ...mission(), id: "msn_other", user_id: "22222222-2222-2222-2222-222222222222", job_id: "job_a", charged_points: 1, delivered_units: 1 }],
      },
    }) as any;
    const body = await (await walletHistory(new NextRequest("http://localhost/api/wallet/history"))).json();
    expect(body.success).toBe(true);
    const byId = Object.fromEntries(body.rows.map((r: any) => [r.id, r]));
    expect(byId.res_job_a.missionLineAr).toBe("خُصم ١٢٨ نقطة مقابل ١٩٢ تغريدة");
    expect(byId.chg_job_a.missionLineAr).toBe("خُصم ١٢٨ نقطة مقابل ١٩٢ تغريدة");
    expect(byId.rel_job_a.missionLineAr).toBe("خُصم ١٢٨ نقطة مقابل ١٩٢ تغريدة");
    expect(byId.top_t1.missionLineAr).toBeNull();
    // the ledger rows themselves are as they were
    expect(body.rows.map((r: any) => [r.id, r.delta])).toEqual(expect.arrayContaining([["res_job_a", -200], ["chg_job_a", -128], ["rel_job_a", 200], ["top_t1", 500]]));
  });

  it("the wallet page draws the groups: one line, the details collapsed, the ledger row component unchanged", () => {
    const page = readFileSync("src/app/dashboard/topup/page.tsx", "utf8");
    expect(page).toContain("groupMissionRows(visibleLedger)");
    expect(page).toContain('data-testid="wallet-mission-group"');
    // the line is a button with its own open state (WalletJobToggle), not the browser's native <details>
    expect(page).not.toContain("<details");
    expect(page).toContain("<WalletJobToggle");
    expect(page).toContain("function LedgerLine");
  });
});
