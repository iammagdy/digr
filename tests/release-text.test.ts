import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ALL_CUSTOMER_STRINGS, chainFailureReasonAr, operatorReleaseReasonAr, staleReleaseReasonAr } from "../src/lib/multiProvider/copy";
import { SENSITIVE_NOT_VERIFIED_AR } from "../src/lib/treg/dataPolicy";
import { PURPOSE_REQUIRED_AR, SENSITIVE_AUDIT_UNAVAILABLE_AR, SENSITIVE_LIMIT_AR, sensitiveRefusalAr } from "../src/lib/server/sensitiveAccess";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { normalizeReleaseWording, stripRetryPrefix } from "../src/lib/releaseWording";
import { PROVIDER_BUSY_AR, PROVIDER_GENERIC_FAILURE_AR, PROVIDER_INCOMPATIBLE_ANSWER_AR, PROVIDER_INPUT_REJECTED_AR, PROVIDER_ROUTE_COST_EXCEEDED_AR, PROVIDER_TARGET_NOT_FOUND_AR, PROVIDER_TIMEOUT_AR, PROVIDER_UNAVAILABLE_AR, isDeterministicFailureAr } from "../src/lib/providerFailureText";
import { CustomerReasonError, REASON_AR, RELEASE_NEUTRAL_REASON_AR, RETRY_CAUSE_AR, adapterStopError, releaseTextAr, trustedCauseAr } from "../src/lib/releaseText";

/** DT-20261117-06 T1: the closed trust boundary of release texts (plan §2 M1, §5 T1). Fakes only; every expectation is hand-derived. */
const HOSTILE: unknown[] = [
  new Error("settle_failed"),
  new Error("x_y"),
  new Error("خطأ في a"),
  new Error("تعذر الاتصال بفايركرول"),
  new Error("تم إرجاع ٥٠ نقطة إلى رصيدك"),
  new Error("بريد user@x.y"),
  new Error("رمز 7781"),
  "settle_failed",
  undefined,
];

