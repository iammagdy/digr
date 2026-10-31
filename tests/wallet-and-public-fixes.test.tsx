import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "./helpers/fakeSupabase";

// ---------------------------------------------------------------------------------------------------------------- mocks (the same shape as tests/ui-pass-1.test.tsx)
const state = vi.hoisted(() => ({ user: null as any, admin: null as any, auth: { user: null as any, loading: true } }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => state.admin),
}));
vi.mock("../src/lib/server/liveDailyCap", () => ({ liveDailyCapPoints: async () => undefined }));
// the shell reads the signed-in customer from the provider: the test sets it (loading / visitor / signed in)
vi.mock("../src/hooks/useUser", () => ({
  useUser: () => ({ user: state.auth.user, loading: state.auth.loading, login: vi.fn(), register: vi.fn(), refresh: vi.fn(), logout: vi.fn() }),
  useOptionalUser: () => state.auth.user,
}));
vi.mock("../src/hooks/useBalance", () => ({ useBalance: () => ({ balance: { status: "ready", value: 7754 }, refresh: vi.fn() }) }));
vi.mock("../src/hooks/useNotifications", () => ({ useNotifications: () => ({ items: [], unread: 0, actionableUnread: 0, markAllRead: vi.fn(), markRead: vi.fn() }) }));
vi.mock("../src/hooks/useOnline", () => ({ useOnline: () => true }));
vi.mock("../src/lib/avatarClient", () => ({ useAvatar: () => ({ url: null }) }));
vi.mock("../src/lib/supabase/client", () => ({ createClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ in: async () => ({ count: 0, data: [] }) }) }) }) }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/pricing", useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));

import { GET as walletHistory } from "../src/app/api/wallet/history/route";
import { WalletJobToggle } from "../src/app/dashboard/topup/WalletJobToggle";
import { AppShell } from "../src/components/app/AppShell";
import { formatMomentCairo } from "../src/lib/customerDates";
import { groupMissionRows, toggledSet } from "../src/lib/walletView";
import { estimateSlug } from "../src/lib/missionEstimate";
import { bareNounAr, countKindOfSlug, countPlainAr } from "../src/lib/planCounts";
import { unitPriceLabelAr } from "../src/lib/pointsFormat";
import { kindsOfPlatform } from "../src/components/calculator/MissionEstimator";
import { wordBoundarySheetName } from "../src/lib/agentMission/fileNames";

const src = (file: string) => readFileSync(file, "utf8");
const text = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

