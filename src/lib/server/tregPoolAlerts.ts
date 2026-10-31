import { sendPlatformEmail } from "./sendPlatformEmail";
import { alertTimeAr, ownerAlertRecipient } from "./topupOwnerAlert";
import { toArabicDigits } from "../arabicDigits";
import { SITE_URL } from "../site";

/**
 * The admin e-mails of the TREG key pool (docs/proposals/treg-key-pool/README.md section 5). Arabic, short, admin only (so they name the provider, like the admin pages),
 * one per key per problem episode: the SQL outbox (treg_pool_alerts) holds one open row per (problem, key) and refuses the same pair again for 30 minutes, the Vercel cron
 * route sends what is waiting through the existing «job-update» template. The text carries a key's NUMBER and LABEL, never the key, never a ciphertext, never provider text.
 */
export type PoolAlertProblem = "failover" | "chain_reached_main" | "health_broken" | "main_failed" | "store_unreadable";

export interface PoolAlertRow {
  id: number;
  problem: PoolAlertProblem;
  key_number: number | null;
  key_label: string | null;
  to_key_number: number | null;
  to_key_label: string | null;
  reason: string | null;
  created_at: string;
}

/** What happened to a key, in words (the stored reason is a fixed code). */
export function poolReasonAr(reason: string | null | undefined): string {
  const r = String(reason || "");
  if (r === "org_suspended" || r === "account_disabled") return "حسابه لدى المزود موقوف";
  if (r === "auth_403_repeated" || /^data_(401|403)$/.test(r)) return "رفض المزود طلباته";
  if (r === "revoked" || /^auth_/.test(r)) return "أُلغي أو رفضه المزود";
  if (/^(out_of_balance|http_402|balance_low)(:|$)/.test(r)) return "انتهى رصيده";
  if (r === "error") return "يعطي خطأ غير متوقع";
  return "توقف عن العمل";
}

const keyText = (n: number | null, label: string | null): string => `رقم ${toArabicDigits(n ?? 0)}${label ? ` (${label})` : ""}`;

const STORE_REASON_AR: Record<string, string> = {
  decrypt_failed: "تعذّر فك تشفير المفتاح النشط",
  encryption_key_missing: "تعذّرت قراءة مفتاح التشفير من الخزنة",
  active_missing: "المفتاح النشط غير موجود في المخزن",
};
const storeReasonAr = (reason: string | null): string => STORE_REASON_AR[String(reason || "")] ?? "تعذّر الاتصال بقاعدة البيانات";