describe("T1 releaseText (DT-20261117-06 M1)", () => {
  it("T1 releaseTextAr: a trusted reason plus a valid N gives the exact (J) text, anything else keeps the reason alone", () => {
    const exact = `المسلَّم ٠ من ١٢ مطلوب. السبب: ${RELEASE_NEUTRAL_REASON_AR}`;
    expect(releaseTextAr(RELEASE_NEUTRAL_REASON_AR, 12)).toBe(exact);
    expect(releaseTextAr(`السبب: ${RELEASE_NEUTRAL_REASON_AR}`, 12)).toBe(exact);
    const carried = `المسلَّم ٥ من ٢٠ مطلوب. السبب: ${RELEASE_NEUTRAL_REASON_AR}`;
    expect(releaseTextAr(carried, 12)).toBe(carried);
    for (const bad of [null, undefined, 0, 1.5, "x", -3]) expect(releaseTextAr(RELEASE_NEUTRAL_REASON_AR, bad)).toBe(RELEASE_NEUTRAL_REASON_AR);
  });

  it("T1 trustedCauseAr (K-3 leak test): the text of any other error is never read", () => {
    for (const e of HOSTILE) expect(trustedCauseAr(e)).toBe(RETRY_CAUSE_AR);
    expect(trustedCauseAr(new CustomerReasonError("collection_unverified"))).toBe(REASON_AR.collection_unverified);
  });

  it("T1 adapterStopError: only the three release-free chain failure reasons of copy.ts are kept", () => {
    for (const kind of ["spend", "cursor", "lease"] as const) {
      const text = chainFailureReasonAr(kind);
      expect(adapterStopError(text).textAr).toBe(text);
    }
    for (const other of ["Tomba rate limit", "جملة عربية ليست ضمن النصوص المراجعة.", "", undefined, 7, `${PROVIDER_INPUT_REJECTED_AR} تومبا`]) expect(adapterStopError(other).textAr).toBe(REASON_AR.provider_unavailable);
  });

  // v6 (V-7), v8 (X-1): the adapter's own reviewed sentences are kept exactly (the eight constants and the social adapter's sentence), so the screens' retry-button rule (isDeterministicFailureAr) is today's.
  const SOCIAL_SENTENCE = `${PROVIDER_INCOMPATIBLE_ANSWER_AR}.`;
  const REVIEWED_ADAPTER_SENTENCES = [
    PROVIDER_ROUTE_COST_EXCEEDED_AR, PROVIDER_UNAVAILABLE_AR, PROVIDER_TARGET_NOT_FOUND_AR, PROVIDER_INPUT_REJECTED_AR, PROVIDER_BUSY_AR, PROVIDER_GENERIC_FAILURE_AR, PROVIDER_TIMEOUT_AR, PROVIDER_INCOMPATIBLE_ANSWER_AR,
    SOCIAL_SENTENCE,
  ];
  it.each(REVIEWED_ADAPTER_SENTENCES)("T1 adapterStopError keeps the reviewed adapter sentence #%#", (sentence) => {
    expect(adapterStopError(sentence).textAr).toBe(sentence);
    expect(isDeterministicFailureAr(releaseTextAr(adapterStopError(sentence).textAr, 50))).toBe(isDeterministicFailureAr(sentence));
  });

  it("T1 (X-1) the social adapter's sentence is admitted exactly and the retry button stays hidden", () => {
    expect(SOCIAL_SENTENCE).toBe("استجاب المصدر ببيانات غير متوافقة مع نوع البحث."); // pins the literal of socialAdapter.ts
    const out = adapterStopError(SOCIAL_SENTENCE).textAr;
    expect(out).toBe(SOCIAL_SENTENCE);
    expect(isDeterministicFailureAr(releaseTextAr(out, 50))).toBe(true);
  });

  // v7 (W-1): the composed text of tregAdapter.ts is returned BEFORE any release, so it must not be kept: it maps to the bare base sentence.
  const COMPOSED = `${PROVIDER_INCOMPATIBLE_ANSWER_AR}؛ تم إيقاف الطلب: حجز مؤقت مُحرَّر.`;
  it("T1 (W-1) the composed adapter text maps to the bare base sentence, with no release claim", () => {
    const out = adapterStopError(COMPOSED).textAr;
    expect(out).toBe(PROVIDER_INCOMPATIBLE_ANSWER_AR);
    expect(trustedCauseAr(adapterStopError(COMPOSED))).toBe(PROVIDER_INCOMPATIBLE_ANSWER_AR);
    expect(out).not.toContain("حجز مؤقت مُحرَّر");
    expect(out).not.toContain("تم إيقاف الطلب");
    expect(isDeterministicFailureAr(releaseTextAr(out, 50))).toBe(true);
  });

  // v7 (W-1), v8 (X-1): exact membership only. A near miss of the composed text or of the social sentence is not admitted and maps to the neutral provider constant.
  it.each([
    `${COMPOSED} `,
    `${PROVIDER_INCOMPATIBLE_ANSWER_AR}..`,
    `${PROVIDER_INCOMPATIBLE_ANSWER_AR}؛ حجز مؤقت مُحرَّر كاملًا.`,
    "تم إيقاف الطلب: حجز مؤقت مُحرَّر.",
  ])("T1 (W-1, X-1) near-miss adapter text #%# maps to the neutral provider constant", (near) => {
    expect(adapterStopError(near).textAr).toBe(REASON_AR.provider_unavailable);
  });

  // FIX-1 (Gate 2 r1): a text that claims a release, a hold, a charge or a count never survives an adapter failure before a confirmed release.
  const CLAIM_RX = /حجز|مُحرَّر|المسلَّم|خُصم|[٠-٩0-9]/;
  it.each([45, 7, 1, 25000])("T1 FIX-1 stale and operator release texts (target %i) from an adapter map to the neutral provider constant", (target) => {
    for (const text of [staleReleaseReasonAr(target), operatorReleaseReasonAr(target)]) {
      expect(CLAIM_RX.test(text), text).toBe(true); // non-vacuity: these texts do claim a release and a count
      const err = adapterStopError(text);
      expect(err.textAr, text).toBe(REASON_AR.provider_unavailable);
      expect(trustedCauseAr(err), text).toBe(REASON_AR.provider_unavailable);
      expect(CLAIM_RX.test(trustedCauseAr(err)), text).toBe(false);
    }
  });

  it("T1 FIX-1 fail closed: every copy.ts customer text except the three chain failure reasons maps to the neutral provider constant", () => {
    const allowed = new Set((["spend", "cursor", "lease"] as const).map((kind) => chainFailureReasonAr(kind)));
    const all = ALL_CUSTOMER_STRINGS();
    expect(all.filter((text) => allowed.has(text))).toHaveLength(3);
    for (const text of all) expect(adapterStopError(text).textAr, text).toBe(allowed.has(text) ? text : REASON_AR.provider_unavailable);
  });
  it("T1 FIX-1 no text that stays allowed claims a release, a hold, a charge or a count", () => {
    const kept = [...(["spend", "cursor", "lease"] as const).map((kind) => chainFailureReasonAr(kind)), ...REVIEWED_ADAPTER_SENTENCES];
    for (const text of kept) {
      expect(adapterStopError(text).textAr, text).toBe(text);
      expect(CLAIM_RX.test(text), text).toBe(false);
    }
  });

  it("T1 QA#4 the verified-business refusal is kept as a reviewed reason, without its trailing money clause", () => {
    const kept = "هذه الخدمة متاحة لحسابات الأعمال الموثّقة فقط؛ تواصل مع الدعم لتوثيق حسابك.";
    expect(sensitiveRefusalAr("sensitive_not_allowed")).toBe(SENSITIVE_NOT_VERIFIED_AR); // the adapter's text is the policy constant
    expect(SENSITIVE_NOT_VERIFIED_AR).toBe(`${kept.slice(0, -1)}، ولم يُحجز أي رصيد.`); // only that clause is dropped
    const err = adapterStopError(SENSITIVE_NOT_VERIFIED_AR);
    expect(err.textAr).toBe(kept);
    expect(trustedCauseAr(err)).toBe(kept);
    expect(kept).toContain("حسابات الأعمال الموثّقة");
    expect(CLAIM_RX.test(kept)).toBe(false);
    expect(checkCustomerText(kept).issues).toEqual([]);
  });

  it.each([
    { name: "purpose required", refusal: "purpose_required" as const, constant: PURPOSE_REQUIRED_AR, tail: "، ولم يُحجز أي رصيد.", kept: "الغرض من الاستخدام مطلوب قبل اعتماد هذه الخدمة؛ اكتبه في جملة قصيرة." },
    { name: "daily limit", refusal: "daily_limit" as const, constant: SENSITIVE_LIMIT_AR, tail: "، ولم يُخصم أي رصيد.", kept: "بلغ حسابك الحد اليومي لهذا النوع من الاستعلامات؛ يمكنك المتابعة غدًا." },
    { name: "audit unavailable", refusal: "audit_unavailable" as const, constant: SENSITIVE_AUDIT_UNAVAILABLE_AR, tail: "، ولم يُخصم أي رصيد.", kept: "تعذّر تسجيل هذا الاستعلام الآن فلم يُنفَّذ؛ حاول لاحقًا." },
    { name: "blocked", refusal: "blocked" as const, constant: sensitiveRefusalAr("blocked"), tail: "، ولم يُحجز أي رصيد.", kept: "هذه الخدمة غير متاحة حاليًا." },
  ])("T1 D5 the $name refusal is kept as a reviewed reason, without its trailing money clause", ({ refusal, constant, tail, kept }) => {
    expect(sensitiveRefusalAr(refusal)).toBe(constant); // the adapter's text is the refusal constant
    expect(constant).toBe(`${kept.slice(0, -1)}${tail}`); // only that clause is dropped
    const err = adapterStopError(constant);
    expect(err.textAr).toBe(kept);
    expect(trustedCauseAr(err)).toBe(kept);
    expect(CLAIM_RX.test(kept)).toBe(false);
    expect(checkCustomerText(kept).issues).toEqual([]);
  });

  it("T1 every output passes the customer-text guard, has no «فشل», and is stable under normalizeReleaseWording", () => {
    const outs = [
      RELEASE_NEUTRAL_REASON_AR, RETRY_CAUSE_AR, ...Object.values(REASON_AR),
      releaseTextAr(RELEASE_NEUTRAL_REASON_AR, 12), releaseTextAr(RETRY_CAUSE_AR, 1), releaseTextAr(REASON_AR.collection_unverified, 25000),
      ...HOSTILE.map((e) => trustedCauseAr(e)), adapterStopError("Tomba rate limit").textAr,
    ];
    for (const out of outs) {
      expect(checkCustomerText(out).issues, out).toEqual([]);
      expect(out, out).not.toMatch(/فشل/);
      expect(normalizeReleaseWording(out), out).toBe(out);
    }
  });

  it("T1 stripRetryPrefix removes only the English retry prefix", () => {
    expect(stripRetryPrefix("Exceeded maximum retry attempts (5): x")).toBe("x");
    expect(stripRetryPrefix(RETRY_CAUSE_AR)).toBe(RETRY_CAUSE_AR);
    expect(normalizeReleaseWording(`Exceeded maximum retry attempts (5): ${RETRY_CAUSE_AR}`)).toBe(RETRY_CAUSE_AR);
  });
});

