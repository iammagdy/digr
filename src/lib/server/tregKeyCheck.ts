import { checkProviderKey, extractTregOrgId, fetchTregBalance, type FetchLike } from "./providerStatus";
import { accountRefusalReason, providerReasonText, redactAndClip, type AccountRefusal } from "./tregRefusal";
import { executeTregCall, type TregCallOptions, type TregCallResult } from "../../functions/shared/tregClient";
import { createCallRecorder } from "./multiProvider/callRecorder";
import type { CallRecorder } from "./multiProvider/adapterTypes";
import { toArabicDigits } from "../arabicDigits";
import { HEALTH_DEFAULT_MIN_BALANCE_MICRO } from "./tregPoolHealth";

/**
 * THE 3-STEP KEY CHECK (admin only). A TREG key is judged by what it does, not by what the free reads say: on 2026-10-30 a key whose organisation was suspended passed the
 * identity read and the balance read for 15 hours while every data call answered 403 «org suspended».
 *   1. identity   GET /auth/me                       free
 *   2. balance    GET /orgs/{org}/balance            free
 *   3. data call  ONE real call on the cheapest sellable data endpoint (KEY_CHECK_PROBE)  about 0.00015 USD, counted against the provider's daily cap like any call
 * The key is used here, in this function's memory, as a header of those three requests and nowhere else: never stored, logged, echoed, put in a URL or in the report. Everything the
 * report carries about the provider is its own short words, with the key and token-shaped strings removed.
 */

/**
 * The probe: the cheapest endpoint of the sellable catalog that is public data (not blocked, not sensitive, not AI generation), whose required inputs all have a catalog example, with
 * at least 1,000 observed calls and a 95% success rate (so a failure is the key's, not the source's). Ties on price (0.00015 USD per success) go to the best success rate, then the fastest
 * observed median (here: 2,585 observed calls, 100% success, 693 ms). The choice is pinned here (the 10 MB catalog is not loaded in a route) and `tests/treg-key-check.test.ts`
 * recomputes it from the catalog and fails if the rule would now pick another endpoint.
 */
export const KEY_CHECK_PROBE = {
  endpointId: "crawl4ai.google.serp.news",
  params: { query: "rust programming" },
  estimateUsd: 0.00015,
  routeMaxCostUsd: 0.001,
  timeoutMs: 20_000,
} as const;

export type KeyVerdict = "works" | "out_of_balance" | "suspended" | "refused" | "unknown";
export interface KeyCheckStep { name: "identity" | "balance" | "data"; ran: boolean; ok: boolean | null; httpStatus: number | null }
export interface KeyCheckReport {
  verdict: KeyVerdict;
  /** الحالة, ready to show. */
  statusAr: string;
  balanceUsd: number | null;
  /** The provider's own short words for a refusal, shortened and redacted; null when it gave none. */
  providerText: string | null;
  /** Why the data call did not run (the daily cap, the cost record), when it did not. */
  noteAr: string | null;
  steps: KeyCheckStep[];
  /** What the data call cost, in USD (0 when it did not run). */
  costUsd: number;
  /** For recording on a pool key. */
  record: { status: "connected" | "out_of_balance" | "revoked" | null; reason: string; balanceMicro: number | null; email: string | null };
}

export interface KeyCheckDeps {
  client: any;
  fetchFn?: FetchLike;
  recorder?: CallRecorder;
  /** Tests: the TREG data-call function (default: the platform's funnel with the explicit key, which bypasses the pool). */
  callFn?: (options: TregCallOptions) => Promise<TregCallResult>;
  /** The main key's saved TREG team id (the identity read of the main key may not name it). */
  orgId?: string | null;
  minBalanceMicro?: number;
  /** A pool key's mark for the cost row (number and label; never the key). */
  keyRef?: { id: string; number: number; label: string; isMain: boolean } | null;
  /** Random part of the call's idempotency / meta id (tests fix it). */
  nonce?: () => string;
}

const GLOSS_REFUSED: Record<number, string> = { 401: "المفتاح غير صالح أو أُلغي", 403: "ممنوع من المزود" };

export const VERDICT_AR: Record<KeyVerdict, string> = { works: "يعمل", out_of_balance: "رصيد غير كافٍ", suspended: "الحساب موقوف", refused: "مرفوض", unknown: "غير معروف" };

