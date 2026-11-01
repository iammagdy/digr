import { FIELD_LABEL_AR, uncoveredFields, type FieldClass, type SourceField } from "./fields";
import { isCompanyStage } from "./entities";
import { isPeopleStage, nameKeysOf } from "./people";

/**
 * THE REFERENCE OF AUDIT 2026-11 (docs/AUDIT-2026-11.md section 1), AS DATA. Every fix before this one was made against one live test and some undid an earlier one (role mailboxes removed, then wanted as the company e-mail; «verified only» then empty e-mails)
 * because no written reference existed for what each task type must deliver. This table is that reference: for each task type, the columns of the file, in order, and who fills each (the source's own field, a priced step, or code). Two readers use it:
 *   - the PLAN CHECK refuses a plan that drops a class the source gives (a company's phone and address, a place's phone, rating and review count): `contractIssuesFor`;
 *   - the plan's columns and the WORKBOOK BUILDER follow it: `withContractColumns` puts a company's and a decision maker's columns in the order and under the titles of the owner's hand-built sheet; the workbook adds the computed ones («م», the decision-maker marker, the notes).
 * Pure: no I/O, no model.
 */
export type TaskType = "companies_people" | "companies" | "posts" | "comments" | "places";
export type SheetRole = "company" | "person" | "item" | "child";
export type ContractClass =
  | "row_number" | "company_name" | "company_activity" | "company_website" | "company_email" | "company_phone"
  | "decision_maker_name" | "decision_maker_title" | "decision_maker_flag" | "person_email" | "person_phone" | "notes"
  | "parent_title" | "parent_link"
  | "place_name" | "place_address" | "place_phone" | "place_rating" | "place_reviews" | "place_link"
  | "text" | "date" | "link" | "author" | "engagement";

/** Who fills a column: the source's own field, a priced step of the job, or code (a sequence, a marker, a note computed from the delivered rows). */
export type ColumnFill = "source" | "step" | "code";
export interface ContractColumn { cls: ContractClass; title_ar: string; fill: ColumnFill }

const col = (cls: ContractClass, title_ar: string, fill: ColumnFill): ContractColumn => ({ cls, title_ar, fill });

export const ROW_NUMBER_TITLE_AR = "م";
export const COMPANY_NAME_TITLE_AR = "اسم الشركة";
export const COMPANY_EMAIL_TITLE_AR = "الإيميل العام للشركة";
export const COMPANY_EMAIL_STATUS_TITLE_AR = "حالة توثيق الإيميل العام للشركة";
export const COMPANY_PHONE_TITLE_AR = "هاتف المقر الرئيسي";
export const PERSON_NAME_TITLE_AR = "اسم صانع القرار";
export const PERSON_TITLE_TITLE_AR = "المسمى الوظيفي";
export const DECISION_MAKER_FLAG_TITLE_AR = "صانع قرار";
export const PERSON_EMAIL_TITLE_AR = "إيميل المسؤول المباشر";
export const PERSON_PHONE_TITLE_AR = "هاتف / محمول المسؤول";
export const NOTES_TITLE_AR = "ملاحظات";
/** The values of the decision-maker marker. */
export const DECISION_MAKER_YES_AR = "نعم";
export const DECISION_MAKER_NO_AR = "لا";
/** The note on a company whose delivered people hold no decision maker (the owner's own sentence). */
export const NO_DECISION_MAKERS_NOTE_AR = "لم نجد صناع قرار في هذه الشركة";
/** What a cell says when nothing was found for it (never an empty cell where a value was looked for). */
export const NOT_AVAILABLE_AR = "غير متوفر";