describe("T7 source guards (DT-20261117-06)", () => {
  const route = readFileSync("src/app/api/worker/chunk/route.ts", "utf8");
  const planner = readFileSync("agent/src/llmPlanner/planner.ts", "utf8");
  const chain = readFileSync("src/lib/server/multiProvider/chainRunner.ts", "utf8");
  const wording = readFileSync("src/lib/releaseWording.ts", "utf8");
  const releaseText = readFileSync("src/lib/releaseText.ts", "utf8");
  const adapter = readFileSync("src/lib/server/tregAdapter.ts", "utf8");
  const mission = readFileSync("agent/src/runMission.ts", "utf8");
  const TRUSTED = ["releaseReason", "switchedOffAr", "PEOPLE_SETTLEMENT_UNAVAILABLE_AR", "capErrorMsg", "emptyErrorAr", "partialCorruptMsg", "mismatchMsg", "reportLostMsg", "uploadFailReason", "avFailReason", "finalCauseAr"];

  it("T7 every release call passes a trusted text and the job's own N", () => {
    const calls = [...route.matchAll(/executeReleaseConfirmation\(adminClient, jobId, ([A-Za-z_]+), ([A-Za-z_]+)\)/g)];
    expect(calls).toHaveLength(11);
    for (const c of calls) {
      expect(TRUSTED).toContain(c[1]);
      expect(c[2]).toBe("claimTargetN");
    }
    expect(route.match(/executeReleaseConfirmation\(/g)).toHaveLength(12); // the 11 calls and the definition
  });

  it("T7 the trusted texts are never built from an error object", () => {
    for (const id of TRUSTED.filter((x) => x !== "finalCauseAr")) {
      const start = route.indexOf(`const ${id} =`);
      if (start < 0) {
        expect(route, id).toMatch(new RegExp(`import[^;]*\\b${id}\\b`)); // imported: a reviewed constant of another module
        continue;
      }
      const def = route.slice(start, route.indexOf(";\n", start));
      expect(def, id).not.toMatch(/\berr\b|\.message\b|\berror\.|\bdetail\b/);
    }
  });

  it("T7 the release call keeps its argument names and order; the fifth-failure text is a conditional text write", () => {
    expect(route).toMatch(/rpc\("release_job_atomic", \{\s*p_job_id: jobId,\s*p_error_message: textAr,\s*p_force: true,\s*\}\)/);
    expect(route).toContain('.update({ error_message: finalAr }).eq("id", jobId).eq("status", "failed").eq("error_message", expected).select("id")');
    expect(route).not.toContain("فشل غير متوقع");
  });

  it("T7 probeStep has no private counter; the L1 loop shares one primary budget; each downstream call has its own fresh 6", () => {
    expect(planner).not.toMatch(/let calls\b/);
    expect(planner).toContain("probeStep(step, options, parent, deps, { left: MAX_PROBES_PER_STEP }, trace)");
    expect(planner).toContain("probeStep(step, [next], null, deps, { left: MAX_PROBES_PER_STEP })");
    expect(planner).toContain("probeStep(step, [webOption], null, deps, { left: MAX_PROBES_PER_STEP })");
    expect(planner).toContain("probeStep(step, [fcOption], null, deps, { left: MAX_PROBES_PER_STEP })");
    expect(planner.match(/\{ left: MAX_PROBES_PER_STEP \}/g)).toHaveLength(4); // the primary budget and the three fresh budgets
  });

  it("T7 money pins: chainRunner.ts keeps its budget line exactly once", () => {
    const line = "  const budget = Number(input.unitPricePoints) > 0 ? reserveForUnits(params.count, Number(input.unitPricePoints)) / 5500 : estimate.budgetUsd;";
    expect(chain.split("\n").filter((l) => l === line)).toHaveLength(1);
  });

  it("T7 (V-6) releaseWording.ts keeps its single import and never reaches releaseText.ts; releaseText.ts does not define stripRetryPrefix", () => {
    expect(wording.split("\n").filter((l) => l.startsWith("import "))).toEqual(['import { pointsAr } from "./pointsFormat";']);
    expect(wording).not.toContain("releaseText");
    expect(releaseText).not.toContain("stripRetryPrefix");
  });

  it("T7 FIX-1 releaseText.ts admits adapter reasons from the three chain failure reasons only and no longer reads ALL_CUSTOMER_STRINGS", () => {
    expect(releaseText).not.toContain("ALL_CUSTOMER_STRINGS");
    expect(releaseText).toContain('chainFailureReasonAr("spend"), chainFailureReasonAr("cursor"), chainFailureReasonAr("lease")');
  });

  it("T7 (V-7, V-4) the adapter's composed sentence is the reviewed one exactly once, and the old settlement sentence is gone from runMission.ts", () => {
    const composed = "errorMessageAr: `${PROVIDER_INCOMPATIBLE_ANSWER_AR}؛ تم إيقاف الطلب: حجز مؤقت مُحرَّر.`,";
    expect(adapter.split(composed)).toHaveLength(2);
    expect(mission).not.toContain("راجع المشرف ولم يُخصم رصيد إضافي");
  });
});