export function statusLineAr(verdict: KeyVerdict, httpStatus: number | null): string {
  if (verdict === "refused") return `مرفوض: ${(httpStatus !== null && GLOSS_REFUSED[httpStatus]) || (httpStatus !== null ? `رمز الرد ${toArabicDigits(httpStatus)}` : "سبب غير معروف")}`;
  return VERDICT_AR[verdict];
}

const usdOf = (micro: number | null) => (micro === null ? null : micro / 1_000_000);

interface DataOutcome { ran: boolean; ok: boolean; httpStatus: number | null; platformBalanceLow: boolean; text: string | null; costUsd: number; noteAr: string | null }

async function runProbeCall(key: string, deps: KeyCheckDeps): Promise<DataOutcome> {
  const recorder = deps.recorder ?? createCallRecorder(deps.client);
  const call = deps.callFn ?? executeTregCall;
  const reservation = await recorder.reserve({ provider: "treg", capabilityId: KEY_CHECK_PROBE.endpointId, estimatedUsd: KEY_CHECK_PROBE.estimateUsd, jobId: null }).catch(() => ({ allowed: false, costId: null as number | null, reason: "error" as const }));
  if (!reservation.allowed) {
    return { ran: false, ok: false, httpStatus: null, platformBalanceLow: false, text: null, costUsd: 0,
      noteAr: reservation.reason === "cap" ? "لم يُرسَل الطلب الحقيقي: بلغ الإنفاق اليومي على المزود حدّه." : "لم يُرسَل الطلب الحقيقي: تعذّر تسجيل تكلفته." };
  }
  const id = (deps.nonce ?? (() => Math.random().toString(36).slice(2, 12)))();
  let result: TregCallResult | null = null;
  const started = Date.now();
  try {
    result = await call({
      token: key, endpointId: KEY_CHECK_PROBE.endpointId, params: { ...KEY_CHECK_PROBE.params }, userId: "admin_key_check", jobId: `keycheck_${id}`, stepId: "probe",
      routeMaxCostUsd: KEY_CHECK_PROBE.routeMaxCostUsd, callEstimateUsd: KEY_CHECK_PROBE.estimateUsd, timeoutMs: KEY_CHECK_PROBE.timeoutMs, routeWaterfall: false, endpointScope: "any_account",
    });
  } catch {
    result = null;
  }
  // The cost row is always closed: what TREG charged, or the estimate when the call was cut or never answered (it may have been billed after we stopped waiting)
  const unknownCost = !result || result.timedOut === true || result.error === "network_failure";
  const costUsd = unknownCost ? KEY_CHECK_PROBE.estimateUsd : Math.max(0, (result?.costMicro || 0) / 1_000_000);
  const rows = result?.ok ? (Array.isArray(result.data) ? result.data.length : result.data && typeof result.data === "object" ? 1 : 0) : 0;
  try {
    await recorder.commit(reservation.costId, {
      provider: "treg", capabilityId: KEY_CHECK_PROBE.endpointId, status: result?.ok ? (rows > 0 ? "success" : "empty") : "failed", units: rows, costUsd,
      durationMs: Date.now() - started, jobId: null, keyRef: deps.keyRef ?? null,
    });
  } catch { /* the cost row stays an estimate: counted against the cap, which is the safe side */ }
  if (!result) return { ran: true, ok: false, httpStatus: null, platformBalanceLow: false, text: null, costUsd, noteAr: null };
  const text = result.ok ? null : redactAndClip(`${result.errorDetails ?? result.detail ?? ""}`, [key], 160);
  return { ran: true, ok: result.ok, httpStatus: result.httpStatus || null, platformBalanceLow: result.isPlatformBalanceLow === true, text, costUsd, noteAr: null };
}

