import { toArabicDigits } from "@/lib/arabicDigits";
import { fmtInt, fmtRate } from "../format";
import { RATE_MAX_E4, RATE_MIN_E4, parseScaled } from "../money";
import type { Currency } from "../types";
import { cleanText } from "../validate";
import type { Action, Counts } from "./actions";
import type { SectorCount } from "./types";

/**
 * THE CONVERSATION after the files are counted. Plain Arabic, one question at a time, tappable answers where possible. Everything here is CODE: the questions, the parsing of
 * «٢٠٠٠ جنيه», the choice of what to bill, and the list of actions that follows. The model is not called after the files are read, and it never computes money:
 * the answers become the same validated actions as ever (set_counts, set_rate, set_client, set_target_total, set_unit_price), run by the one executor, shown before/after,
 * and applied only on «تمام».
 *
 * THE OWNER'S BILLING MODEL: a manager is ONE billable item (the person with whatever contact data was found: title, e-mail, phones); manager e-mails and phones are NOT billed as
 * separate items; a company's general e-mails and phones are part of the company item. Departments («إدارة المشتريات») are a separate, optional line at price 0.
 */
export type Bill = "companies" | "managers" | "both";
export type DeptChoice = "zero" | "manager" | "none";
export type RateAnswer = { kind: "saved" } | { kind: "typed"; rateE4: number };

export interface FlowState {
  /** contact ids the owner moved to the other list (person <-> department) */
  moved: string[];
  bill: Bill | null;
  dept: DeptChoice | null;
  /** «default» = his usual prices; «target» = a grand total he named */
  price: "unset" | "default" | "target";
  target: { currency: Currency; text: string } | null;
  /** an amount typed without a currency: the next question asks which */
  pendingAmount: string | null;
  rate: RateAnswer | null;
  /** «none» = no client; a name otherwise */
  client: "unset" | "none" | { name: string };
}
export const newFlow = (): FlowState => ({ moved: [], bill: null, dept: null, price: "unset", target: null, pendingAmount: null, rate: null, client: "unset" });

export interface FlowCtx {
  sectors: SectorCount[];
  docType: "invoice" | "quote" | "statement";
  /** the document's exchange rate now (EGP per USD x 10,000), or null when none is typed or saved */
  rateE4: number | null;
  showUsd: boolean; showPoints: boolean; showEgp: boolean;
  clientName: string;
  /** the manager's current unit price in dollars as typed text («0.35»), for «بسعر المدير»; null when unknown */
  managerUnitUsdText: string | null;
}

// ---------------------------------------------------------------- counts after the owner's moves

export interface Effective { sector: string; companies: number; managers: number; departments: number }
export function effective(s: SectorCount, moved: readonly string[]): Effective {
  const m = new Set(moved);
  let managers = 0, departments = 0;
  for (const c of s.contacts) {
    const kind = m.has(c.id) ? (c.kind === "person" ? "department" : "person") : c.kind;
    if (kind === "person") managers += 1; else departments += 1;
  }
  return { sector: s.sector, companies: s.companies, managers, departments };
}
export const totalsOf = (ctx: Pick<FlowCtx, "sectors">, moved: readonly string[]): { companies: number; managers: number; departments: number } =>
  ctx.sectors.map((s) => effective(s, moved)).reduce((a, e) => ({ companies: a.companies + e.companies, managers: a.managers + e.managers, departments: a.departments + e.departments }), { companies: 0, managers: 0, departments: 0 });

/** «لقيت: كهروميكانيكا ٢٠٠ شركة و٦٠١ مدير، بترول ١٤٩ شركة و٢٣٩ مدير و٣٢ جهة إدارية.» */
export function summaryText(ctx: Pick<FlowCtx, "sectors">, moved: readonly string[], duplicateCompanies: number): string {
  const parts = ctx.sectors.map((s) => {
    const e = effective(s, moved);
    const bits = [e.companies > 0 ? `${fmtInt(e.companies)} شركة` : "", e.managers > 0 ? `${fmtInt(e.managers)} مدير` : "", e.departments > 0 ? `${fmtInt(e.departments)} جهة إدارية` : ""].filter(Boolean);
    return `${s.sector} ${bits.join(" و") || "بدون أعداد"}`;
  });
  return `لقيت: ${parts.join("، ")}.${duplicateCompanies > 0 ? ` تم تجاهل ${fmtInt(duplicateCompanies)} تكرار.` : ""}`;
}

export function effectiveBill(state: FlowState, ctx: Pick<FlowCtx, "sectors">): Bill | null {
  if (state.bill) return state.bill;
  const t = totalsOf(ctx, state.moved);
  if (t.companies > 0 && t.managers === 0) return "companies";
  if (t.managers > 0 && t.companies === 0) return "managers";
  return null;
}