/** The «job-update» variables of one alert. */
export function buildPoolAlertVars(row: Pick<PoolAlertRow, "problem" | "key_number" | "key_label" | "to_key_number" | "to_key_label" | "reason" | "created_at">, siteUrl: string = SITE_URL): Record<string, string> {
  const from = keyText(row.key_number, row.key_label);
  const to = keyText(row.to_key_number, row.to_key_label);
  const why = poolReasonAr(row.reason);
  const when = `الوقت: ${alertTimeAr(row.created_at)}.`;
  const base = { Name: "الإدارة", ButtonLabel: "افتح مزودو الخدمة", JobURL: `${siteUrl}/admin/providers` };
  switch (row.problem) {
    case "failover":
      return {
        ...base, Subject: `تنبيه: انتقلت المنصة إلى مفتاح TREG ${to.split(" (")[0]}`, Heading: "انتقال تلقائي إلى مفتاح آخر", Preheader: `انتقلت المنصة إلى المفتاح ${to}.`,
        Lead: `توقّف المفتاح ${from} لأنه ${why}. انتقلت المنصة تلقائيًا إلى المفتاح ${to} وتابعت العمل دون أن يتأثر أي عميل.`,
        DetailOne: `المفتاح النشط الآن: ${to}.`, DetailTwo: when,
      };
    case "chain_reached_main":
      return {
        ...base, Subject: "تنبيه: المنصة تعمل الآن على المفتاح الرئيسي", Heading: "وصلت المنصة إلى المفتاح الرئيسي", Preheader: "لم يبقَ مفتاح اختبار صالح في السلسلة.",
        Lead: `لم يبقَ مفتاح اختبار صالح في السلسلة، فانتقلت المنصة إلى المفتاح الرئيسي (${from}). أي اختبار الآن يُخصم من رصيده.`,
        DetailOne: "أضف مفتاح اختبار أو فعّل مفتاحًا صالحًا من الجدول للعودة.", DetailTwo: when,
      };
    case "health_broken":
      return {
        ...base, Subject: `تنبيه: مفتاح TREG ${from.split(" (")[0]} لا يعمل`, Heading: "الفحص الدوري وجد مفتاحًا معطّلًا", Preheader: `المفتاح ${from} ${why}.`,
        Lead: `وجد الفحص الدوري أن المفتاح ${from} ${why}. ليس نشطًا الآن فلم يتأثر العمل.`,
        DetailOne: "سيُتخطّى تلقائيًا في السلسلة إلى أن يعود للعمل.", DetailTwo: when,
      };
    case "main_failed":
      return {
        ...base, Subject: "عاجل: المفتاح الرئيسي لـ TREG لا يعمل", Heading: "المفتاح الرئيسي متوقف", Preheader: "لا يوجد مفتاح بعد المفتاح الرئيسي في السلسلة.",
        Lead: `المفتاح الرئيسي (${from}) ${why} ولا يوجد مفتاح بعده في السلسلة، وقد تتعطل طلبات العملاء.`,
        DetailOne: "اشحن الحساب أو استبدل المفتاح فورًا من الجدول.", DetailTwo: when,
      };
    case "store_unreadable":
    default:
      return {
        ...base, Subject: "تنبيه: تعذّرت قراءة مخزن مفاتيح TREG", Heading: "مخزن المفاتيح غير مقروء", Preheader: "استُخدم المفتاح الرئيسي المضبوط في البيئة.",
        Lead: `${storeReasonAr(row.reason)}، فاستُخدم المفتاح الرئيسي المضبوط في البيئة (TREG_TOKEN) بدل المفتاح النشط. لم يُستخدم أي مفتاح اختبار.`,
        DetailOne: "تعود المنصة إلى المفتاح النشط تلقائيًا عندما تُقرأ القاعدة من جديد.", DetailTwo: when,
      };
  }
}

export interface FlushDeps {
  client: any;
  send?: typeof sendPlatformEmail;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

/** Sends what the outbox holds (leases it first, so two cron runs never send one alert twice). Never throws. */
export async function flushPoolAlerts(deps: FlushDeps): Promise<{ taken: number; sent: number; failed: number; skipped?: "no_recipient" }> {
  const send = deps.send ?? sendPlatformEmail;
  const log = deps.log ?? ((line: string) => console.log(line));
  const to = ownerAlertRecipient(deps.env);
  if (!to) { log("[treg_pool:alert_skipped] no ADMIN_ALERT_EMAIL"); return { taken: 0, sent: 0, failed: 0, skipped: "no_recipient" }; }
  let rows: PoolAlertRow[] = [];
  try {
    const { data, error } = await deps.client.rpc("treg_pool_take_pending_alerts", { p_limit: 10 });
    if (error || !Array.isArray(data)) return { taken: 0, sent: 0, failed: 0 };
    rows = data as PoolAlertRow[];
  } catch { return { taken: 0, sent: 0, failed: 0 }; }
  let sent = 0; let failed = 0;
  for (const row of rows) {
    let ok = false;
    try {
      const result = await send("job-update", to, buildPoolAlertVars(row), `treg-pool-alert:${row.id}`);
      ok = !(result && result.ok === false);
    } catch { ok = false; }
    try { await deps.client.rpc("treg_pool_mark_alert_emailed", { p_alert_id: row.id, p_ok: ok }); } catch { /* the lease expires and the row is tried again */ }
    if (ok) sent += 1; else failed += 1;
    log(`[treg_pool:alert] id=${row.id} problem=${row.problem} ${ok ? "sent" : "failed"}`);
  }
  return { taken: rows.length, sent, failed };
}
