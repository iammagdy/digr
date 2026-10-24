import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { createAdminClient } from "@/lib/supabase/server";
import { getProviderBalanceStatus } from "@/functions/shared/providerSpend";
import { readRealProviderBalance } from "@/lib/server/realProviderBalance";
import { getCachedConference, setCachedConference } from "@/lib/server/conferenceCache";
import { buildConferenceSnapshot, cairoStartOf, MINUTE_MS, MODEL_MAX_PAGES, MODEL_PAGE_SIZE, parseMonthlyBudgetUsd, TOP_SPENDERS_LIMIT, WINDOW_MINUTES, withoutTestAccounts, type ConferenceInput } from "@/lib/server/conferenceDashboard";
import { hidesTestAccounts, testAccountIds } from "@/lib/server/adminTestAccounts";

export const dynamic = "force-dynamic";

const SIGNUP_ROWS = 2000;
const MESSAGE_ROWS = 5000;
const JOB_ROWS = 500;
const LEDGER_ROWS = 5000;
const TOPUP_ROWS = 1000;
const UNSERVED_ROWS = 500;
const PROFILE_PAGE = 1000;
const PROFILE_MAX_ROWS = 20000;

/** The raw reads, before the test-account toggle is applied (so the toggle needs no new read). */
interface ConferenceRaw { input: ConferenceInput; testIds: Set<string> }

/** One read answer; an error answer is a failed read. */
function ok<T>(result: { data: T | null; error: unknown; count?: number | null }): { data: T; count: number | null } {
  if (result.error) throw new Error("read failed");
  return { data: (result.data ?? []) as T, count: result.count ?? null };
}