/** THE COMPANY SHEET of «companies and their decision makers»: the owner's columns 1 to 6 («الإيميل العام للشركة» and «هاتف المقر الرئيسي» are his top priority), then a note. */
export const COMPANY_SHEET_ORDER: ReadonlyArray<ContractColumn> = [
  col("row_number", ROW_NUMBER_TITLE_AR, "code"),
  col("company_name", COMPANY_NAME_TITLE_AR, "source"),
  col("company_activity", "النشاط والتخصص", "source"),
  col("company_website", "الموقع الإلكتروني", "source"),
  col("company_email", COMPANY_EMAIL_TITLE_AR, "step"),
  col("company_phone", COMPANY_PHONE_TITLE_AR, "source"),
  col("notes", NOTES_TITLE_AR, "code"),
];
/** THE PERSON SHEET: the owner's columns 7 to 11 (the marker «صانع قرار» sits right after the title; the notes are the last). */
export const PERSON_SHEET_ORDER: ReadonlyArray<ContractColumn> = [
  col("row_number", ROW_NUMBER_TITLE_AR, "code"),
  col("decision_maker_name", PERSON_NAME_TITLE_AR, "source"),
  col("decision_maker_title", PERSON_TITLE_TITLE_AR, "source"),
  col("decision_maker_flag", DECISION_MAKER_FLAG_TITLE_AR, "code"),
  col("person_email", PERSON_EMAIL_TITLE_AR, "step"),
  col("person_phone", PERSON_PHONE_TITLE_AR, "step"),
  col("notes", NOTES_TITLE_AR, "code"),
];
/** The owner's hand-built sheet, header by header (docs/AUDIT-2026-11.md section 1A): the reference every companies delivery is measured against. */
export const OWNER_SHEET_HEADERS_AR: ReadonlyArray<string> = ["م", "اسم الشركة", "النشاط والتخصص", "الموقع الإلكتروني", "الإيميل العام للشركة", "هاتف المقر الرئيسي", "اسم صانع القرار", "المسمى الوظيفي", "إيميل المسؤول المباشر", "هاتف / محمول المسؤول", "ملاحظات"];

export const TASK_CONTRACTS = {
  companies_people: { company: COMPANY_SHEET_ORDER as ContractColumn[], person: PERSON_SHEET_ORDER as ContractColumn[] },
  companies: { company: [col("company_name", COMPANY_NAME_TITLE_AR, "source"), col("company_website", "الموقع الإلكتروني", "source"), col("company_phone", COMPANY_PHONE_TITLE_AR, "source")] },
  posts: { item: [col("text", "النص", "source"), col("date", "التاريخ والوقت", "source"), col("link", "الرابط", "source"), col("author", "الحساب", "source"), col("engagement", "الإعجابات والمشاركات والمشاهدات كما يعطيها المصدر", "source")] },
  comments: {
    item: [col("text", "نص التعليق", "source"), col("author", "الكاتب", "source"), col("date", "التاريخ والوقت", "source"), col("engagement", "الإعجابات والردود", "source")],
    // the parent post or video, on EVERY comment row: zero orphan comments (workbook.ts reads this list)
    child: [col("parent_title", "نص المنشور أو عنوان الفيديو", "code"), col("parent_link", "رابط المنشور أو الفيديو", "code")],
  },
  places: { item: [col("place_name", "الاسم", "source"), col("place_address", "العنوان", "source"), col("place_phone", "الهاتف", "source"), col("place_rating", "التقييم", "source"), col("place_reviews", "عدد التقييمات", "source"), col("place_link", "رابط الخريطة", "source")] },
} satisfies Record<TaskType, Partial<Record<SheetRole, ContractColumn[]>>>;

export interface ContractStageLike { key: string; title_ar: string; parent_key: string | null; deliver: boolean; endpoint_id?: string; role_preference?: unknown; columns: ReadonlyArray<{ key: string; title_ar: string; kind?: string; status_of?: string; type_of?: string; computed?: string }> }

/** The task type of a plan, from its shape: a company stage with a delivered people stage under it; a company stage; a child stage of items (comments); a places search (by the capability of its source); else posts. */
export function contractTypeOf(stages: ReadonlyArray<Pick<ContractStageLike, "key" | "title_ar" | "parent_key" | "deliver" | "role_preference" | "endpoint_id">>, capabilityOf?: (endpointId: string) => string | null): TaskType {
  const delivered = stages.filter((s) => s.deliver);
  const people = delivered.find((s) => isPeopleStage(s));
  if (people) { const parent = stages.find((s) => s.key === people.parent_key); if (parent && parent.deliver && isCompanyStage(parent)) return "companies_people"; }
  if (delivered.some((s) => s.parent_key === null && isCompanyStage(s))) return "companies";
  if (delivered.some((s) => s.parent_key !== null && !isPeopleStage(s))) return "comments";
  if (delivered.some((s) => s.parent_key === null && isPlaceSource(s.endpoint_id, capabilityOf))) return "places";
  return "posts";
}

/** True when a source is a MAPS search (its items are places). */
export const isPlaceSource = (endpointId: string | undefined, capabilityOf?: (endpointId: string) => string | null): boolean => {
  if (!endpointId) return false;
  const cap = capabilityOf?.(endpointId) ?? null;
  return /(^|\.)(maps|places)(\.|$)/.test(cap ?? "") || /\.serp\.maps$|\.places\./.test(endpointId);
};

