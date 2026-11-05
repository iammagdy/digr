import { formatAr } from "../../arabicDigits";
import { pointsAr } from "../../pointsFormat";
import { countedAr } from "./countAr";

/**
 * STAGE B: THE WORDS OF THE EDIT REQUEST (client-safe: no server module, no price logic). The server answers views (the version, what changes, the units, the estimate and the hold it computed); this file only turns them into Arabic.
 * The browser never computes a price: the points shown are the points the server sent. Arabic only, Arabic-Indic numerals, no provider, no USD, no id, no emoji. Nothing here says «done», «paid» or «reserved»: until the customer approves, nothing has moved.
 */
export type EditChangeView =
  | { kind: "rename_column"; sheet: string; from: string; to: string }
  | { kind: "set_cells"; sheet: string; /** The cells the customer typed a value for. */ cells: number; columns: string[] }
  | { kind: "add_rows"; sheet: string; rows: number };

/** An edit request that WAITS for approval: stored `plan_ready`, nothing held, nothing charged. */
export interface EditRequestView {
  id: string;
  /** The version being edited (the latest). */
  version: number;
  /** The version the edit will create. */
  newVersion: number;
  change: EditChangeView;
  units: number;
  /** The estimate and the most that may be held, priced by code on the server. */
  estimatePoints: number;
  holdPoints: number;
  status: "plan_ready";
}

export type EditQuoteView =
  | { state: "offer"; version: number; newVersion: number; change: EditChangeView; units: number; estimatePoints: number; holdPoints: number }
  /** The edit needs a NEW LOOKUP (no safe recipe and no lookup price yet), or would need a row removed: no price is shown. `cells`: how many cells a review fix would cover. */
  | { state: "unsupported"; version: number; why: "lookup_needed" | "duplicates"; cells?: number }
  | { state: "rejected"; version: number; messageAr: string }
  | { state: "blocked" | "not_latest" | "already_edited" | "too_large"; version: number };

/** The latest published version, the sheets and their editable columns (never the id columns), and how many items each sheet has. No item id, no value, no path. */
export interface EditSchemaView { version: number; sheets: Array<{ name: string; columns: string[]; items: number }> }

export type EditKind = "rename_column" | "set_cells" | "add_rows" | "add_column";
export const EDIT_KINDS_AR: Readonly<Record<EditKind, string>> = {
  rename_column: "تغيير اسم عمود",
  set_cells: "تصحيح خانات بقيم أكتبها",
  add_rows: "إضافة عناصر جديدة",
  add_column: "إضافة عمود جديد",
};

/**
 * AUDIT D5: the kinds the page OFFERS. «add_column» needs a new lookup of values that nothing in the repository can price or run, so the server answers it «unsupported» («غير متاح بعد») every time: a selectable option that can never be completed is a dead control. It stays
 * in the type and the labels (the server contract and its tests), and returns to this list the day a re-read recipe and its price exist.
 */
export const OFFERED_EDIT_KINDS: ReadonlyArray<EditKind> = ["rename_column", "set_cells", "add_rows"];

export const EDIT_HEADING_AR = "تعديل الملف";
export const EDIT_LOADING_AR = "جارٍ تحميل خيارات التعديل…";
export const EDIT_ASKING_AR = "جارٍ حساب التكلفة…";
export const EDIT_ASK_BUTTON_AR = "احسب تكلفة التعديل";
export const EDIT_PREPARE_BUTTON_AR = "تجهيز طلب التعديل";
export const EDIT_PREPARING_AR = "جارٍ تجهيز الطلب…";
export const EDIT_CANCEL_BUTTON_AR = "إلغاء الطلب";
export const EDIT_CANCELLING_AR = "جارٍ إلغاء الطلب…";
export const EDIT_RETRY_AR = "إعادة المحاولة";
export const EDIT_INTRO_AR = "اطلب تغييرًا في ملفك. يُحفظ كل تعديل نسخةً جديدة، وتبقى النسخ السابقة كما هي. اعرف التكلفة أولًا؛ لا يُحجز ولا يُخصم شيء قبل أن تعتمد.";
export const EDIT_NOT_MOVED_AR = "لم يُحجز ولم يُخصم من رصيدك أي شيء قبل أن تعتمد الطلب.";
const NOT_MOVED_SHORT_AR = "لم يُحجز ولم يُخصم من رصيدك أي شيء.";
export const EDIT_CANCELLED_AR = "أُلغي طلب التعديل. لم يُحجز ولم يُخصم من رصيدك أي شيء.";
export const editVersionAr = (version: number): string => `تعديل النسخة ${formatAr(version)}، وهي أحدث نسخة من ملفك.`;

/** The same sentences as the add-on rules' refusals (pinned equal by a test; this file must not import the money-side module). */
export const EDIT_REFUSALS_AR = {
  open_addon: "لديك طلب مفتوح على هذا الملف؛ أكمله أو ألغه أولًا.",
  not_latest_version: "اطلب التعديل على أحدث نسخة من الملف.",
  already_edited: "عُدّلت هذه النسخة من قبل؛ اطلب التعديل على النسخة الأحدث.",
  too_large: "هذا التعديل أكبر من الحد المسموح لطلب واحد؛ قسّمه إلى أجزاء أصغر. لم يُحجز شيء.",
  unsupported: "هذا النوع من التعديل يحتاج إلى بحث جديد عن القيم، وهو غير متاح بعد. لم يُحجز ولم يُخصم شيء.",
} as const;

