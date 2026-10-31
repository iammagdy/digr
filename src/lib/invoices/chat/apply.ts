import { toArabicDigits } from "@/lib/arabicDigits";
import { fmtEgp, fmtInt, fmtPoints, fmtRate, fmtUnitUsd, fmtUsd } from "../format";
import { formToPreview, unitErrors, type DocForm } from "../form";
import { MAX_LINES, formatScaled, parseScaled } from "../money";
import { parseUnitPoints, parseUnitUsd, unitUsdText } from "../priceInput";
import { QUICK_TYPE_NAMES, addSector, countText, quickFields, removeSector, renameSector, setCount, type ItemTypeLite } from "../sectors";
import { totalsForDoc } from "../totals";
import type { Currency } from "../types";
import { isMoneyAction, type Action, type CountKey } from "./actions";
import { normSector } from "./count";
import { solveTargetTotal, targetMinorOf } from "./targetTotal";

/**
 * Executes the model's validated ACTIONS on the builder's draft, with the existing money library. A pure function: it returns a NEW form plus a plain-Arabic account
 * (what was done, what was refused and why) and the grand total before and after. Nothing is saved here; the builder shows the account and, for any action that
 * changes money, waits for the owner's «تمام» before it takes the new form.
 */
export interface ApplyCtx { types: ItemTypeLite[]; creditValueE4: number; canChangeDocType: boolean }
export interface TotalSnap { usd: number; points: number | null; egp: number | null; shown: Currency[]; statement: boolean; text: string[] }
export interface ApplyOutcome {
  form: DocForm;
  applied: string[];
  refused: string[];
  warnings: string[];
  moneyChanged: boolean;
  before: TotalSnap;
  after: TotalSnap;
  /** the owner asked for N pages: the builder fits it with the real page measurement */
  fitPages: number | null;
  /** a session-only display option (the saved document always keeps its summary table) */
  phaseSummary: boolean | null;
  changed: boolean;
}

const COUNT_NAME: Record<CountKey, string> = { company: "شركة", manager: "مدير", email: "بريد إلكتروني", phone: "رقم هاتف" };
const CUR_AR: Record<Currency, string> = { usd: "دولار", points: "نقطة", egp: "جنيه" };
const base = (creditValueE4: number) => ({ id: null, number: "", status: "draft" as const, revision: 1, creditValueE4, instapayAddress: "" });

/** the grand total in every currency the document shows, from the same money library the sheet uses */
export function snapshot(form: DocForm, creditValueE4: number): TotalSnap {
  const doc = formToPreview(form, base(creditValueE4));
  const statement = doc.docType === "statement";
  const t = totalsForDoc(doc).total;
  const shown: Currency[] = statement ? [] : (["usd", "points", "egp"] as const).filter((c) => doc.show[c]);
  const text = shown.map((c) => (c === "usd" ? `${fmtUsd(t.usd)} دولار` : c === "points" ? `${fmtPoints(t.points ?? 0)} نقطة` : `${fmtEgp(t.egp ?? 0)} جنيه`));
  return { usd: t.usd, points: t.points, egp: t.egp, shown, statement, text };
}

const sameSnap = (a: TotalSnap, b: TotalSnap): boolean => a.usd === b.usd && a.points === b.points && a.egp === b.egp && a.shown.join() === b.shown.join() && a.statement === b.statement;

/** a sector by name: exact (alef/ya/spacing-insensitive), else the only sector that contains the words */
export function findSector(form: DocForm, name: string): { key: string; title: string } | null {
  const n = normSector(name);
  const exact = form.batches.find((b) => normSector(b.title) === n);
  if (exact) return { key: exact.key, title: exact.title };
  const loose = form.batches.filter((b) => n !== "" && (normSector(b.title).includes(n) || n.includes(normSector(b.title))) && normSector(b.title) !== "");
  return loose.length === 1 ? { key: loose[0].key, title: loose[0].title } : null;
}

const countsPhrase = (counts: Partial<Record<CountKey, number>>): string =>
  (Object.keys(COUNT_NAME) as CountKey[]).filter((k) => counts[k] !== undefined).map((k) => `${fmtInt(counts[k] as number)} ${COUNT_NAME[k]}`).join("، ");

/** The item type a name or key refers to (company/شركة…, or any active type by its name). */
function resolveType(types: ItemTypeLite[], key: string): ItemTypeLite | null {
  const alias: Record<string, string> = { company: "شركة", companies: "شركة", manager: "مدير", managers: "مدير", email: "بريد إلكتروني", emails: "بريد إلكتروني", phone: "رقم هاتف", phones: "رقم هاتف" };
  const wanted = (alias[key.trim().toLowerCase()] ?? key).trim();
  return types.find((t) => t.nameAr.trim() === wanted) ?? null;
}