// ---------------------------------------------------------------- questions

export interface Chip { label: string; value: string }
export type QuestionId = "bill" | "dept" | "price" | "currency" | "rate" | "client";
export interface Question { id: QuestionId; text: string; chips: Chip[]; input?: { kind: "money" | "rate" | "text"; placeholder: string } }

const usdInvolved = (state: FlowState, ctx: FlowCtx): boolean => ctx.showUsd || state.target?.currency === "usd" || state.pendingAmount === "usd";
const nonUsdInvolved = (state: FlowState, ctx: FlowCtx): boolean => ctx.showEgp || ctx.showPoints || (state.target !== null && state.target.currency !== "usd");

/** the next question, or null when everything needed is known */
export function nextQuestion(state: FlowState, ctx: FlowCtx): Question | null {
  const bill = effectiveBill(state, ctx);
  const t = totalsOf(ctx, state.moved);
  if (bill === null) return { id: "bill", text: "هتحاسب على إيه؟", chips: [{ label: "الشركات", value: "companies" }, { label: "المديرين", value: "managers" }, { label: "الشركات والمديرين", value: "both" }] };
  if (bill !== "companies" && t.departments > 0 && state.dept === null) {
    return { id: "dept", text: `فيه ${fmtInt(t.departments)} جهة إدارية (زي «إدارة المشتريات»). أضيفها إزاي؟`, chips: [{ label: "بسعر صفر", value: "zero" }, { label: "بسعر المدير", value: "manager" }, { label: "من غير", value: "none" }] };
  }
  if (ctx.docType === "statement") return state.client === "unset" && ctx.clientName === "" ? clientQuestion() : null; // a data statement has no prices, no rate
  if (state.pendingAmount !== null) return { id: "currency", text: `${toArabicDigits(state.pendingAmount)} إيه؟`, chips: [{ label: "جنيه", value: "egp" }, { label: "نقاط", value: "points" }, { label: "دولار", value: "usd" }] };
  if (state.price === "unset") {
    return { id: "price", text: "عايز الإجمالي يبقى كام؟ ولا أستخدم أسعارك العادية؟", chips: [{ label: "أسعاري العادية", value: "default" }], input: { kind: "money", placeholder: "مثال: ٢٠٠٠ جنيه" } };
  }
  // the rate: when none is known and something needs it, or when dollars are involved (one tap if it is saved)
  if (state.rate === null && ((ctx.rateE4 === null && nonUsdInvolved(state, ctx)) || usdInvolved(state, ctx))) {
    const chips = ctx.rateE4 !== null ? [{ label: `استخدم ${fmtRate(ctx.rateE4)}`, value: "saved" }] : [];
    return { id: "rate", text: "سعر الدولار النهارده كام؟", chips, input: { kind: "rate", placeholder: "مثال: ٥٦.٥" } };
  }
  if (state.client === "unset" && ctx.clientName === "") return clientQuestion();
  return null;
}
const clientQuestion = (): Question => ({ id: "client", text: "تحب الفاتورة باسم شركة معينة ولا من غير عميل؟", chips: [{ label: "من غير عميل", value: "none" }], input: { kind: "text", placeholder: "اسم الشركة العميلة" } });

// ---------------------------------------------------------------- answers

export function answerChip(state: FlowState, id: QuestionId, value: string): FlowState {
  switch (id) {
    case "bill": return value === "companies" || value === "managers" || value === "both" ? { ...state, bill: value } : state;
    case "dept": return value === "zero" || value === "manager" || value === "none" ? { ...state, dept: value } : state;
    case "price": return value === "default" ? { ...state, price: "default", target: null } : state;
    case "currency": return state.pendingAmount !== null && (value === "egp" || value === "points" || value === "usd") ? { ...state, price: "target", target: { currency: value, text: state.pendingAmount }, pendingAmount: null } : state;
    case "rate": return value === "saved" ? { ...state, rate: { kind: "saved" } } : state;
    case "client": return value === "none" ? { ...state, client: "none" } : state;
  }
}

