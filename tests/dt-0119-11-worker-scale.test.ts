import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createFakeDriver, type FakeStep } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runExecution, runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { createMemoryDb } from "./helpers/memoryDb";
import { agentChatTurn } from "../src/lib/agentMission/chatTurn";
import { approveForCustomer, loadCustomerMission } from "../src/lib/agentMission/customerActions";
import { AGENT_JOB_POINTS_CAP } from "../src/lib/agentMission/constants";
import { settlementCharge } from "../src/lib/agentMission/price";
import { INTERNAL_PLANNING_AR } from "../src/lib/agentMission/refusal";
import { storedBriefOf } from "../src/lib/agentMission/researchBrief";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import type { TregCallOptions, TregCallResult } from "../src/functions/shared/tregClient";
import { ccolumns, columnsOf, linkedinOf, why } from "./helpers/a1World";
import { callIds, type Results } from "./helpers/agentFakeWorld";
import { firstOutputId } from "./helpers/agentRelevance";
import { fakeRecorder, NOT_ADMIN, USER_ID, tregResult } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { assertReplayInvariants, readWorkbook, replay, replayClient, REPLAY_USER } from "./helpers/agentReplay";

/**
 * DT-20261119-11 Gate 2 F6 (D-0140): offline end-to-end fake company + manager + contact worker replay
 * at 50, 100, and 200 companies x 1 and x 2 managers, with email and email+phone.
 * Zero real network calls, zero spend, source files untouched.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

const catalog = loadTregCatalog();
const COMPANIES = "tomba.companies.search.reveal";
const PEOPLE = "blitzapi.people.waterfall-icp";

const TOTAL_COMPANIES_POOL = 200;
const PER_PAGE = 50;

function slugOf(index: number): string {
  return `scale-co-${String(index).padStart(3, "0")}`;
}

function makeCompany(index: number) {
  const slug = slugOf(index);
  return {
    id: linkedinOf(slug),
    name: `Electromechanical Co ${index}`,
    website_url: `${slug}.com.eg`,
    linkedin_url: linkedinOf(slug),
    country: "EG",
    city: "Cairo",
    industry: "Electrical Equipment Manufacturing",
    company_size: "51-200",
    description: "Electromechanical works and contracting in Egypt",
  };
}

const FIRST_NAMES = ["Karim", "Mona", "Ahmed", "Salma", "Hossam", "Nadia", "Tarek", "Laila", "Omar", "Heba"];
const LAST_NAMES = ["Mansour", "Ibrahim", "Nassar", "Farouk", "Adel", "Kamal", "Zaki", "Rashed", "Fathy", "Samy", "Gamal", "Nabil", "Shafik", "Lotfy", "Kamel", "Aziz", "Helmy", "Hanna", "Barakat", "Salem"];

function makePeopleForCompany(companyIdx: number, slug: string, maxResults: number) {
  const titles = ["Chief Executive Officer", "Managing Director", "Operations Director", "Engineering Manager"];
  const n = Math.min(Math.max(1, maxResults), titles.length);
  return {
    results: Array.from({ length: n }, (_, i) => {
      const first = FIRST_NAMES[(companyIdx * 3 + i) % FIRST_NAMES.length];
      const last = LAST_NAMES[(companyIdx * 7 + i * 2) % LAST_NAMES.length];
      return {
        person: {
          full_name: `${first} ${last}`,
          linkedin_url: `https://www.linkedin.example/in/${slug}-${i + 1}`,
          experiences: [{ job_title: titles[i], company_name: `Electromechanical Co ${companyIdx}` }],
        },
      };
    }),
  };
}

function realCallCostUsd(o: TregCallOptions): number {
  const ep = catalog.byId.get(o.endpointId);
  if (o.endpointId === COMPANIES) return 0.0005;
  if (o.endpointId === PEOPLE) {
    const count = Math.min(Math.max(1, Number((o.params as { max_results?: number })?.max_results ?? 2)), 100);
    return 0.001 * count;
  }
  return typeof ep?.cost?.usd === "number" && ep.cost.usd > 0 ? ep.cost.usd : 0.0005;
}

function fakeProvider(options: { contacts: "email" | "email+phone"; enforceRouteMaxCost?: boolean }): (o: TregCallOptions) => TregCallResult {
  let phoneSeq = 0;
  return (o: TregCallOptions): TregCallResult => {
    const real = realCallCostUsd(o);
    if (options.enforceRouteMaxCost !== false && !(Number(o.routeMaxCostUsd) >= real - 1e-12)) {
      return {
        ok: false,
        httpStatus: 402,
        tregCallId: "",
        costMicro: 0,
        latencyMs: 1,
        data: null,
        error: "route_max_cost",
        isRouteMaxCost: true,
        isPlatformBalanceLow: false,
      };
    }

    if (o.endpointId === COMPANIES) {
      const page = Math.max(1, Number((o.params as { page?: number })?.page ?? 1));
      const start = (page - 1) * PER_PAGE;
      if (start >= TOTAL_COMPANIES_POOL) return tregResult({ data: { companies: [] } }, real);
      const end = Math.min(TOTAL_COMPANIES_POOL, start + PER_PAGE);
      const companies = Array.from({ length: end - start }, (_, i) => makeCompany(start + i + 1));
      return tregResult({ data: { companies } }, real);
    }

    if (o.endpointId === PEOPLE) {
      const body = JSON.stringify(o.params ?? {});
      const m = /scale-co-(\d{3})/.exec(body);
      const idx = m ? Number(m[1]) : 1;
      const slug = `scale-co-${String(idx).padStart(3, "0")}`;
      const maxResults = Number((o.params as { max_results?: number })?.max_results ?? 2);
      return tregResult(makePeopleForCompany(idx, slug, maxResults), real);
    }

    const cap = catalog.byId.get(o.endpointId)?.capability ?? "";
    const who = JSON.stringify(o.params ?? {});
    const slugMatch = /scale-co-(\d{3})/.exec(who);
    const slug = slugMatch ? `scale-co-${slugMatch[1]}` : "scale-co-001";

    if (cap === "people.email.find" || cap === "people.email.find.personal") {
      return tregResult({ found: true, email: `lead.${slug}.${Math.abs([...who].reduce((a, c) => a + c.charCodeAt(0), 0)) % 997}@${slug}.com.eg` }, real);
    }
    if (cap === "people.email.verify") {
      return tregResult({ status: "safe", deliverable: true, is_catch_all: false }, real);
    }
    if (cap === "company.email.search" || cap === "email.domain.search") {
      return tregResult({ data: { emails: [{ value: `info@${slug}.com.eg`, type: "generic", verification: { status: "valid" } }] } }, real);
    }
    if (cap === "people.phone.find" || cap === "people.phone.find.personal") {
      if (options.contacts === "email") return tregResult({ found: false }, 0);
      phoneSeq += 1;
      return tregResult({ found: true, phone: `+2010${String(10_000_000 + phoneSeq).slice(-8)}` }, real);
    }
    if (cap === "people.phone.verify") {
      return tregResult({ is_valid: true, line_type: "mobile", country_code: "EG" }, real);
    }
    return tregResult({}, real);
  };
}

function buildRequest(companies: number, perCompany: number, contacts: "email" | "email+phone"): string {
  const role = perCompany === 1 ? "ومن كل شركة ١ مدير" : "ومن كل شركة ٢ مديرين";
  const fields = contacts === "email" ? "الاسم، المسمى الوظيفي، والإيميل" : "الاسم، المسمى الوظيفي، الإيميل، ورقم التليفون";
  return `عايز ${companies} شركة مصرية في قطاع الكهروميكانيكا، ${role}: ${fields}`;
}

function pcolumnsFor(contacts: "email" | "email+phone") {
  const base: Array<[string, string, string?]> = [
    ["full_name", "الاسم"],
    ["job_title", "المسمى الوظيفي"],
    ["company", "الشركة"],
    ["linkedin", "الملف المهني للشخص"],
    ["email", "الإيميل", "work_email"],
  ];
  if (contacts === "email+phone") base.push(["phone", "رقم التليفون", "phone"]);
  return columnsOf(...base);
}

function planSteps(companies: number, perCompany: number, contacts: "email" | "email+phone"): FakeStep[] {
  // Planning sample size is fixed across 50/100/200 (1 company page + 1 people sample capped at 2)
  const samplePeopleCount = Math.min(2, perCompany);
  const rolePhrase = perCompany === 1 ? "مديرًا واحدًا من كل شركة" : "مديرين من كل شركة";
  return [
    { tool: "report_progress", args: { message_ar: "أجهز خطة الشركات والمسؤولين", counts: { sources: 2 } } },
    { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
    { tool: "describe_endpoint", args: { id: COMPANIES } },
    { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "electromechanical", page: 1 }, why } },
    {
      tool: "run_code",
      args: (r: Results) => ({
        code: `return inputs.${callIds(r)[0]}.data.companies.map(r => ({ id: r.linkedin_url, name: r.name, industry: r.industry || '', city: r.city || '', website: r.website_url || '', linkedin: r.linkedin_url || '' }))`,
        files: [callIds(r)[0]],
      }),
    },
    { tool: "describe_endpoint", args: { id: PEOPLE } },
    {
      tool: "treg_call",
      args: {
        endpoint_id: PEOPLE,
        params: {
          company_linkedin_url: linkedinOf(slugOf(1)),
          cascade: [{ include_title: ["Chief Executive Officer", "Managing Director", "Operations Director"] }],
          max_results: samplePeopleCount,
        },
        why,
      },
    },
    {
      tool: "run_code",
      args: (r: Results) => ({
        code: `return inputs.${callIds(r)[1]}.results.map(r => { const p = r.person || {}; const exp = (p.experiences && p.experiences[0]) || {}; return { id: p.linkedin_url, full_name: p.full_name, job_title: exp.job_title || '', company: exp.company_name || '', linkedin: p.linkedin_url, email: ''${contacts === "email+phone" ? ", phone: ''" : ""} }; })`,
        files: [callIds(r)[1]],
      }),
    },
    {
      tool: "propose_plan",
      args: (res: Results) => ({
        summary_ar: `ستحصل على الشركات المصرية في الكهروميكانيكا، ومع كل شركة ${rolePhrase} بالبيانات المطلوبة.`,
        assumptions_ar: ["صناع القرار: المدير التنفيذي والعضو المنتدب أولًا."],
        stages: [
          {
            key: "companies",
            title_ar: "شركات الكهروميكانيكا في مصر",
            endpoint_id: COMPANIES,
            expected_rows: companies,
            parent_key: null,
            deliver: true,
            columns: ccolumns,
            sample_rows: [
              {
                id: linkedinOf(slugOf(1)),
                name: "Electromechanical Co 1",
                industry: "Electrical Equipment Manufacturing",
                city: "Cairo",
                website: `${slugOf(1)}.com.eg`,
                linkedin: linkedinOf(slugOf(1)),
              },
            ],
            measured_by: [callIds(res)[0], firstOutputId(res)],
          },
          {
            key: "people",
            title_ar: "مديرو كل شركة",
            endpoint_id: PEOPLE,
            expected_rows: companies * perCompany,
            parent_key: "companies",
            per_parent_rows: perCompany,
            deliver: true,
            columns: pcolumnsFor(contacts),
            sample_rows: [
              {
                id: `https://www.linkedin.example/in/${slugOf(1)}-1`,
                full_name: "Mona Nassar",
                job_title: "Chief Executive Officer",
                company: "Electromechanical Co 1",
                linkedin: `https://www.linkedin.example/in/${slugOf(1)}-1`,
                email: "",
                ...(contacts === "email+phone" ? { phone: "" } : {}),
              },
            ],
            measured_by: [callIds(res)[1]],
          },
        ],
      }),
    },
    {
      tool: "ask_question",
      args: {
        question_ar: "هذا العدد يتجاوز الحد الأقصى للنقاط في طلب واحد؛ كم شركة تفضّل أن نبدأ بها؟",
        options_ar: ["٥٠ شركة", "١٠٠ شركة"],
      },
    },
  ];
}

function readRssMb(): number {
  const raw = process.memoryUsage().rss;
  try {
    const status = readFileSync("/proc/self/status", "utf8");
    const m = /VmHWM:\s+(\d+)\s+kB/.exec(status);
    if (m) return Math.round((Number(m[1]) / 1024) * 10) / 10;
  } catch { /* fallback to process rss */ }
  return Math.round((raw / (1024 * 1024)) * 10) / 10;
}