export function applyActions(input: DocForm, actions: Action[], ctx: ApplyCtx, lineIds: ReadonlyMap<string, string>): ApplyOutcome {
  let form = input;
  const applied: string[] = [], refused: string[] = [], warnings: string[] = [];
  const before = snapshot(input, ctx.creditValueE4);
  let fitPages: number | null = null;
  let phaseSummary: boolean | null = null;
  const priceOverride = new Map<string, number>(); // item type id -> unit price (hundredths of a cent) the owner asked for in this reply
  const quick = quickFields(ctx.types);
  const statement = () => form.docType === "statement";
  const rateE4 = () => (form.rate.trim() === "" ? null : parseScaled(form.rate, 4));

  const reprice = () => {
    if (!priceOverride.size) return;
    form = { ...form, lines: form.lines.map((l) => (l.itemTypeId && priceOverride.has(l.itemTypeId) ? { ...l, unit: unitUsdText(priceOverride.get(l.itemTypeId) as number) } : l)) };
  };
  const putCounts = (batchKey: string, counts: Partial<Record<CountKey, number>>): string | null => {
    for (const k of Object.keys(counts) as CountKey[]) {
      const type = quick.find((q) => q.name === COUNT_NAME[k])?.type;
      if (!type) return `نوع البند «${COUNT_NAME[k]}» غير موجود في «أنواع البنود».`;
      if (form.lines.length >= MAX_LINES && !form.lines.some((l) => l.batchKey === batchKey && l.itemTypeId === type.id)) return "وصلت للحد الأقصى من البنود في الوثيقة.";
      form = setCount(form, batchKey, type, String(counts[k]));
    }
    reprice();
    return null;
  };

  for (const a of actions) {
    switch (a.type) {
      case "set_rate": {
        if (statement()) { refused.push("بيان البيانات بدون أسعار ولا سعر صرف."); break; }
        form = { ...form, rate: formatScaled(a.rateE4, 4) };
        applied.push(`سعر الصرف: ١ دولار = ${fmtRate(a.rateE4)} جنيه (لهذه الوثيقة).`);
        if (!form.showPoints && !form.showEgp) warnings.push("النقاط والجنيه غير معروضين الآن، فلن يظهر السعر في الوثيقة حتى تفعّلهما.");
        break;
      }
      case "set_currencies": {
        if (statement()) { refused.push("بيان البيانات بدون عملات."); break; }
        const next = { showUsd: a.usd ?? form.showUsd, showPoints: a.points ?? form.showPoints, showEgp: a.egp ?? form.showEgp };
        if (!next.showUsd && !next.showPoints && !next.showEgp) { refused.push("لازم تبقى عملة واحدة على الأقل ظاهرة."); break; }
        form = { ...form, ...next };
        applied.push(`العملات المعروضة: ${(["usd", "points", "egp"] as const).filter((c) => (c === "usd" ? next.showUsd : c === "points" ? next.showPoints : next.showEgp)).map((c) => (c === "usd" ? "دولار" : c === "points" ? "نقاط" : "جنيه")).join("، ")}.`);
        if ((next.showPoints || next.showEgp) && rateE4() === null) warnings.push("اكتب سعر الصرف حتى تظهر النقاط والجنيه.");
        break;
      }
      case "add_sector": case "set_counts": {
        const name = a.type === "add_sector" ? a.name : a.sector;
        let found = findSector(form, name);
        let created = false;
        if (!found) { form = addSector(form, name); const b = form.batches[form.batches.length - 1]; if (form.batches.length > 0 && b.title === name) { found = { key: b.key, title: b.title }; created = true; } }
        if (!found) { refused.push(`وصلت للحد الأقصى من القطاعات (٥٠).`); break; }
        const err = putCounts(found.key, a.counts);
        if (err) { refused.push(err); break; }
        applied.push(`${created ? "قطاع جديد" : "قطاع"} «${found.title}»: ${countsPhrase(a.counts)}.`);
        break;
      }
      case "set_unit_price": {
        if (statement()) { refused.push("بيان البيانات بدون أسعار."); break; }
        const type = resolveType(ctx.types, a.itemType);
        if (!type) { refused.push(`ما لقيتش نوع بند اسمه «${a.itemType}».`); break; }
        const r = a.unit === "usd" ? parseUnitUsd(a.text) : parseUnitPoints(a.text, rateE4(), ctx.creditValueE4);
        if (!r.ok) { refused.push(`سعر ${type.nameAr}: ${r.error}`); break; }
        priceOverride.set(type.id, r.cc);
        reprice();
        const asked = a.unit === "points" ? `${toArabicDigits(a.text)} نقطة = ` : "";
        applied.push(`سعر ${type.nameAr} للوحدة: ${asked}${fmtUnitUsd(r.cc)} دولار (في كل البنود من هذا النوع).`);
        if (!form.lines.some((l) => l.itemTypeId === type.id)) warnings.push(`لا توجد بنود «${type.nameAr}» في المسودة بعد؛ السعر يُطبَّق على ما يُضاف في هذه الرسالة فقط.`);
        break;
      }
      case "set_target_total": {
        if (statement()) { refused.push("بيان البيانات بدون إجمالي."); break; }
        const errs = unitErrors(form);
        if (Object.keys(errs).length) { refused.push("في سعر غير صالح في المسودة؛ أصلحه أولًا ثم اطلب الإجمالي."); break; }
        const target = targetMinorOf(a.text, a.currency);
        if (target === null) { refused.push("المبلغ المطلوب غير صالح."); break; }
        // asking for a total in a currency implies showing it: it is switched on, but only if the whole action succeeds (a refusal changes nothing)
        const flag = a.currency === "usd" ? "showUsd" : a.currency === "points" ? "showPoints" : "showEgp";
        const turnedOn = !form[flag];
        const working: DocForm = turnedOn ? { ...form, [flag]: true } : form;
        const doc = formToPreview(working, base(ctx.creditValueE4));
        const r = solveTargetTotal(doc.lines.map((l) => ({ quantity: l.quantity, unitCc: l.unitCc })), doc, a.currency, target);
        if (!r.ok) { refused.push(r.error); break; }
        form = { ...working, lines: working.lines.map((l, i) => (r.units[i] !== doc.lines[i].unitCc ? { ...l, unit: unitUsdText(r.units[i]) } : l)) };
        if (turnedOn) applied.push(`فعّلت عرض ${CUR_AR[a.currency]} في الوثيقة لأنك طلبت إجمالي بها.`);
        const fmt = (n: number) => (a.currency === "usd" ? `${fmtUsd(n)} دولار` : a.currency === "points" ? `${fmtPoints(n)} نقطة` : `${fmtEgp(n)} جنيه`);
        applied.push(r.exact
          ? `الإجمالي صار ${fmt(r.achievedMinor)} تمامًا؛ عدّلت أسعار الوحدة بنفس النسبة (${fmtInt(r.changedLines)} بند).`
          : `ما قدرتش أوصل لـ ${fmt(r.targetMinor)} بالظبط بسبب التقريب (كل بند يُقرَّب للسنت أولًا). أقرب إجمالي ممكن ${fmt(r.achievedMinor)}.`);
        if (!r.exact) warnings.push("الإجمالي المعروض هو أقرب إجمالي ممكن، وليس المطلوب بالظبط.");
        break;
      }
      case "set_discount": {
        if (statement()) { refused.push("بيان البيانات بدون خصم."); break; }
        if (a.kind === "none") { form = { ...form, discountKind: "none", discount: "" }; applied.push("أُلغي الخصم."); break; }
        form = { ...form, discountKind: a.kind, discount: a.text };
        applied.push(a.kind === "percent" ? `خصم ${toArabicDigits(a.text)}٪.` : `خصم ثابت ${toArabicDigits(a.text)} دولار.`);
        break;
      }
      case "set_doc_type": {
        if (!ctx.canChangeDocType) { refused.push("نوع الوثيقة لا يتغير بعد حفظها. أنشئ وثيقة جديدة."); break; }
        form = { ...form, docType: a.docType };
        applied.push(`نوع الوثيقة: ${a.docType === "invoice" ? "فاتورة" : a.docType === "quote" ? "عرض سعر" : "بيان بيانات (بدون أسعار)"}.`);
        break;
      }
      case "set_client": {
        form = { ...form, company: a.name, clientId: null };
        applied.push(`العميل: ${a.name}.`);
        break;
      }
      case "rename_sector": {
        const f = findSector(form, a.from);
        if (!f) { refused.push(`ما لقيتش قطاع اسمه «${a.from}».`); break; }
        if (form.batches.some((b) => b.key !== f.key && normSector(b.title) === normSector(a.to))) { refused.push(`فيه قطاع آخر اسمه «${a.to}» بالفعل.`); break; }
        form = renameSector(form, f.key, a.to);
        applied.push(`القطاع «${f.title}» صار «${a.to}».`);
        break;
      }
      case "remove_sector": {
        const f = findSector(form, a.sector);
        if (!f) { refused.push(`ما لقيتش قطاع اسمه «${a.sector}».`); break; }
        form = removeSector(form, f.key);
        applied.push(`حُذف قطاع «${f.title}» وبنوده.`);
        break;
      }
      case "set_layout": {
        if (a.unhideAll) {
          const n = form.lines.filter((l) => l.hidden).length;
          form = { ...form, lines: form.lines.map((l) => (l.hidden ? { ...l, hidden: false } : l)) };
          applied.push(n ? `أظهرت ${fmtInt(n)} بند كان مخفيًا؛ كل البنود صارت ظاهرة.` : "ما فيش بنود مخفية؛ كل البنود ظاهرة.");
        }
        if (a.hideLineIds?.length) {
          const keys = new Set(a.hideLineIds.map((id) => lineIds.get(id)).filter((k): k is string => Boolean(k)));
          form = { ...form, lines: form.lines.map((l) => (keys.has(l.key) ? { ...l, hidden: true } : l)) };
          applied.push(`أخفيت ${fmtInt(keys.size)} بند من الوثيقة (تُحسب في الإجمالي وتظهر في سطر «بنود أخرى»).`);
        }
        if (a.summaryOnlySectors?.length) {
          const found = a.summaryOnlySectors.map((n) => ({ n, f: findSector(form, n) }));
          const keys = new Set(found.filter((x) => x.f).map((x) => (x.f as { key: string }).key));
          form = { ...form, batches: form.batches.map((b) => (keys.has(b.key) ? { ...b, summaryOnly: true } : b)) };
          if (keys.size) applied.push(`عرض ${fmtInt(keys.size)} قطاع كملخص فقط (اسم وعدد وإجمالي).`);
          for (const x of found.filter((y) => !y.f)) refused.push(`ما لقيتش قطاع اسمه «${x.n}».`);
        }
        if (a.showPhaseSummary !== undefined) {
          phaseSummary = a.showPhaseSummary;
          applied.push(a.showPhaseSummary ? "ملخص المراحل ظاهر في الوثيقة بعد جدول البنود." : "أخفيت ملخص المراحل من العرض الحالي والتصدير فقط (الوثيقة المحفوظة تحتفظ به).");
        }
        if (a.maxPages !== undefined) { fitPages = a.maxPages; applied.push(`هضبط الوثيقة على ${a.maxPages === 1 ? "صفحة واحدة" : `${fmtInt(a.maxPages)} صفحات`} بعرض القطاعات الكبيرة كملخص.`); }
        break;
      }
    }
  }
  const after = snapshot(form, ctx.creditValueE4);
  return { form, applied, refused, warnings, moneyChanged: actions.some(isMoneyAction) && !sameSnap(before, after), before, after, fitPages, phaseSummary, changed: form !== input || fitPages !== null || phaseSummary !== null };
}