export type SourceStageKind = "company" | "place" | "other";
/** The field classes a source's page may give that the file MUST then hold, by what the stage lists. Everything else is the generic rule of fields.ts. */
const REQUIRED: Record<SourceStageKind, ReadonlyArray<FieldClass>> = {
  company: ["phone", "address", "email"],
  place: ["phone", "address", "rating", "review_count"],
  other: [],
};
export const requiredSourceClasses = (kind: SourceStageKind): FieldClass[] => [...REQUIRED[kind]];
/** The classes only a company or a place stage is checked for (the generic check never asks them of posts, comments or people). */
export const CONTRACT_ONLY_CLASSES: ReadonlyArray<FieldClass> = ["phone", "email", "address", "review_count"];

/**
 * THE CONTRACT CHECK OF A STAGE: the classes the contract requires for this kind of stage that the source's page gives and no column holds. One issue sentence (English, for the planner) naming each in Arabic with the source's own path; empty when nothing is missing.
 * A found value is never dropped: the plan is refused until a column holds it.
 */
export function contractIssuesFor(stage: { key: string; columns: ReadonlyArray<{ key: string; title_ar: string }> }, fields: ReadonlyArray<SourceField>, kind: SourceStageKind): string[] {
  const required = new Set(requiredSourceClasses(kind));
  if (required.size === 0) return [];
  const missing = uncoveredFields(fields.filter((f) => required.has(f.cls)), stage.columns);
  if (missing.length === 0) return [];
  return [`stage «${stage.key}»: the reference for ${kind === "company" ? "a companies delivery" : "a places delivery"} requires every contact field the source gives, and no column holds: ${missing.map((f) => `${FIELD_LABEL_AR[f.cls]} (${f.path})`).join(", ")}. Add a column for each (map it in your run_code, with an Arabic title like «${FIELD_LABEL_AR[missing[0].cls]}»): a value the source gave is never dropped from the customer's file`];
}

// ------------------------------------------------------------------------------------------------ the columns of a plan, by the table

type Col = ContractStageLike["columns"][number];

/** How an existing column is recognised for a contract class (its key or its Arabic title). The first match in the stage's own order wins. */
const RECOGNISE: Partial<Record<ContractClass, { key: RegExp; title: RegExp; not?: RegExp }>> = {
  company_name: { key: /^(name|company|companyname|company_name|title)$/i, title: /^(ال)?(شركة|اسم)/, not: /لينكد|موقع|رابط/ },
  company_activity: { key: /(industry|sector|activity|category|specialt|description|nature)/i, title: /(قطاع|نشاط|تخصص|مجال|وصف)/ },
  company_website: { key: /(website|domain|site)(_?url)?$|^url$|^web$/i, title: /(موقع|ويب)/, not: /linkedin|facebook|twitter|instagram|لينكد/i },
  company_phone: { key: /(phone|tel|mobile)/i, title: /(هاتف|تليفون|موبايل|محمول)/, not: /status|حالة|type|نوع/i },
  company_email: { key: /mail/i, title: /(إيميل|ايميل|بريد)/, not: /status|حالة/i },
  decision_maker_title: { key: /^(job_?title|jobtitle|title|position|role|designation|headline)$/i, title: /(مسمى|وظيف)/ },
};

const findBy = (cols: ReadonlyArray<Col>, cls: ContractClass, taken: Set<string>): Col | undefined => {
  const r = RECOGNISE[cls];
  if (!r) return undefined;
  return cols.find((c) => !taken.has(c.key) && !(c.status_of || c.type_of || c.computed) && !(r.not && (r.not.test(c.key) || r.not.test(c.title_ar))) && (r.key.test(c.key) || r.title.test(c.title_ar.trim())));
};

const statusKeyOf = (key: string): string => `${key}_status`;

/**
 * THE PLAN'S COLUMNS IN THE REFERENCE'S ORDER AND UNDER ITS TITLES, for «companies and their decision makers» only (the other task types keep the planner's columns; the check above guards what the source gives). The planner's keys are kept (the mapping, the finder steps and
 * the engine still fill them); only titles and the order change, and the code-owned columns are added: the company's e-mail with its status, the decision-maker marker, the notes. Idempotent. Returns the stages as given for any other plan.
 */
export function withContractColumns<S extends ContractStageLike>(stages: ReadonlyArray<S>): S[] {
  if (contractTypeOf(stages) !== "companies_people") return [...stages];
  const people = stages.filter((s) => s.deliver && isPeopleStage(s) && stages.some((p) => p.key === s.parent_key && p.deliver && isCompanyStage(p)));
  const companyKeys = new Set(people.map((p) => p.parent_key));
  return stages.map((st) => {
    if (companyKeys.has(st.key) && st.parent_key === null) return { ...st, columns: companyColumns(st.columns) } as S;
    if (people.includes(st)) return { ...st, columns: personColumns(st) } as S;
    return st;
  });
}

