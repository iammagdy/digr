/**
 * The conference dashboard snapshot: how fast people are signing up, who is chatting, the job queue, the provider's real balance and
 * daily allowance, the biggest spenders of today, the model spend against its monthly budget, pending top-ups and what customers asked
 * for that the platform does not sell. Pure functions over rows the admin route reads (SELECT only): no I/O, no write, no provider call.
 */
import { formatAr } from "../arabicDigits";
import { classifyJob, QUEUE_BACKLOG_ALERT, QUEUED_STUCK_AFTER_MS, type AlertLine, type JobRowLite } from "./adminOperations";
import { summarizeUnserved, type UnservedRow } from "./unservedRequests";

/** Documented default alert thresholds. The page shows them in its «حدود التنبيه» block. */
export const SIGNUPS_PER_MINUTE_WARN = 40; // warn when the last minute has MORE than this many signups
export const QUEUED_JOBS_WARN = QUEUE_BACKLOG_ALERT; // warn at this many queued jobs or more
export const PROVIDER_CAP_WARN_PERCENT = 80; // warn at this share of the provider's daily cap or more; bad when the cap is reached
export const REAL_BALANCE_WARN_USD = 0.15; // warn when the real provider balance is BELOW this
export const REAL_BALANCE_BAD_USD = 0.05; // bad when the real provider balance is BELOW this
export const PENDING_TOPUPS_WARN = 5; // warn at this many pending top-ups or more
export const MODEL_BUDGET_WARN_PERCENT = 80; // warn at this share of MODEL_MONTHLY_BUDGET_USD or more
export const MODEL_BUDGET_BAD_PERCENT = 100; // bad at this share or more

export const CONFERENCE_THRESHOLDS = {
  signupsPerMinuteWarn: SIGNUPS_PER_MINUTE_WARN,
  queuedJobsWarn: QUEUED_JOBS_WARN,
  providerCapWarnPercent: PROVIDER_CAP_WARN_PERCENT,
  realBalanceWarnUsd: REAL_BALANCE_WARN_USD,
  realBalanceBadUsd: REAL_BALANCE_BAD_USD,
  pendingTopupsWarn: PENDING_TOPUPS_WARN,
  modelBudgetWarnPercent: MODEL_BUDGET_WARN_PERCENT,
  modelBudgetBadPercent: MODEL_BUDGET_BAD_PERCENT,
} as const;

export const MINUTE_MS = 60_000;
export const WINDOW_MINUTES = 10;
export const TOP_SPENDERS_LIMIT = 10;
export const UNSERVED_TOP_LIMIT = 5;
export const MODEL_PAGE_SIZE = 1000;
export const MODEL_MAX_PAGES = 30;

export const REAL_BALANCE_MISSING_AR = "الرصيد الحقيقي غير متاح الآن";
export const REAL_BALANCE_ESTIMATE_LABEL_AR = "تقدير: الرصيد المضبوط ناقص الإنفاق المسجَّل، وليس الرصيد الحقيقي";
export const NO_MODEL_BUDGET_AR = "لم تُضبط ميزانية النموذج الشهرية";

const TIME_ZONE = "Africa/Cairo";
const fmt = (value: number, digits?: number) => formatAr(digits === undefined ? Math.round(value) : value, digits);
const ms = (value: string | null | undefined) => (value ? new Date(value).getTime() : Number.NaN);

/** Cairo's offset from UTC at an instant, in ms (Egypt observes daylight saving). */
function cairoOffsetMs(at: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** 00:00 Africa/Cairo of the day (or of the first day of the month) that contains `now`, as epoch ms. */
export function cairoStartOf(now: number, unit: "day" | "month"): number {
  const local = new Date(now + cairoOffsetMs(now));
  const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), unit === "month" ? 1 : local.getUTCDate());
  let guess = wall - cairoOffsetMs(now);
  guess = wall - cairoOffsetMs(guess);
  return guess;
}

