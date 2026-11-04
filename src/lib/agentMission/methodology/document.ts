import { DATE_PRECISION_APPROX_AR, DATE_PRECISION_EXACT_AR, DATE_PRECISION_TITLE_AR } from "../relativeDates";
import { toArabicDigits } from "../../arabicDigits";
import { GENERIC_ITEM_NOUN, countAr } from "../itemNoun";
import type { WorkbookMethodology } from "./readWorkbook";

/**
 * THE DATA-COLLECTION METHODOLOGY DOCUMENT (round 21), built by code from the methodology the delivered file itself states (readWorkbook.ts) and the file's layout. Formal Arabic. White-label: it names the platforms and kinds of source the file already names, never a provider,
 * an endpoint, a price in dollars or a model's vendor. EVERY NUMBER IN IT IS A NUMBER OF THE DELIVERED FILE (its own lines, its counts table, its sheets' delivered records and date marks): the fixed sentences below carry no number at all, and the document has no date, no page
 * number and no count of its own. No model writes any of it, so nothing is rephrased and nothing can be added.
 */
export type DocBlock =
  | { kind: "label"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "table"; head: string[]; rows: string[][] };
export interface DocSection { heading: string; blocks: DocBlock[] }
export interface MethodologyDocument {
  title: string;
  /** What the request was, in a few words (the delivered file's title). */
  subtitle: string;
  sections: DocSection[];
}

export const METHODOLOGY_DOC_TITLE_AR = "منهجية جمع البيانات";
const ABOUT_AR = "يصف هذا المستند كيف جُمعت البيانات التي سُلّمت لك في ملف الإكسل الخاص بطلبك: ما طلبته، ومن أين قُرئت البيانات، وما بُحث عنه، وما قُرئ وما سُلّم وما استُبعد، وحدود هذا التسليم.";
const HONEST_AR = "كُتب هذا المستند آليًا من بيانات التسليم نفسها دون أي إضافة، وكل رقم فيه هو الرقم المثبت في ملف النتائج. وهو يوثّق جمع البيانات فقط، ولا يتضمن تصميم دراسة ولا عينة بحثية ولا تحليلًا إحصائيًا.";
const PRECISION_NOTE_AR = `عمود «${DATE_PRECISION_TITLE_AR}» يبيّن لكل تاريخ هل هو «${DATE_PRECISION_EXACT_AR}» (لحظة حقيقية ذكرها المصدر) أو «${DATE_PRECISION_APPROX_AR}» (حُسب من وقت نسبي ذكره المصدر، فهو تقريب لا لحظة محددة).`;

/** Which section each line of the file's methodology goes to (a line the table does not know goes to «تفاصيل أخرى»: nothing the file states is dropped). */
const GROUPS: Array<{ heading: string; labels: string[] }> = [
  { heading: "الطلب كما فُهم", labels: ["طلبك (بكلماتك)", "المنصات والمصادر المستخدمة"] },
  { heading: "ما بُحث عنه والفترة الزمنية", labels: ["ما بُحث عنه", "الفترة المطلوبة", "الفترة التي غطّتها النتائج"] },
  { heading: "خطوات الجمع والفحص", labels: ["المرشّحات المطبّقة", "إزالة المكرر", "كيف فُحصت الصلة بطلبك"] },
];
const COUNTER_LABEL = "عدّاد المصدر وما سُلّم";
const LIMITS_LABEL = "حدود هذا التسليم";
const CITATION_LABEL = "صيغة الاستشهاد المقترحة";
const REASONS_LABEL = "أسباب الاستبعاد";

/** A labelled list of the file: the label, then its line (one value) or its lines (several). */
const labelled = (label: string, values: string[]): DocBlock[] => [{ kind: "label", text: `${label}:` }, ...values.map((v): DocBlock => (values.length === 1 ? { kind: "paragraph", text: v } : { kind: "bullet", text: v }))];

export function buildMethodologyDocument(input: { methodology: WorkbookMethodology; subtitleAr: string }): MethodologyDocument {
  const m = input.methodology;
  const byLabel = new Map(m.items.map((i) => [i.label, i.values] as const));
  const used = new Set<string>();
  const sections: DocSection[] = [{ heading: "عن هذا المستند", blocks: [{ kind: "paragraph", text: ABOUT_AR }, { kind: "paragraph", text: HONEST_AR }] }];

  for (const g of GROUPS) {
    const blocks: DocBlock[] = [];
    for (const label of g.labels) {
      const values = byLabel.get(label);
      if (!values) continue;
      used.add(label);
      blocks.push(...labelled(label, values));
    }
    if (blocks.length > 0) sections.push({ heading: g.heading, blocks });
  }

  // the counts: the file's own table, the source's counter lines and the reasons for what was left out
  const counts: DocBlock[] = [];
  if (m.table.head.length > 0 && m.table.rows.length > 0) counts.push({ kind: "table", head: m.table.head, rows: m.table.rows });
  const counter = byLabel.get(COUNTER_LABEL);
  if (counter) { used.add(COUNTER_LABEL); counts.push(...labelled(COUNTER_LABEL, counter)); }
  if (m.reasons.length > 0) counts.push(...labelled(REASONS_LABEL, m.reasons));
  if (counts.length > 0) sections.push({ heading: "الأعداد المسلّمة", blocks: counts });

  const limits = byLabel.get(LIMITS_LABEL);
  if (limits) { used.add(LIMITS_LABEL); sections.push({ heading: LIMITS_LABEL, blocks: limits.map((l): DocBlock => (limits.length === 1 ? { kind: "paragraph", text: l } : { kind: "bullet", text: l })) }); }

  // the file's layout: its sheets with their delivered records and columns, and the date marks
  const layout: DocBlock[] = [];
  for (const s of m.sheets) {
    layout.push({ kind: "bullet", text: `ورقة «${s.name}»: ${s.rows === 0 ? "لا عناصر" : countAr(s.rows, GENERIC_ITEM_NOUN)}${s.columns.length > 0 ? `؛ أعمدتها: ${s.columns.join("، ")}` : ""}.` });
    if (s.precision) layout.push({ kind: "bullet", text: `دقة التواريخ في ورقة «${s.name}»: ${toArabicDigits(s.precision.approx)} «${DATE_PRECISION_APPROX_AR}» و${toArabicDigits(s.precision.exact)} «${DATE_PRECISION_EXACT_AR}».` });
  }
  if (m.sheets.some((s) => s.precision)) layout.push({ kind: "paragraph", text: PRECISION_NOTE_AR });
  if (layout.length > 0) sections.push({ heading: "ملف النتائج وعلاماته", blocks: layout });

  const rest = m.items.filter((i) => !used.has(i.label) && i.label !== CITATION_LABEL);
  if (rest.length > 0) sections.push({ heading: "تفاصيل أخرى", blocks: rest.flatMap((r) => labelled(r.label, r.values)) });
  const citation = byLabel.get(CITATION_LABEL);
  if (citation) sections.push({ heading: CITATION_LABEL, blocks: citation.map((c): DocBlock => ({ kind: "paragraph", text: c })) });
  return { title: METHODOLOGY_DOC_TITLE_AR, subtitle: input.subtitleAr, sections };
}

/** Every line of text the document draws, in order (the renderer draws exactly these). */
export function documentLines(doc: MethodologyDocument): string[] {
  const out: string[] = [doc.title, doc.subtitle];
  for (const s of doc.sections) {
    out.push(s.heading);
    for (const b of s.blocks) {
      if (b.kind === "table") out.push(...b.head, ...b.rows.flat());
      else out.push(b.text);
    }
  }
  return out.filter((l) => l !== "");
}