/** Pure: the verdict from what the three steps found. */
export function decideVerdict(input: {
  identity: { ok: boolean; httpStatus: number | null; text: string | null };
  balanceMicro: number | null;
  minBalanceMicro: number;
  data: { ran: boolean; ok: boolean; httpStatus: number | null; platformBalanceLow: boolean; text: string | null };
}): { verdict: KeyVerdict; httpStatus: number | null; providerText: string | null; refusal: AccountRefusal | null; origin: "identity" | "data" | "none" } {
  const { identity, data } = input;
  if (!identity.ok) {
    if (identity.httpStatus === 401 || identity.httpStatus === 403) {
      const refusal = accountRefusalReason(identity.text);
      return { verdict: refusal ? "suspended" : "refused", httpStatus: identity.httpStatus, providerText: identity.text, refusal, origin: "identity" };
    }
    return { verdict: "unknown", httpStatus: identity.httpStatus, providerText: identity.text, refusal: null, origin: "none" };
  }
  if (data.ran) {
    if (data.ok) return { verdict: "works", httpStatus: data.httpStatus, providerText: null, refusal: null, origin: "data" };
    if (data.platformBalanceLow) return { verdict: "out_of_balance", httpStatus: data.httpStatus, providerText: data.text, refusal: null, origin: "data" };
    if (data.httpStatus === 401 || data.httpStatus === 403) {
      const refusal = accountRefusalReason(data.text);
      return { verdict: refusal ? "suspended" : "refused", httpStatus: data.httpStatus, providerText: data.text, refusal, origin: "data" };
    }
    return { verdict: "unknown", httpStatus: data.httpStatus, providerText: data.text, refusal: null, origin: "data" };
  }
  // the data call did not run (cap, cost record): only an empty balance is conclusive
  if (input.balanceMicro !== null && input.balanceMicro <= input.minBalanceMicro) return { verdict: "out_of_balance", httpStatus: null, providerText: null, refusal: null, origin: "none" };
  return { verdict: "unknown", httpStatus: null, providerText: null, refusal: null, origin: "none" };
}

export async function runKeyCheck(key: string, deps: KeyCheckDeps): Promise<KeyCheckReport> {
  const fetchFn = deps.fetchFn ?? ((input, init) => fetch(input, init));
  const min = deps.minBalanceMicro ?? HEALTH_DEFAULT_MIN_BALANCE_MICRO;
  const secrets = [key];

  // 1. identity
  const me = await checkProviderKey("treg", key, fetchFn);
  const identityOk = me.health.ok;
  const identity = { ok: identityOk, httpStatus: me.health.httpStatus, text: identityOk ? null : providerReasonText(me.body, secrets) };
  const steps: KeyCheckStep[] = [{ name: "identity", ran: true, ok: identityOk, httpStatus: me.health.httpStatus }];
  const email = identityOk && me.body && typeof me.body === "object" && typeof (me.body as any).email === "string" ? String((me.body as any).email).slice(0, 254) : null;

  // 2. balance (free); skipped when the identity read failed
  let balanceMicro: number | null = null;
  if (identityOk) {
    const org = deps.orgId || extractTregOrgId(me.body);
    const bal = org ? await fetchTregBalance(key, org, fetchFn) : null;
    balanceMicro = bal && bal.available && typeof bal.balanceMicro === "number" ? bal.balanceMicro : null;
    steps.push({ name: "balance", ran: true, ok: balanceMicro !== null, httpStatus: null });
  } else steps.push({ name: "balance", ran: false, ok: null, httpStatus: null });

  // 3. ONE real data call (not sent when the identity read already refused the key)
  const data: DataOutcome = identityOk ? await runProbeCall(key, deps) : { ran: false, ok: false, httpStatus: null, platformBalanceLow: false, text: null, costUsd: 0, noteAr: null };
  steps.push({ name: "data", ran: data.ran, ok: data.ran ? data.ok : null, httpStatus: data.httpStatus });

  const d = decideVerdict({ identity, balanceMicro, minBalanceMicro: min, data });
  // «works» wins over a low balance read: the call was answered. A refusal's reason code is stored admin-only.
  const record: KeyCheckReport["record"] =
    d.verdict === "works" ? { status: "connected", reason: "data_call_ok", balanceMicro, email }
      : d.verdict === "out_of_balance" ? { status: "out_of_balance", reason: data.ran ? "http_402" : "balance_low", balanceMicro, email }
        : d.verdict === "suspended" ? { status: "revoked", reason: d.refusal ?? "org_suspended", balanceMicro, email }
          : d.verdict === "refused" ? { status: "revoked", reason: `${d.origin === "data" ? "data" : "auth"}_${d.httpStatus ?? "none"}`.slice(0, 60), balanceMicro, email }
            : { status: null, reason: "check_inconclusive", balanceMicro, email };

  return {
    verdict: d.verdict, statusAr: statusLineAr(d.verdict, d.httpStatus), balanceUsd: usdOf(balanceMicro), providerText: d.providerText, noteAr: data.noteAr,
    steps, costUsd: data.costUsd, record,
  };
}