// ================================================================================================================ A. the wallet shows two jobs, not one job twice
describe("A. the wallet: two 50-tweet jobs of the TEST account are two lines (the rows are the real ones, read-only, of 2026-10-30 and 2026-10-31)", () => {
  const USER = "11111111-1111-1111-1111-111111111111";
  const J1 = "job_quote_980be00960b589d8c5e0f94e2f578963"; // reserved 200 at 2026-10-30 22:45:13 UTC, released and charged 200 at 22:45:30
  const J2 = "job_quote_435bc269d69705bc67a588a23e895203"; // reserved 200 at 2026-10-31 07:25:02 UTC, released and charged 200 at 07:25:27
  const L = (jobId: string, type: "reserve" | "release" | "charge", delta: number, at: string) => ({ id: `${type.slice(0, 3)}_${jobId}`, user_id: USER, delta, type, job_id: jobId, created_at: at });
  const ledger = [
    L(J1, "reserve", -200, "2026-10-30T22:45:13.712074+00:00"), L(J1, "release", 200, "2026-10-30T22:45:30.161814+00:00"), L(J1, "charge", -200, "2026-10-30T22:45:30.161814+00:00"),
    L(J2, "reserve", -200, "2026-10-31T07:25:02.388516+00:00"), L(J2, "release", 200, "2026-10-31T07:25:27.506387+00:00"), L(J2, "charge", -200, "2026-10-31T07:25:27.506387+00:00"),
  ];
  const plan = { stages: [{ title_ar: "التغريدات", deliver: true }] };
  const missions = [
    { id: "msn_1d76", user_id: USER, job_id: J1, status: "completed", delivered_units: 50, charged_points: 200, reserved_points: 200, plan_public: plan },
    { id: "msn_e3a9", user_id: USER, job_id: J2, status: "completed", delivered_units: 50, charged_points: 200, reserved_points: 200, plan_public: plan },
  ];
  const historyOf = async (tables: Record<string, any[]>) => {
    state.user = { id: USER, email: "c@x.test", app_metadata: {}, user_metadata: {} };
    state.admin = fakeSupabase({ missing: ["credit_ledger_typed"], tables }) as any;
    return (await (await walletHistory(new NextRequest("http://localhost/api/wallet/history"))).json()).rows as any[];
  };
  const entriesOf = (rows: any[]) => groupMissionRows(rows.map((r) => ({ ...r, $id: r.id })));

  it("the route gives every row of both jobs the same one line; the wallet draws exactly two groups of three rows (no row on its own, no group twice)", async () => {
    const rows = await historyOf({ credit_ledger: ledger, missions });
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((r) => r.missionLineAr))).toEqual(new Set(["خُصم ٢٠٠ نقطة مقابل ٥٠ تغريدة"]));
    const entries = entriesOf(rows);
    expect(entries.map((e) => e.kind)).toEqual(["mission", "mission"]);
    expect(entries.map((e) => (e.kind === "mission" ? e.rows.length : 0))).toEqual([3, 3]);
    expect(entries.map((e) => (e.kind === "mission" ? e.jobId : ""))).toEqual([J2, J1]);
  });

  it("the two lines read the same in words and points (that is what looked like a repeat) and are two real charges of one job each: the ledger holds 2 charge rows, one per job", async () => {
    const rows = await historyOf({ credit_ledger: ledger, missions });
    expect(rows.filter((r) => r.type === "charge").map((r) => r.jobId).sort()).toEqual([J1, J2].sort());
    expect(rows.reduce((n, r) => n + r.delta, 0)).toBe(-400);
  });

  it("each line carries its own day AND time on the Cairo clock, so the two lines differ even when both are on the same day", () => {
    const first = formatMomentCairo("2026-10-30T22:45:30.161814+00:00");
    const second = formatMomentCairo("2026-10-31T07:25:27.506387+00:00");
    expect(first).toBe("٣١ أكتوبر، ١٢:٤٥ ص");
    expect(second).toBe("٣١ أكتوبر، ٩:٢٥ ص");
    expect(first).not.toBe(second);
    expect(formatMomentCairo("not a date")).toBe("");
    // the same text whatever zone the phone is in
    expect(src("src/lib/customerDates.ts")).toMatch(/timeZone: "Africa\/Cairo", day: "numeric", month: "long", hour: "numeric"/);
  });

  it("ONE job is ONE line, in any order of its rows and with equal timestamps, and even when two mission rows name the same job", async () => {
    const one = ledger.filter((r) => r.job_id === J2);
    for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0], [2, 0, 1]]) {
      const rows = await historyOf({ credit_ledger: order.map((i) => one[i]), missions: [missions[1]] });
      const entries = entriesOf(rows);
      expect(entries).toHaveLength(1);
      expect(entries[0].kind).toBe("mission");
    }
    const twoMissionRows = await historyOf({ credit_ledger: one, missions: [missions[1], { ...missions[1], id: "msn_retry" }] });
    expect(entriesOf(twoMissionRows)).toHaveLength(1);
  });

  it("a job with no mission row is one line too, and the line of a job never lands on another job's rows", async () => {
    const rows = await historyOf({ credit_ledger: ledger, missions: [missions[0]], jobs: [{ id: J2, user_id: USER, status: "completed", delivered_units: 50 }] });
    const entries = entriesOf(rows);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.kind === "mission" && e.rows.every((r: any) => r.jobId === e.jobId))).toBe(true);
  });
});