/** the net effect on the document: used to decide whether an action list needs the owner's «تمام» (it changes what the document adds up to or shows) */
export const needsConfirm = (actions: Action[], o: ApplyOutcome): boolean => actions.some(isMoneyAction) && (o.moneyChanged || actions.some((a) => a.type === "set_target_total" || a.type === "set_unit_price"));

// ---------- what the model is told about the draft: names and counts only, never a price or a total ----------

export interface DraftSummary {
  doc_type: string;
  currencies: { usd: boolean; points: boolean; egp: boolean };
  rate_set: boolean;
  discount: string;
  client: string;
  sectors: Array<{ name: string; summary_only: boolean; counts: Partial<Record<CountKey, number>> }>;
  lines: Array<{ id: string; sector: string; item_type: string; hidden: boolean }>;
  lines_listed: boolean;
}
export const MAX_LISTED_LINES = 150;

export function draftSummary(form: DocForm, types: ItemTypeLite[]): { summary: DraftSummary; lineIds: Map<string, string> } {
  const quick = quickFields(types);
  const sectors = form.batches.map((b) => {
    const counts: Partial<Record<CountKey, number>> = {};
    for (const [k, name] of Object.entries(COUNT_NAME) as Array<[CountKey, string]>) {
      const q = quick.find((x) => x.name === name);
      const n = q ? parseScaled(countText(form, b.key, q.type.id), 0) : null;
      if (n) counts[k] = n;
    }
    return { name: b.title, summary_only: b.summaryOnly, counts };
  });
  const lineIds = new Map<string, string>();
  const lines: DraftSummary["lines"] = [];
  const listed = form.lines.length <= MAX_LISTED_LINES;
  form.lines.forEach((l, i) => {
    const id = `L${i + 1}`;
    lineIds.set(id, l.key);
    if (listed) lines.push({ id, sector: form.batches.find((b) => b.key === l.batchKey)?.title ?? "", item_type: l.itemTypeName, hidden: l.hidden });
  });
  return {
    summary: { doc_type: form.docType, currencies: { usd: form.showUsd, points: form.showPoints, egp: form.showEgp }, rate_set: form.rate.trim() !== "", discount: form.discountKind, client: form.company, sectors, lines, lines_listed: listed },
    lineIds,
  };
}
export const QUICK_NAMES = QUICK_TYPE_NAMES;