async function collect(admin: ReturnType<typeof createAdminClient>, now: number): Promise<ConferenceRaw> {
  const notes: string[] = [];
  /** A failing read (an error answer or a throw) turns that section into null with a plain note; the others carry on. */
  const safe = async <T,>(noteAr: string, read: () => Promise<T>): Promise<T | null> => {
    try { return await read(); } catch { notes.push(noteAr); return null; }
  };
  const iso = (at: number) => new Date(at).toISOString();
  const since10 = iso(now - WINDOW_MINUTES * MINUTE_MS);
  const since24h = iso(now - 24 * 60 * MINUTE_MS);
  const dayStart = iso(cairoStartOf(now, "day"));
  const monthStart = iso(cairoStartOf(now, "month"));
  const db: any = admin;

  const [signups, messages, jobs, provider, ledger, modelUsage, topups, unserved, profileRows] = await Promise.all([
    safe("تعذّر قراءة التسجيلات الآن.", async () => {
      const { data, count } = ok<any[]>(await db.from("profiles").select("id, created_at", { count: "exact" }).gte("created_at", since24h).order("created_at", { ascending: false }).limit(SIGNUP_ROWS));
      return { rows: data, total24h: count };
    }),
    safe("تعذّر قراءة نشاط المحادثات الآن.", async () =>
      ok<any[]>(await db.from("messages").select("user_id, role, created_at").eq("role", "user").gte("created_at", since10).order("created_at", { ascending: false }).limit(MESSAGE_ROWS)).data),
    safe("تعذّر قراءة الطلبات الجارية الآن.", async () =>
      ok<any[]>(await db.from("jobs").select("id, user_id, status, lease_until, updated_at, created_at, reserved_credits, delivered_units, error_message").in("status", ["queued", "running"]).order("updated_at", { ascending: false }).limit(JOB_ROWS)).data),
    safe("تعذّر قراءة حالة المزود الآن.", async () => {
      const [real, status] = await Promise.all([
        readRealProviderBalance(admin),
        getProviderBalanceStatus(admin as any)
          .then((s) => ({ todaySpendUsd: s.todaySpendUsd, todayCapUsd: s.todayCapUsd, availableBalanceUsd: s.availableBalanceUsd }))
          .catch(() => { notes.push("تعذّر قراءة إنفاق المزود اليوم."); return null; }),
      ]);
      return { real, status };
    }),
    safe("تعذّر قراءة أكثر المستخدمين استهلاكًا الآن.", async () => {
      const { data } = ok<any[]>(await db.from("credit_ledger").select("user_id, delta, type").eq("type", "charge").lt("delta", 0).gte("created_at", dayStart).order("created_at", { ascending: false }).limit(LEDGER_ROWS));
      // The names are a convenience: when they cannot be read the list still shows the short ids.
      const totals = new Map<string, number>();
      for (const row of data) if (row.user_id) totals.set(row.user_id, (totals.get(row.user_id) ?? 0) - Number(row.delta || 0));
      const ids = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_SPENDERS_LIMIT).map(([id]) => id);
      let profiles: any[] = [];
      if (ids.length) {
        try { profiles = ok<any[]>(await db.from("profiles").select("id, email, sender_name").in("id", ids).limit(TOP_SPENDERS_LIMIT)).data; } catch { profiles = []; }
      }
      return { rows: data, truncated: data.length >= LEDGER_ROWS, profiles };
    }),
    safe("تعذّر قراءة إنفاق النموذج الآن.", async () => {
      const rows: any[] = [];
      let truncated = false;
      for (let page = 0; page < MODEL_MAX_PAGES; page += 1) {
        const from = page * MODEL_PAGE_SIZE;
        const { data } = ok<any[]>(await db.from("llm_usage").select("cost_usd, created_at").gte("created_at", monthStart).order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, from + MODEL_PAGE_SIZE - 1));
        rows.push(...data);
        if (data.length < MODEL_PAGE_SIZE) break;
        if (page === MODEL_MAX_PAGES - 1) truncated = true;
      }
      return { rows, truncated };
    }),
    safe("تعذّر قراءة طلبات الشحن المعلقة الآن.", async () => {
      const { data, count } = ok<any[]>(await db.from("topups").select("amount_egp, user_id", { count: "exact" }).eq("status", "pending").limit(TOPUP_ROWS));
      return { rows: data, count };
    }),
    safe("تعذّر قراءة الطلبات غير المخدومة الآن.", async () =>
      ok<any[]>(await db.from("capability_requests").select("id, user_id, query, created_at").gte("created_at", since24h).order("created_at", { ascending: false }).limit(UNSERVED_ROWS)).data),
    // The test accounts are found by e-mail (id and e-mail only), a page at a time.
    safe("تعذّر قراءة حسابات الاختبار الآن؛ قد تظهر في الأرقام.", async () => {
      const rows: any[] = [];
      for (let from = 0; from < PROFILE_MAX_ROWS; from += PROFILE_PAGE) {
        const { data } = ok<any[]>(await db.from("profiles").select("id, email").range(from, from + PROFILE_PAGE - 1));
        rows.push(...data);
        if (data.length < PROFILE_PAGE) break;
      }
      return rows;
    }),
  ]);

  const input: ConferenceInput = { now, signups, messages, jobs, provider, ledger, modelUsage, monthlyBudgetUsd: parseMonthlyBudgetUsd(process.env.MODEL_MONTHLY_BUDGET_USD), topups, unserved, notes };
  return { input, testIds: testAccountIds(profileRows ?? []) };
}

/** Admin only, read only: the conference dashboard. SELECT only; no write, no model call, no paid provider call. */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const now = Date.now();
  let current = getCachedConference<ConferenceRaw>(now);
  if (!current) {
    current = collect(createAdminClient(), now);
    setCachedConference(now, current);
  }
  const hideTest = hidesTestAccounts(req.nextUrl?.searchParams.get("hideTest"));
  try {
    const raw = await current;
    return NextResponse.json(buildConferenceSnapshot(hideTest ? withoutTestAccounts(raw.input, raw.testIds) : raw.input));
  } catch {
    return NextResponse.json({ error: "تعذّر تحميل لوحة المؤتمر الآن." }, { status: 500 });
  }
}