/** What the customer is told when a request cannot be made or cancelled: plain Arabic, no code, no id, no path, no provider. */
export const EDIT_ERRORS_AR = {
  not_found: "لم نجد هذا الملف أو هذا الطلب.",
  changed: "تغيّرت حالة الطلب قبل أن نلغيه. حدّث الصفحة وحاول مرة أخرى.",
  unavailable: "تعذّر تجهيز الطلب الآن. حاول بعد قليل. لم يُحجز ولم يُخصم شيء.",
  damaged: "تعذّر قراءة هذه النسخة. تواصل معنا إذا تكرر ذلك. لم يُحجز ولم يُخصم شيء.",
  unauthorized: "انتهت جلستك. سجّل الدخول ثم حاول مرة أخرى.",
  network: "تعذّر الاتصال الآن. تحقق من اتصالك وحاول بعد قليل.",
} as const;

const cellsAr = (n: number): string => countedAr(n, { one: "خانة واحدة", two: "خانتين", few: "خانات", many: "خانة" });
const rowsAr = (n: number): string => countedAr(n, { one: "عنصر واحد", two: "عنصرين", few: "عناصر", many: "عنصرًا" });
const quoted = (xs: ReadonlyArray<string>): string => xs.map((x) => `«${x}»`).join("، ");

/** What will change, in one sentence. */
function changeAr(c: EditChangeView): string {
  switch (c.kind) {
    case "rename_column": return `تغيير اسم العمود «${c.from}» إلى «${c.to}» في ورقة «${c.sheet}».`;
    case "set_cells": return `تصحيح ${cellsAr(c.cells)} في ورقة «${c.sheet}» (الأعمدة: ${quoted(c.columns)}).`;
    case "add_rows": return `إضافة ${rowsAr(c.rows)} إلى ورقة «${c.sheet}».`;
  }
}
/** What the request covers: only what the customer typed, with no new lookup. */
function coverAr(c: EditChangeView): string {
  switch (c.kind) {
    case "rename_column": return "عمود واحد، بلا أي بحث جديد.";
    case "set_cells": return `${countedAr(c.cells, { one: "خانة واحدة كتبتَ قيمتها بنفسك", two: "خانتان كتبتَ قيمتيهما بنفسك", few: "خانات كتبتَ قيمها بنفسك", many: "خانة كتبتَ قيمها بنفسك" })}، بلا أي بحث جديد.`;
    case "add_rows": return `${countedAr(c.rows, { one: "عنصر واحد كتبتَ بياناته بنفسك", two: "عنصران كتبتَ بياناتهما بنفسك", few: "عناصر كتبتَ بياناتها بنفسك", many: "عنصرًا كتبتَ بياناته بنفسك" })}، بلا أي بحث جديد.`;
  }
}

/** The facts of an edit, in the order the customer needs them: which version, what changes, what it covers, what is made, that nothing is deleted, the estimate and the most that may be held. */
function factsAr(v: { version: number; newVersion: number; change: EditChangeView; estimatePoints: number; holdPoints: number }): string[] {
  return [
    `النسخة التي ستُعدَّل: النسخة ${formatAr(v.version)}`,
    `التغيير: ${changeAr(v.change)}`,
    `ما يغطيه الطلب: ${coverAr(v.change)}`,
    `سيُحفظ التعديل نسخةً جديدة هي النسخة ${formatAr(v.newVersion)}، وتبقى النسخة ${formatAr(v.version)} كما هي.`,
    "لن يُحذف أي عنصر من ملفك.",
    `التكلفة التقديرية: ${pointsAr(v.estimatePoints)}.`,
    `أقصى ما يمكن حجزه: ${pointsAr(v.holdPoints)}، ويُخصم ما يُنجز فقط.`,
  ];
}

/** The lines under «احسب تكلفة التعديل»: an offer (the facts, that nothing moved, that it is only a quote) or the one fact that stops it. */
export function editQuoteLinesAr(q: EditQuoteView): string[] {
  switch (q.state) {
    case "offer": return [...factsAr(q), EDIT_NOT_MOVED_AR, "هذا عرض سعر فقط؛ لم يبدأ أي تعديل."];
    case "unsupported":
      return q.why === "duplicates"
        ? ["لا نحذف أي عنصر من ملفك، ولذلك لا يوجد تصحيح تلقائي للتكرار.", NOT_MOVED_SHORT_AR]
        : [q.cells !== undefined ? `هذا التصحيح يغطي ${cellsAr(q.cells)} ويحتاج إلى بحث جديد عن القيم، وهو غير متاح بعد؛ لذلك لا نعرض له سعرًا.` : "هذا النوع من التعديل يحتاج إلى بحث جديد عن القيم، وهو غير متاح بعد؛ لذلك لا نعرض له سعرًا.", NOT_MOVED_SHORT_AR];
    case "rejected": return [q.messageAr, NOT_MOVED_SHORT_AR];
    case "blocked": return [EDIT_REFUSALS_AR.open_addon, NOT_MOVED_SHORT_AR];
    case "not_latest": return [EDIT_REFUSALS_AR.not_latest_version, NOT_MOVED_SHORT_AR];
    case "already_edited": return [EDIT_REFUSALS_AR.already_edited, NOT_MOVED_SHORT_AR];
    case "too_large": return [EDIT_REFUSALS_AR.too_large, NOT_MOVED_SHORT_AR];
  }
}

/** The lines of a waiting request: ready and waiting for approval, the facts, that nothing moved, and that nothing starts before approval. Never a success. */
export const editRequestLinesAr = (r: EditRequestView): string[] => ["طلب التعديل جاهز، وهو بانتظار اعتمادك.", ...factsAr(r), EDIT_NOT_MOVED_AR, "لن يبدأ التنفيذ قبل أن تعتمد."];