export interface ConferenceInput {
  now: number;
  /** Newest signups first is not required; `total24h` is the exact count when the read gave one. */
  signups: { rows: Array<{ id?: string | null; created_at: string | null }>; total24h?: number | null } | null;
  messages: Array<{ user_id: string | null; role?: string | null; created_at: string | null }> | null;
  jobs: Array<JobRowLite & { user_id?: string | null }> | null;
  provider: {
    real: { usd: number; at: number; source: "live" | "last_reading" } | null;
    status: { todaySpendUsd: number; todayCapUsd: number; availableBalanceUsd: number } | null;
  } | null;
  ledger: { rows: Array<{ user_id: string | null; delta: number | string | null; type?: string | null }>; truncated: boolean; profiles: Array<{ id: string; email?: string | null; sender_name?: string | null }> } | null;
  modelUsage: { rows: Array<{ cost_usd: number | string | null; created_at: string | null }>; truncated: boolean } | null;
  monthlyBudgetUsd: number | null;
  topups: { rows: Array<{ amount_egp: number | string | null; user_id?: string | null }>; count?: number | null } | null;
  unserved: UnservedRow[] | null;
  notes?: string[];
}

export interface ConferenceSnapshot {
  checkedAt: string;
  signups: { perMinute: number[]; lastMinute: number; perMinuteAvg10: number; total24h: number } | null;
  activeChats: { users: number; messagesLastMinute: number } | null;
  jobs: { running: number; queued: number; stalled: number } | null;
  /** The jobs behind the counts above and the «عالقة في الانتظار» count: id, and minutes idle (running, stalled) or waiting (queued). */
  jobList: { running: JobListItem[]; queued: JobListItem[]; queuedStuck: JobListItem[]; stalled: JobListItem[] } | null;
  provider: {
    real: { usd: number; ageSeconds: number; source: "live" | "last_reading" } | null;
    realLabelAr: string;
    estimate: { usd: number; labelAr: string } | null;
    spend: { todaySpendUsd: number; todayCapUsd: number; percentOfCap: number; level: "ok" | "warn" | "reached" } | null;
  } | null;
  topSpenders: { rows: Array<{ shortId: string; name: string | null; email: string | null; points: number }>; truncated: boolean } | null;
  modelSpend: { todayUsd: number; monthUsd: number; truncated: boolean; budget: { monthlyUsd: number | null; percentUsed: number | null; noteAr: string } } | null;
  pendingTopups: { count: number; totalEgp: number } | null;
  unserved: { total: number; families: Array<{ family: string; titleAr: string; count: number }> } | null;
  alerts: AlertLine[];
  notes: string[];
  thresholds: typeof CONFERENCE_THRESHOLDS;
}