// ================================================================================================================ B. the wallet line opens and folds
describe("B. the wallet line opens and folds (a button with its own state, not the browser's native <details>)", () => {
  const toggle = (open: boolean) => renderToStaticMarkup(createElement(WalletJobToggle, { lineAr: "خُصم ٢٠٠ نقطة مقابل ٥٠ تغريدة", whenAr: "٣١ أكتوبر، ٩:٢٥ ص", net: -200, open, panelId: "p0", onToggle: () => {} }));

  it("closed: a button that says it is closed and offers the details; open: the same button says it is open and offers to hide them", () => {
    const closed = toggle(false);
    expect(closed).toMatch(/<button[^>]*type="button"[^>]*aria-expanded="false"[^>]*aria-controls="p0"/);
    expect(text(closed)).toContain("تفاصيل الحركات");
    expect(text(closed)).toContain("٣١ أكتوبر، ٩:٢٥ ص");
    const open = toggle(true);
    expect(open).toMatch(/aria-expanded="true"/);
    expect(text(open)).toContain("إخفاء التفاصيل");
    expect(text(open)).not.toContain("تفاصيل الحركات");
    // 44 px tall at least, and no native <details>/<summary>
    expect(closed).toContain("min-h-11");
    expect(closed).not.toMatch(/<details|<summary/);
  });

  it("pressing it opens, pressing again folds, and one line never changes another (the open state is a set of job ids that is never changed in place)", () => {
    const none = new Set<string>();
    const a = toggledSet(none, "job_a");
    expect([...a]).toEqual(["job_a"]);
    expect([...toggledSet(a, "job_a")]).toEqual([]);
    expect([...toggledSet(a, "job_b")].sort()).toEqual(["job_a", "job_b"]);
    expect(none.size).toBe(0);
    expect([...a]).toEqual(["job_a"]);
  });

  it("the wallet page keeps that state, draws the rows only while a line is open, and has no native <details> in the wallet list", () => {
    const page = src("src/app/dashboard/topup/page.tsx");
    expect(page).toContain("const [openJobs, setOpenJobs] = useState<ReadonlySet<string>>");
    expect(page).toContain("toggledSet(cur, entry.jobId)");
    expect(page).toMatch(/\{isOpen \? <div id=\{panelId\}[^>]*data-testid="wallet-mission-details">/);
    expect(page).not.toContain("<details");
    expect(page).toContain('data-testid="wallet-mission-group"');
  });
});

// ================================================================================================================ C. public pages: the signed-in state, never «تسجيل الدخول» to a signed-in customer
describe("C. public pages show the signed-in state; «تسجيل الدخول» only for a visitor whose session has been read", () => {
  const shell = () => renderToStaticMarkup(createElement(AppShell, { allowGuest: true, children: createElement("p", null, "محتوى") }));
  const customer = { id: "u1", $id: "u1", email: "c@x.test", name: "مجدي", labels: [], app_metadata: {}, user_metadata: { persona: "researcher" } };

  it("before the session is read (the page as it is built ahead of time and first drawn): no sign-in button, no register button, only the content", () => {
    state.auth = { user: null, loading: true };
    const markup = shell();
    expect(text(markup)).not.toContain("تسجيل الدخول");
    expect(text(markup)).not.toContain("إنشاء حساب");
    expect(markup).toContain("محتوى");
  });

  it("a signed-in customer sees the balance and the account, never the sign-in button (the same header as the dashboard)", () => {
    state.auth = { user: customer, loading: false };
    const markup = shell();
    expect(text(markup)).toContain("٧٬٧٥٤");
    expect(text(markup)).toContain("نقطة");
    expect(text(markup)).not.toContain("تسجيل الدخول");
    expect(markup).toContain('aria-label="الإشعارات"');
  });

  it("a visitor whose session has been read (nobody is signed in) still gets the sign-in button", () => {
    state.auth = { user: null, loading: false };
    const markup = shell();
    expect(text(markup)).toContain("تسجيل الدخول");
  });

  it("every public page uses that one shell (SiteFrame → AppShell allowGuest)", () => {
    expect(src("src/components/app/SiteFrame.tsx")).toContain("<AppShell allowGuest>");
    for (const file of ["src/app/pricing/layout.tsx", "src/app/help/layout.tsx", "src/app/services/layout.tsx", "src/app/calculator/layout.tsx", "src/app/contact/layout.tsx", "src/app/legal/layout.tsx"]) {
      expect(src(file), file).toContain("SiteFrame");
    }
  });
});

// ================================================================================================================ D. the calculator names the item
describe("D. the calculator says «لعدد ٥٠ تغريدة» (the item's own noun), never «٥٠ سجل»", () => {
  it("every platform and kind the calculator offers has its own noun from the existing helper, and none falls back to «سجل»", () => {
    const seen: string[] = [];
    for (const platform of ["youtube", "facebook", "x", "tiktok", "companies"]) {
      for (const kind of kindsOfPlatform(platform)) {
        const slug = estimateSlug(kind, platform as any);
        expect(slug, `${platform} ${kind}`).toBeTruthy();
        const phrase = countPlainAr(50, countKindOfSlug(slug));
        expect(phrase).not.toMatch(/سجل/);
        seen.push(`${platform}/${kind}: ${phrase}`);
      }
    }
    expect(seen).toContain("x/posts: ٥٠ تغريدة");
    expect(seen).toContain("youtube/comments: ٥٠ تعليق");
    expect(seen).toContain("facebook/posts: ٥٠ منشور");
    expect(seen).toContain("tiktok/videos: ٥٠ فيديو");
    expect(seen).toContain("companies/companies: ٥٠ شركة");
  });

  it("the price half of the same sentence uses the same noun: «بسعر حوالي ٢٧٫٥ نقطة لكل ١٠٠ تغريدة», «٦ نقطة لكل فيديو»", () => {
    const tweet = bareNounAr(countKindOfSlug("social-x-posts"));
    expect(unitPriceLabelAr(0.275, tweet)).toBe("حوالي ٢٧٫٥ نقطة لكل ١٠٠ تغريدة");
    expect(unitPriceLabelAr(6, bareNounAr(countKindOfSlug("social-tiktok-videos")))).toBe("٦ نقطة لكل فيديو");
    for (const platform of ["youtube", "facebook", "x", "tiktok", "companies"]) {
      for (const kind of kindsOfPlatform(platform)) {
        const noun = bareNounAr(countKindOfSlug(estimateSlug(kind, platform as any)));
        expect(unitPriceLabelAr(0.275, noun), `${platform} ${kind}`).not.toMatch(/سجل/);
      }
    }
  });

  it("the estimator takes both nouns from the result's own service (not the fixed «records» / «سجل»)", () => {
    const code = src("src/components/calculator/MissionEstimator.tsx");
    expect(code).toContain("countPlainAr(result.volume, countKindOfSlug(result.slug))");
    expect(code).toContain("unitPriceLabelAr(result.unitPricePoints, bareNounAr(countKindOfSlug(result.slug)))");
    expect(code).not.toMatch(/countPlainAr\([^)]*"records"/);
  });
});

// ================================================================================================================ E. Excel sheet names are not cut mid-phrase
describe("E. an Excel sheet name is cut at a word boundary and never ends on «في / عن / من»", () => {
  const name = (title: string, used = new Set<string>()) => wordBoundarySheetName(title, used, "مرحلة 1");

  it("the reported title: «تغريدات عن الذكاء الاصطناعي في» (31 characters) loses its dangling «في»", () => {
    expect(name("تغريدات عن الذكاء الاصطناعي في مصر")).toBe("تغريدات عن الذكاء الاصطناعي");
    expect(name("تغريدات عن الذكاء الاصطناعي في مصر آخر أسبوع")).toBe("تغريدات عن الذكاء الاصطناعي");
  });

  it("«من», «عن», «على», «إلى» and the conjunction «و» are dropped from the end of a cut title too, one after another", () => {
    expect(name("منشورات الصفحات الرسمية للأندية من الدوري المصري")).toBe("منشورات الصفحات الرسمية للأندية");
    expect(name("تغريدات الأخبار العاجلة عن في الأسبوع الماضي")).not.toMatch(/(?:^| )(?:في|عن|من|على|إلى|و)$/);
    expect(name("تعليقات الفيديوهات الأعلى مشاهدة على من في الدوري")).not.toMatch(/(?:^| )(?:في|عن|من|على|إلى|و)$/);
  });

  it("a title that fits is left exactly as it is, and a cut title keeps at least one word and at most 31 characters", () => {
    expect(name("التغريدات")).toBe("التغريدات");
    expect(name("الشركات في")).toBe("الشركات في");
    for (const title of ["تغريدات عن الذكاء الاصطناعي في مصر", "في عن من على إلى مع و أو في عن من على إلى مع و أو", "x".repeat(60)]) {
      const out = name(title);
      expect([...out].length).toBeLessThanOrEqual(31);
      expect(out.length).toBeGreaterThan(0);
    }
  });

  it("a second sheet with the same title gets the number as before and is cut the same way (no dangling word, 31 characters at most)", () => {
    const used = new Set<string>();
    const first = name("تغريدات عن الذكاء الاصطناعي في مصر", used);
    const second = name("تغريدات عن الذكاء الاصطناعي في مصر", used);
    expect(first).toBe("تغريدات عن الذكاء الاصطناعي");
    expect(second).toBe("تغريدات عن الذكاء الاصطناعي ٢");
    expect([...second].length).toBeLessThanOrEqual(31);
  });

  it("the sheet name is used for nothing that is read back: the settlement count reads the sheets by position, the links use the names of the same build, and only the sheet-name function changed", () => {
    const finalize = src("agent/src/finalize.ts");
    expect(finalize).toContain("wb.worksheets.slice(1)");
    expect(finalize).not.toMatch(/getWorksheet|\.name\b/);
    const workbook = src("agent/src/workbook.ts");
    // the names are produced once, kept in a map, and read from that same map for the hyperlinks and the summary
    expect(workbook.match(/wordBoundarySheetName\(/g)).toHaveLength(1);
    expect(workbook).toContain("sheetNameOf.set(lay.stage.key, wordBoundarySheetName(");
  });
});