const MATRIX: Array<{ companies: number; perCompany: number; contacts: "email" | "email+phone" }> = [];
for (const companies of [50, 100, 200]) {
  for (const perCompany of [1, 2]) {
    for (const contacts of ["email", "email+phone"] as const) {
      MATRIX.push({ companies, perCompany, contacts });
    }
  }
}

describe("DT-20261119-11 F6 (D-0140): offline company + people + contact worker scale replay", () => {
  const planningStats = new Map<string, { sampleRows: number; planningSpendUsd: number; planningCalls: number }>();
  const rssReport: string[] = [];

  it.each(MATRIX)(
    "$companies companies x $perCompany manager(s) ($contacts): plan card or ONE question, invariant planning sample/spend, full delivery, clean ledger & recorder holds",
    async ({ companies, perCompany, contacts }) => {
      const request = buildRequest(companies, perCompany, contacts);
      const dispatcher = fakeProvider({ contacts });
      const answers = Array.from({ length: 2200 }, () => dispatcher);
      const bigRec = fakeRecorder({ dailyCapUsd: 100 });

      const db = createMemoryDb();
      const money = fakeMoneyClient({ balance: 100_000 });
      const initialBalance = money.balance();
      const store = createMemoryStore();
      const { client } = replayClient(db, money);

      let eventSeq = 0;
      const addEvent = store.addEvent.bind(store);
      store.addEvent = async (missionId, event) => {
        await addEvent(missionId, event);
        const stored = store.events[store.events.length - 1];
        db.rows("mission_events").push({
          id: (eventSeq += 1),
          mission_id: missionId,
          kind: stored.kind,
          message_ar: stored.message_ar,
          counts: stored.counts ?? {},
          created_at: new Date(Date.now() + eventSeq).toISOString(),
        });
      };
      const addCall = store.addCall.bind(store);
      store.addCall = async (row) => {
        await addCall(row);
        db.rows("mission_calls").push({ ...row });
      };
      db.seed("agent_worker_heartbeat", [{ worker_id: "w_scale", beat_at: new Date().toISOString() }]);
      db.seed("conversations", [{ id: "conv1", user_id: REPLAY_USER, title: "محادثة جديدة" }]);
      db.seed("messages", [
        { id: "u1", conversation_id: "conv1", role: "user", user_id: REPLAY_USER },
        { id: "a1", conversation_id: "conv1", role: "assistant", user_id: REPLAY_USER },
      ]);

      const turn = await agentChatTurn({
        sb: client,
        userId: REPLAY_USER,
        conversationId: "conv1",
        userMsgId: "u1",
        assistantMsgId: "a1",
        message: request,
        conversationTitle: "محادثة جديدة",
      });
      expect(turn.ok).toBe(true);
      const missionId = (turn as { missionId: string }).missionId;
      const row = db.rows("missions").find((m) => m.id === missionId)!;
      Object.assign(
        row,
        { created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        Object.fromEntries(Object.entries(newMission({ id: missionId, user_id: REPLAY_USER })).filter(([k]) => row[k] === undefined)),
      );
      store.missions.set(missionId, row as any);

      const queue = [...answers];
      const call = vi.fn(async (o: TregCallOptions) => {
        const next = queue.shift();
        if (!next) throw new Error(`no fake provider answer left for ${o.endpointId}`);
        return next(o);
      });
      const notices: Array<{ kind: string; facts: any; jobId: string | null }> = [];
      const baseDeps = (driver: ReturnType<typeof createFakeDriver>): RunnerDeps => ({
        store,
        client,
        catalog,
        driver,
        recorder: bigRec.recorder,
        commit: bigRec.commit,
        call: call as any,
        models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" },
        resolveAccess: async () => NOT_ADMIN,
        notify: async (n) => { notices.push({ kind: n.kind, facts: n.facts, jobId: n.jobId }); },
        readMissionBrief: async (mId, uId) =>
          storedBriefOf(db.rows("messages").filter((m: any) => m.role === "assistant" && m.user_id === uId && m.plan?.agentMissionId === mId).pop()?.plan ?? null),
      });

      const claimedPlan = await store.claimMission("w_scale", 120);
      expect(claimedPlan?.id).toBe(missionId);
      const planningDriver = createFakeDriver(planSteps(companies, perCompany, contacts));
      await runPlanning(baseDeps(planningDriver), store.missions.get(missionId)!);

      const planned = store.missions.get(missionId)!;
      // (a) Never ends in INTERNAL_PLANNING_AR; ends in plan card or ONE question
      expect(planned.summary_ar ?? "").not.toBe(INTERNAL_PLANNING_AR);
      expect(["plan_ready", "needs_input"]).toContain(planned.status);

      // (b) Check planning sample size and planning spend invariance across 50/100/200
      const planCalls = (await store.listCalls(missionId)).filter((c) => c.phase === "planning" && c.status === "ok");
      expect(planCalls.length).toBe(2);
      const sampleRows = planCalls.reduce((n, c) => n + Number(c.rows_returned ?? 0), 0);
      expect(sampleRows).toBeGreaterThan(0);
      const planningSpendUsd = Number(planCalls.reduce((n, c) => n + Number(c.cost_usd ?? 0), 0).toFixed(6));
      expect(planningSpendUsd).toBeGreaterThan(0);
      const shapeKey = `${perCompany}:${contacts}`;
      if (companies === 50) {
        planningStats.set(shapeKey, { sampleRows, planningSpendUsd, planningCalls: planCalls.length });
      } else {
        const baseline = planningStats.get(shapeKey);
        if (baseline) {
          expect(planCalls.length).toBe(baseline.planningCalls);
          expect(sampleRows).toBe(baseline.sampleRows);
          expect(planningSpendUsd).toBe(baseline.planningSpendUsd);
        }
      }

      if (planned.status === "needs_input") {
        expect(typeof planned.question_ar).toBe("string");
        expect(bigRec.rows.every((r) => r.committedUsd !== null)).toBe(true);
        expect(money.ledger.filter((l) => l.type === "reserve")).toHaveLength(0);
        rssReport.push(`${companies}x${perCompany} (${contacts}): needs_input | peakRssMb=${readRssMb()}`);
        return;
      }

      expect(planned.plan).toBeTruthy();
      expect((planned.plan as any).price.reservePoints).toBeLessThanOrEqual(AGENT_JOB_POINTS_CAP);

      const planLoad = await loadCustomerMission(client, { id: missionId, userId: REPLAY_USER });
      expect(planLoad.ok).toBe(true);
      if (!planLoad.ok) throw new Error(planLoad.error);
      const approved = await approveForCustomer(client, { id: missionId, userId: REPLAY_USER, isGuest: false, emailVerified: true, approvalVersion: planLoad.view.approvalVersion });
      expect(approved.ok).toBe(true);

      const claimedExec = await store.claimMission("w_scale", 120);
      expect(claimedExec?.status).toBe("executing");
      const execDriver = createFakeDriver([], { costUsd: 0.004 });
      await runExecution(baseDeps(execDriver), store.missions.get(missionId)!);

      const mission = store.missions.get(missionId)!;
      const finalLoad = await loadCustomerMission(client, { id: missionId, userId: REPLAY_USER });
      expect(finalLoad.ok).toBe(true);

      const fakeResult = {
        db,
        store,
        money,
        rec: bigRec,
        call,
        web: undefined,
        missionId,
        mission,
        plannedPlan: planned.plan!,
        planView: (planLoad as any).view,
        finalView: (finalLoad as any).view,
        notices: notices as any,
        planningDriver,
        executionDriver: execDriver,
        initialBalance,
        customerAnswers: [planLoad, finalLoad],
      };

      const expectedDelivered = companies * (1 + perCompany);
      // (c) Full company + people + contact delivery
      assertReplayInvariants(fakeResult as any, { expectDelivered: expectedDelivered, expectStatus: "completed" });

      const wb = await readWorkbook(fakeResult as any);
      const companySheet = wb.worksheets[1];
      const peopleSheet = wb.worksheets[2];
      expect(companySheet.rowCount - 1).toBe(companies);
      expect(peopleSheet.rowCount - 1).toBe(companies * perCompany);

      const pHeader = (peopleSheet.getRow(1).values as unknown[]).map((v) => String(v ?? "").trim());
      const emailIdx = pHeader.findIndex((h) => /إيميل/.test(h));
      expect(emailIdx).toBeGreaterThan(0);
      for (let r = 2; r <= peopleSheet.rowCount; r += 1) {
        const emailVal = String(peopleSheet.getRow(r).getCell(emailIdx).value ?? "").trim();
        expect(emailVal).toMatch(/@/);
        if (contacts === "email+phone") {
          const phoneIdx = pHeader.findIndex((h) => /هاتف|تليفون/.test(h));
          expect(phoneIdx).toBeGreaterThan(0);
          const phoneVal = String(peopleSheet.getRow(r).getCell(phoneIdx).value ?? "").trim();
          expect(phoneVal).toMatch(/^\+2010/);
        }
      }

      // (e) Every reservation settled or released once, no outstanding holds
      expect(bigRec.rows.every((r) => r.committedUsd !== null)).toBe(true);
      expect(money.ledger.filter((l) => l.type === "reserve")).toHaveLength(1);
      expect(money.ledger.filter((l) => l.type === "release")).toHaveLength(1);
      expect(money.balance()).toBe(initialBalance - Number(mission.charged_points));

      const rssMb = readRssMb();
      rssReport.push(`${companies}x${perCompany} (${contacts}): delivered=${mission.delivered_units} | charged=${mission.charged_points} | peakRssMb=${rssMb}`);
    },
    180_000,
  );

  it("(d) & (e) mid-run provider daily limit at scale (100 companies x 1 manager with email): partial delivery charged ONLY for delivered rows, rest of hold released, zero pending holds", async () => {
    const companies = 100;
    const perCompany = 1;
    const contacts = "email";
    const dispatcher = fakeProvider({ contacts });
    // Planning spends ~$0.0025; allow enough for companies + ~35 people calls then hit daily_cap mid-execution
    const cappedRec = fakeRecorder({ dailyCapUsd: 0.06 });

    const r = await replay({
      request: buildRequest(companies, perCompany, contacts),
      planning: planSteps(companies, perCompany, contacts),
      execution: () => [],
      answers: Array.from({ length: 1200 }, () => dispatcher),
      deps: (base) => ({ ...base, recorder: cappedRec.recorder, commit: cappedRec.commit }),
    });

    const m: any = r.mission;
    expect(m.status).toBe("completed");
    expect(Number(m.delivered_units)).toBeGreaterThan(0);
    expect(Number(m.delivered_units)).toBeLessThan(companies * (1 + perCompany));

    const chunk = [...r.money.calls].reverse().find((c) => c.name === "complete_chunk");
    const billable = chunk ? Number((chunk.args as Record<string, unknown>).p_new_delivered_units) : Number(m.delivered_units);
    expect(billable).toBeGreaterThan(0);
    expect(billable).toBeLessThanOrEqual(Number(m.delivered_units));
    expect(m.charged_points).toBeGreaterThan(0);
    expect(m.charged_points).toBeLessThanOrEqual(
      settlementCharge({
        deliveredUnits: billable,
        unitPricePoints: Number(m.unit_price_points),
        reservedPoints: Number(m.reserved_points),
      }).chargedPoints,
    );
    expect(m.charged_points).toBeLessThan(m.reserved_points);
    expect(r.money.ledger.filter((l) => l.type === "reserve")).toHaveLength(1);
    expect(r.money.ledger.filter((l) => l.type === "release")).toHaveLength(1);
    expect(r.money.ledger.find((l) => l.type === "release")!.delta).toBe(m.reserved_points);
    expect(r.money.ledger.find((l) => l.type === "charge")!.delta).toBe(-m.charged_points);
    expect(r.money.balance()).toBe(r.initialBalance - m.charged_points);

    // Every provider reservation row is committed/released; nothing stays pending
    expect(cappedRec.rows.every((row) => row.committedUsd !== null)).toBe(true);
    expect(cappedRec.rows.reduce((sum, row) => sum + (row.committedUsd ?? row.reservedUsd), 0)).toBeLessThanOrEqual(0.06 + 1e-9);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0].kind).toBe("partial");
    rssReport.push(`100x1 (email daily_cap mid-run): delivered=${m.delivered_units} | charged=${m.charged_points} | peakRssMb=${readRssMb()}`);
  }, 180_000);

  it("(f) prints peak RSS per case summary", () => {
    console.info("DT-20261119-11 F6 scale RSS report:\n" + rssReport.join("\n"));
    expect(rssReport.length).toBeGreaterThanOrEqual(12);
  });
});