function companyColumns(own: ReadonlyArray<Col>): Col[] {
  const taken = new Set<string>();
  const pick = (cls: ContractClass, title: string, fallbackKey: string | null, extra: Partial<Col> = {}): Col[] => {
    const found = findBy(own, cls, taken);
    if (found) { taken.add(found.key); return [{ ...found, title_ar: title, ...extra }]; }
    return fallbackKey ? [{ key: fallbackKey, title_ar: title, ...extra }] : [];
  };
  const name = pick("company_name", COMPANY_NAME_TITLE_AR, null);
  const activity = pick("company_activity", "النشاط والتخصص", null);
  const website = pick("company_website", "الموقع الإلكتروني", null);
  const emailCols = pick("company_email", COMPANY_EMAIL_TITLE_AR, "company_email");
  const emailKey = emailCols[0].key;
  const emailStatus: Col = { ...(own.find((c) => c.status_of === emailKey) ?? { key: statusKeyOf(emailKey), title_ar: COMPANY_EMAIL_STATUS_TITLE_AR }), title_ar: COMPANY_EMAIL_STATUS_TITLE_AR, status_of: emailKey };
  taken.add(emailStatus.key);
  const phone = pick("company_phone", COMPANY_PHONE_TITLE_AR, "company_phone");
  const notesOwn = own.find((c) => c.computed === "notes");
  const notes: Col = { ...(notesOwn ?? { key: "notes_ar", title_ar: NOTES_TITLE_AR }), title_ar: NOTES_TITLE_AR, computed: "notes" };
  const used = new Set([...name, ...activity, ...website, ...emailCols, emailStatus, ...phone, notes].map((c) => c.key));
  const rest = own.filter((c) => !used.has(c.key));
  return [...name, ...activity, ...website, ...emailCols, emailStatus, ...phone, ...rest, notes];
}

function personColumns(stage: ContractStageLike): Col[] {
  const own = stage.columns;
  const manager = (stage.role_preference as { role?: string } | undefined)?.role === "manager";
  const used = new Set<string>();
  const claim = (c: Col | undefined, patch: Partial<Col>): Col[] => { if (!c) return []; used.add(c.key); return [{ ...c, ...patch }]; };
  const nameKeys = nameKeysOf(own);
  const nameCol = nameKeys.length === 1 ? own.find((c) => c.key === nameKeys[0]) : undefined;
  const titleCol = findBy(own.filter((c) => c.key !== nameCol?.key), "decision_maker_title", used);
  const emailCol = own.find((c) => c.kind === "work_email");
  const phoneCol = own.find((c) => c.kind === "phone");
  const name = claim(nameCol, manager ? { title_ar: PERSON_NAME_TITLE_AR } : {});
  const title = claim(titleCol, manager ? { title_ar: PERSON_TITLE_TITLE_AR } : {});
  const flag = manager ? [{ ...(own.find((c) => c.computed === "decision_maker") ?? { key: "decision_maker", title_ar: DECISION_MAKER_FLAG_TITLE_AR }), title_ar: DECISION_MAKER_FLAG_TITLE_AR, computed: "decision_maker" } as Col] : [];
  for (const f of flag) used.add(f.key);
  const withStatus = (c: Col | undefined, title: string): Col[] => {
    if (!c) return [];
    used.add(c.key);
    const out: Col[] = [{ ...c, title_ar: title }];
    const status = own.find((x) => x.status_of === c.key);
    if (status) { used.add(status.key); out.push({ ...status, title_ar: `حالة توثيق ${title}` }); }
    const type = own.find((x) => x.type_of === c.key);
    if (type) { used.add(type.key); out.push(type); }
    return out;
  };
  const email = withStatus(emailCol, manager ? PERSON_EMAIL_TITLE_AR : emailCol?.title_ar ?? "");
  const phone = withStatus(phoneCol, manager ? PERSON_PHONE_TITLE_AR : phoneCol?.title_ar ?? "");
  const notesOwn = own.find((c) => c.computed === "notes");
  const notes: Col = { ...(notesOwn ?? { key: "notes_ar", title_ar: NOTES_TITLE_AR }), title_ar: NOTES_TITLE_AR, computed: "notes" };
  used.add(notes.key);
  const rest = own.filter((c) => !used.has(c.key));
  return manager ? [...name, ...title, ...flag, ...email, ...phone, ...rest, notes] : [...name, ...title, ...email, ...phone, ...rest, notes];
}

/** A column the workbook computes from the delivered rows (the decision-maker marker, the notes) instead of reading it from a row. */
export const isComputedColumn = (c: { computed?: string }): boolean => c.computed !== undefined;