/** «٢٠٠٠ جنيه», «2,000 ج.م», «٥٠٠ نقطة», «١٧ دولار», «$17», «جنيه ٢٠٠٠»; a bare number asks for its currency. Code only, no model. */
export function parseMoneyAnswer(text: string): { kind: "ok"; currency: Currency; amountText: string } | { kind: "needs_currency"; amountText: string } | { kind: "bad" } {
  const ascii = String(text ?? "").replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/٬/g, "").replace(/٫/g, ".").trim();
  const num = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/.exec(ascii);
  if (!num) return { kind: "bad" };
  const amountText = num[1].replace(/,/g, "");
  const rest = ascii.replace(num[0], " ").toLowerCase();
  const currency: Currency | null = /(جنيه|جنية|جنيها|ج\.?\s?م|egp|\ble\b|£)/.test(rest) ? "egp" : /(نقطة|نقاط|نقطه|points?|pts)/.test(rest) ? "points" : /(دولار|\$|usd|dollar)/.test(rest) ? "usd" : null;
  if (rest.replace(/(جنيه|جنية|جنيها|ج\.?\s?م|egp|le|£|نقطة|نقاط|نقطه|points?|pts|دولار|\$|usd|dollars?|ال|و|بس|حوالي|تقريبا|تقريبًا)/g, "").replace(/[\s.،,:؛-]/g, "") !== "") return { kind: "bad" }; // other words: not an amount
  if (currency === null) return { kind: "needs_currency", amountText };
  if (currency === "points" && amountText.includes(".")) return { kind: "bad" };
  if (parseScaled(amountText, currency === "points" ? 0 : 2) === null || Number(amountText) <= 0) return { kind: "bad" };
  return { kind: "ok", currency, amountText };
}

export type TextAnswer = { ok: true; state: FlowState } | { ok: false; error: string };

export function answerText(state: FlowState, id: QuestionId, text: string): TextAnswer {
  if (id === "price") {
    const r = parseMoneyAnswer(text);
    if (r.kind === "bad") return { ok: false, error: "ما فهمتش المبلغ. اكتب رقم وبعده جنيه أو نقاط أو دولار، مثل «٢٠٠٠ جنيه»." };
    if (r.kind === "needs_currency") return { ok: true, state: { ...state, pendingAmount: r.amountText } };
    return { ok: true, state: { ...state, price: "target", target: { currency: r.currency, text: r.amountText }, pendingAmount: null } };
  }
  if (id === "rate") {
    const ascii = text.trim();
    const e4 = parseScaled(ascii, 4);
    if (e4 === null || e4 < RATE_MIN_E4 || e4 > RATE_MAX_E4) return { ok: false, error: "سعر الصرف غير مفهوم. اكتب رقمًا مثل ٥٦ أو ٥٦.٥." };
    return { ok: true, state: { ...state, rate: { kind: "typed", rateE4: e4 } } };
  }
  if (id === "client") {
    const name = cleanText(text).replace(/\s+/g, " ");
    if (name === "" || name.length > 120) return { ok: false, error: "اكتب اسم الشركة العميلة (حتى ١٢٠ حرفًا)، أو اختر «من غير عميل»." };
    return { ok: true, state: { ...state, client: { name } } };
  }
  return { ok: false, error: "اختار إجابة من الأزرار." };
}

/** move one contact between the people and the departments list */
export const moveContact = (state: FlowState, id: string): FlowState => ({ ...state, moved: state.moved.includes(id) ? state.moved.filter((x) => x !== id) : [...state.moved, id] });

// ---------------------------------------------------------------- the actions that follow

/** What the draft will get, as the validated actions the one executor runs. Emails and phones are never billed here. */
export function buildFlowActions(state: FlowState, ctx: FlowCtx): Action[] {
  const bill = effectiveBill(state, ctx) ?? "both";
  const actions: Action[] = [];
  let departments = 0;
  for (const s of ctx.sectors) {
    const e = effective(s, state.moved);
    const counts: Counts = {};
    if (bill !== "managers" && e.companies > 0) counts.company = e.companies;
    if (bill !== "companies" && e.managers > 0) counts.manager = e.managers;
    if (bill !== "companies" && state.dept !== "none" && e.departments > 0) { counts.department = e.departments; departments += e.departments; }
    if (Object.keys(counts).length) actions.push({ type: "set_counts", sector: s.sector, counts });
  }
  if (state.dept === "manager" && departments > 0 && ctx.managerUnitUsdText) actions.push({ type: "set_unit_price", itemType: "department", unit: "usd", text: ctx.managerUnitUsdText });
  if (state.rate?.kind === "typed") actions.push({ type: "set_rate", rateE4: state.rate.rateE4 });
  if (typeof state.client === "object") actions.push({ type: "set_client", name: state.client.name });
  if (state.price === "target" && state.target) actions.push({ type: "set_target_total", currency: state.target.currency, text: state.target.text });
  return actions;
}

/** what the owner already said in his first message (the model's actions): no question is asked twice */
export function prefillFromActions(state: FlowState, actions: Action[]): { state: FlowState; rest: Action[] } {
  let next = state;
  const rest: Action[] = [];
  for (const a of actions) {
    if (a.type === "set_rate") next = { ...next, rate: { kind: "typed", rateE4: a.rateE4 } };
    else if (a.type === "set_target_total") next = { ...next, price: "target", target: { currency: a.currency, text: a.text }, pendingAmount: null };
    else if (a.type === "set_client") next = { ...next, client: { name: a.name } };
    else rest.push(a);
  }
  return { state: next, rest };
}