/** The monthly budget from the environment: only a positive finite number counts; anything else means "no budget set". */
export function parseMonthlyBudgetUsd(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Signups per minute for the last 10 minutes, newest first: bucket i holds ages in [i, i+1) minutes. */
export function bucketSignups(rows: Array<{ created_at: string | null }>, now: number): number[] {
  const buckets = Array.from({ length: WINDOW_MINUTES }, () => 0);
  for (const row of rows) {
    const at = ms(row.created_at);
    if (!Number.isFinite(at)) continue;
    const age = Math.max(0, now - at);
    const index = Math.floor(age / MINUTE_MS);
    if (index < WINDOW_MINUTES) buckets[index] += 1;
  }
  return buckets;
}

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export interface JobListItem { id: string; minutes: number }

const dropTestRows = <T extends { user_id?: string | null }>(rows: T[], testIds: ReadonlySet<string>): T[] =>
  rows.filter((row) => !(row.user_id && testIds.has(row.user_id)));

/**
 * The same input without the test accounts (the page's «إخفاء حسابات الاختبار» toggle). Pure: it removes rows from what the
 * builder counts and changes nothing stored. Provider and model spend are not per user and stay as read.
 */
export function withoutTestAccounts(input: ConferenceInput, testIds: ReadonlySet<string>): ConferenceInput {
  if (testIds.size === 0) return input;
  let signups = input.signups;
  if (signups) {
    const rows = signups.rows.filter((row) => !(row.id && testIds.has(row.id)));
    const removed = signups.rows.length - rows.length;
    signups = { rows, total24h: signups.total24h == null ? null : Math.max(0, signups.total24h - removed) };
  }
  let topups = input.topups;
  if (topups) {
    const rows = dropTestRows(topups.rows, testIds);
    const removed = topups.rows.length - rows.length;
    topups = { rows, count: topups.count == null ? null : Math.max(0, topups.count - removed) };
  }
  return {
    ...input,
    signups,
    messages: input.messages ? dropTestRows(input.messages, testIds) : null,
    jobs: input.jobs ? dropTestRows(input.jobs, testIds) : null,
    ledger: input.ledger ? { ...input.ledger, rows: dropTestRows(input.ledger.rows, testIds), profiles: input.ledger.profiles.filter((p) => !testIds.has(p.id)) } : null,
    topups,
    unserved: input.unserved ? dropTestRows(input.unserved, testIds) : null,
  };
}

export function buildConferenceSnapshot(input: ConferenceInput): ConferenceSnapshot {
  const { now } = input;
  const alerts: AlertLine[] = [];
  const dayStart = cairoStartOf(now, "day");

  let signups: ConferenceSnapshot["signups"] = null;
  if (input.signups) {
    const perMinute = bucketSignups(input.signups.rows, now);
    const total = perMinute.reduce((sum, value) => sum + value, 0);
    const in24h = input.signups.rows.filter((row) => now - ms(row.created_at) <= 24 * 60 * MINUTE_MS).length;
    signups = { perMinute, lastMinute: perMinute[0], perMinuteAvg10: Math.round((total / WINDOW_MINUTES) * 10) / 10, total24h: Math.max(in24h, Math.floor(num(input.signups.total24h))) };
    if (signups.lastMinute > SIGNUPS_PER_MINUTE_WARN) alerts.push({ level: "warn", textAr: `التسجيل أسرع من حد البريد المتوقع (${fmt(signups.lastMinute)} تسجيل في آخر دقيقة)؛ راقب وصول رسائل التفعيل وأبلغ من لا تصله رسالة بالانتظار قليلًا.` });
  }

  let activeChats: ConferenceSnapshot["activeChats"] = null;
  if (input.messages) {
    const users = new Set<string>();
    let lastMinute = 0;
    for (const message of input.messages) {
      if (message.role !== undefined && message.role !== null && message.role !== "user") continue;
      const at = ms(message.created_at);
      if (!Number.isFinite(at)) continue;
      const age = now - at;
      if (age >= WINDOW_MINUTES * MINUTE_MS) continue;
      if (message.user_id) users.add(message.user_id);
      if (age < MINUTE_MS) lastMinute += 1;
    }
    activeChats = { users: users.size, messagesLastMinute: lastMinute };
  }

  let jobs: ConferenceSnapshot["jobs"] = null;
  let jobList: ConferenceSnapshot["jobList"] = null;
  if (input.jobs) {
    // The same rules as the admin jobs list (classifyJob): a queued job waiting long is «عالقة», not running or stalled.
    const lists: NonNullable<ConferenceSnapshot["jobList"]> = { running: [], queued: [], queuedStuck: [], stalled: [] };
    for (const job of input.jobs) {
      const kind = classifyJob(job, now);
      const idle = Math.max(0, Math.floor((now - (ms(job.updated_at) || ms(job.created_at))) / MINUTE_MS));
      const waiting = Math.max(0, Math.floor((now - ms(job.created_at)) / MINUTE_MS));
      if (kind === "running") lists.running.push({ id: job.id, minutes: idle });
      else if (kind === "stalled") lists.stalled.push({ id: job.id, minutes: idle });
      else if (kind === "queued") lists.queued.push({ id: job.id, minutes: waiting });
      else if (kind === "queued_stuck") lists.queuedStuck.push({ id: job.id, minutes: waiting });
    }
    jobList = lists;
    jobs = { running: lists.running.length, queued: lists.queued.length, stalled: lists.stalled.length };
    if (jobs.stalled > 0) alerts.push({ level: "bad", textAr: `${fmt(jobs.stalled)} طلب متوقف دون تقدم؛ افتح صفحة «التشغيل» لترى أيها، وسيُرجع النظام نقاطه تلقائيًا إن بقي متوقفًا.` });
    if (lists.queuedStuck.length > 0) alerts.push({ level: "warn", textAr: `${fmt(lists.queuedStuck.length)} طلب عالق في الانتظار منذ أكثر من ${fmt(QUEUED_STUCK_AFTER_MS / MINUTE_MS)} دقيقة؛ لم يبدأ ولا يُخصم منه شيء، وتظهر قائمته في لوحة المؤتمر.` });
    if (jobs.queued >= QUEUED_JOBS_WARN) alerts.push({ level: "warn", textAr: `${fmt(jobs.queued)} طلب في الانتظار؛ راقب الطابور، وإن لم ينقص خلال دقائق فتحقق من صفحة «التشغيل».` });
  }

  let provider: ConferenceSnapshot["provider"] = null;
  if (input.provider && (input.provider.real || input.provider.status)) {
    const real = input.provider.real ? { usd: input.provider.real.usd, ageSeconds: Math.max(0, Math.round((now - input.provider.real.at) / 1000)), source: input.provider.real.source } : null;
    const status = input.provider.status;
    let spend: NonNullable<ConferenceSnapshot["provider"]>["spend"] = null;
    if (status) {
      const percentOfCap = status.todayCapUsd > 0 ? Math.min(100, (status.todaySpendUsd / status.todayCapUsd) * 100) : status.todaySpendUsd > 0 ? 100 : 0;
      const level = status.todaySpendUsd >= status.todayCapUsd ? "reached" : percentOfCap >= PROVIDER_CAP_WARN_PERCENT ? "warn" : "ok";
      spend = { todaySpendUsd: status.todaySpendUsd, todayCapUsd: status.todayCapUsd, percentOfCap, level };
      if (level === "reached") alerts.push({ level: "bad", textAr: "وصل الإنفاق اليومي للمزود إلى الحد؛ لن تبدأ طلبات جديدة اليوم، ارفع الحد من الإعدادات إن كان الرصيد يسمح." });
      else if (level === "warn") alerts.push({ level: "warn", textAr: `استُهلك ${fmt(percentOfCap)}٪ من الحد اليومي للمزود؛ قرّر الآن هل ترفع الحد قبل أن يصل.` });
    }
    if (real) {
      if (real.usd < REAL_BALANCE_BAD_USD) alerts.push({ level: "bad", textAr: `الرصيد الحقيقي لدى المزود ${fmt(real.usd, 2)} دولار فقط؛ اشحنه فورًا قبل أن تتوقف الطلبات.` });
      else if (real.usd < REAL_BALANCE_WARN_USD) alerts.push({ level: "warn", textAr: `الرصيد الحقيقي لدى المزود ${fmt(real.usd, 2)} دولار؛ اشحنه قبل أي طلب كبير.` });
    } else {
      alerts.push({ level: "info", textAr: `${REAL_BALANCE_MISSING_AR}؛ الرقم المعروض تقدير فقط، فافتح لوحة المزود للتأكد من الرصيد.` });
    }
    provider = { real, realLabelAr: real ? (real.source === "live" ? "قراءة مباشرة" : "آخر قراءة صحيحة") : REAL_BALANCE_MISSING_AR, estimate: !real && status ? { usd: status.availableBalanceUsd, labelAr: REAL_BALANCE_ESTIMATE_LABEL_AR } : null, spend };
  }

  let topSpenders: ConferenceSnapshot["topSpenders"] = null;
  if (input.ledger) {
    const totals = new Map<string, number>();
    for (const row of input.ledger.rows) {
      if (!row.user_id) continue;
      if (row.type !== undefined && row.type !== null && row.type !== "charge") continue;
      const delta = num(row.delta);
      if (delta >= 0) continue;
      totals.set(row.user_id, (totals.get(row.user_id) ?? 0) + -delta);
    }
    const profiles = new Map(input.ledger.profiles.map((profile) => [profile.id, profile]));
    topSpenders = {
      truncated: input.ledger.truncated,
      rows: [...totals.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, TOP_SPENDERS_LIMIT)
        .map(([id, points]) => ({ shortId: id.slice(0, 8), name: profiles.get(id)?.sender_name?.trim() || null, email: profiles.get(id)?.email?.trim() || null, points })),
    };
  }

  let modelSpend: ConferenceSnapshot["modelSpend"] = null;
  if (input.modelUsage) {
    const monthStart = cairoStartOf(now, "month");
    let todayUsd = 0;
    let monthUsd = 0;
    for (const row of input.modelUsage.rows) {
      const at = ms(row.created_at);
      if (!Number.isFinite(at) || at < monthStart) continue;
      const cost = num(row.cost_usd);
      if (cost <= 0) continue;
      monthUsd += cost;
      if (at >= dayStart) todayUsd += cost;
    }
    const budget = input.monthlyBudgetUsd && input.monthlyBudgetUsd > 0 ? input.monthlyBudgetUsd : null;
    const percentUsed = budget ? (monthUsd / budget) * 100 : null;
    modelSpend = { todayUsd, monthUsd, truncated: input.modelUsage.truncated, budget: { monthlyUsd: budget, percentUsed, noteAr: budget ? `الميزانية الشهرية ${fmt(budget, 2)} دولار.` : NO_MODEL_BUDGET_AR } };
    if (budget && percentUsed !== null) {
      if (percentUsed >= MODEL_BUDGET_BAD_PERCENT) alerts.push({ level: "bad", textAr: `إنفاق النموذج هذا الشهر بلغ ${fmt(percentUsed)}٪ من الميزانية؛ راجع الاستهلاك فورًا وقرّر هل توقف الخدمة أو ترفع الميزانية.` });
      else if (percentUsed >= MODEL_BUDGET_WARN_PERCENT) alerts.push({ level: "warn", textAr: `إنفاق النموذج هذا الشهر بلغ ${fmt(percentUsed)}٪ من الميزانية؛ راقب الاستهلاك وجهّز قرار الزيادة.` });
    }
  }

  let pendingTopups: ConferenceSnapshot["pendingTopups"] = null;
  if (input.topups) {
    const count = Math.max(input.topups.rows.length, Math.floor(num(input.topups.count)));
    pendingTopups = { count, totalEgp: input.topups.rows.reduce((sum, row) => sum + num(row.amount_egp), 0) };
    if (count >= PENDING_TOPUPS_WARN) alerts.push({ level: "warn", textAr: `${fmt(count)} طلب شحن ينتظر المراجعة؛ افتح «طلبات الشحن» واعتمد أو ارفض لتصل النقاط لأصحابها.` });
  }

  let unserved: ConferenceSnapshot["unserved"] = null;
  if (input.unserved) {
    const summary = summarizeUnserved(input.unserved);
    unserved = { total: summary.total, families: summary.byFamily.slice(0, UNSERVED_TOP_LIMIT).map(({ family, titleAr, count }) => ({ family, titleAr, count })) };
  }

  const order = { bad: 0, warn: 1, info: 2 } as const;
  alerts.sort((a, b) => order[a.level] - order[b.level]);

  return { checkedAt: new Date(now).toISOString(), signups, activeChats, jobs, jobList, provider, topSpenders, modelSpend, pendingTopups, unserved, alerts, notes: input.notes ?? [], thresholds: CONFERENCE_THRESHOLDS };
}
