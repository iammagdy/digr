import { normalizeDigits, toArabicDigits } from "./arabicDigits";

/**
 * THE EXAMPLE FORMS of the start page. A chip on the start page opens a small form with the few fields its request needs, filled with sensible defaults; the request text is BUILT from the
 * fields and sent only when the customer presses «أرسل». A click on a chip sends nothing and never carries a placeholder account: the account, the topic or the link is a required field the
 * customer fills in. The text is the same kind of sentence the planner already reads («أريد أحدث ٣٠ منشور من حساب @اسم على تيك توك خلال آخر ٣ أشهر»). Pure: no I/O.
 */
export type TemplateFieldKind = "text" | "textarea" | "number" | "select";

export interface TemplateField {
  id: string;
  labelAr: string;
  kind: TemplateFieldKind;
  /** The value the form starts with (a sensible default); empty for what only the customer knows (an account, a topic, a link). */
  defaultValue: string;
  /** An example of what to type, never a value that could be sent as it is. */
  placeholderAr?: string;
  helpAr?: string;
  required?: boolean;
  options?: ReadonlyArray<{ value: string; labelAr: string }>;
  min?: number;
  max?: number;
  /** A link the customer pastes: it must look like an address. */
  link?: boolean;
}

export type TemplateValues = Record<string, string>;

export interface TemplateForm {
  id: string;
  /** The short label of the chip. */
  chipAr: string;
  /** The title of the form card. */
  titleAr: string;
  fields: readonly TemplateField[];
  build: (values: TemplateValues) => string;
}

const PERIOD_OPTIONS = [
  { value: "آخر أسبوع", labelAr: "آخر أسبوع" },
  { value: "آخر شهر", labelAr: "آخر شهر" },
  { value: "آخر ٣ أشهر", labelAr: "آخر ٣ أشهر" },
  { value: "آخر ٦ أشهر", labelAr: "آخر ٦ أشهر" },
  { value: "", labelAr: "بدون فترة محددة" },
] as const;

const PLATFORM_LABEL: Record<string, string> = { x: "إكس", tiktok: "تيك توك", facebook: "فيسبوك", youtube: "يوتيوب" };
const ACCOUNT_WORD: Record<string, string> = { x: "حساب", tiktok: "حساب", facebook: "صفحة", youtube: "قناة" };

/** A whole number from what the customer typed (Arabic or Latin digits); the default when it is empty or not a number; kept inside the field's limits. */
export function wholeNumber(raw: string | undefined, fallback: number, min = 1, max = 100000): number {
  const n = Math.floor(Number(normalizeDigits(String(raw ?? "")).replace(/[^\d]/g, "")));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(min, Math.min(max, n));
}

const nAr = (n: number): string => toArabicDigits(n);
const clean = (s: string | undefined): string => String(s ?? "").replace(/\s+/g, " ").trim();
const periodPhrase = (period: string | undefined): string => (clean(period) ? ` خلال ${clean(period)}` : "");
const accountOf = (raw: string | undefined): string => {
  const v = clean(raw);
  return /^[A-Za-z0-9_.]+$/.test(v) ? `@${v}` : v;
};
const linesOf = (raw: string | undefined): string[] => String(raw ?? "").split(/[\n,،]+/).map((x) => accountOf(x)).filter(Boolean);

export const TEMPLATE_FORMS: readonly TemplateForm[] = [
  {
    id: "account_posts",
    chipAr: "منشورات حساب",
    titleAr: "منشورات حساب أو صفحة",
    fields: [
      { id: "platform", labelAr: "المنصة", kind: "select", defaultValue: "x", options: [{ value: "x", labelAr: "إكس" }, { value: "tiktok", labelAr: "تيك توك" }, { value: "facebook", labelAr: "فيسبوك" }, { value: "youtube", labelAr: "يوتيوب" }] },
      { id: "account", labelAr: "الحساب أو الصفحة", kind: "text", defaultValue: "", placeholderAr: "اكتب اسم الحساب أو رابط الصفحة", required: true },
      { id: "count", labelAr: "كم منشور؟", kind: "number", defaultValue: "٣٠", min: 1, max: 5000 },
      { id: "period", labelAr: "الفترة", kind: "select", defaultValue: "آخر ٣ أشهر", options: PERIOD_OPTIONS },
    ],
    build: (v) => `أريد أحدث ${nAr(wholeNumber(v.count, 30))} منشور من ${ACCOUNT_WORD[v.platform] ?? "حساب"} ${accountOf(v.account)} على ${PLATFORM_LABEL[v.platform] ?? "إكس"}${periodPhrase(v.period)}.`,
  },
  {
    id: "video_comments",
    chipAr: "تعليقات فيديو",
    titleAr: "تعليقات فيديو أو منشور بعينه",
    fields: [
      { id: "platform", labelAr: "المنصة", kind: "select", defaultValue: "youtube", options: [{ value: "youtube", labelAr: "يوتيوب" }, { value: "tiktok", labelAr: "تيك توك" }, { value: "facebook", labelAr: "فيسبوك" }] },
      { id: "link", labelAr: "رابط الفيديو أو المنشور", kind: "text", defaultValue: "", placeholderAr: "الصق الرابط هنا", required: true, link: true },
      { id: "count", labelAr: "كم تعليق؟", kind: "number", defaultValue: "٥٠", min: 1, max: 5000 },
    ],
    build: (v) => `أريد تعليقات ${v.platform === "facebook" ? "هذا المنشور" : "هذا الفيديو"} على ${PLATFORM_LABEL[v.platform] ?? "يوتيوب"}: ${clean(v.link)}، حتى ${nAr(wholeNumber(v.count, 50))} تعليق.`,
  },
  {
    id: "topic_tweets",
    chipAr: "تغريدات عن موضوع",
    titleAr: "تغريدات عن موضوع أو حدث",
    fields: [
      { id: "topic", labelAr: "الموضوع أو الحدث", kind: "text", defaultValue: "", placeholderAr: "اكتب الموضوع أو الكلمة المفتاحية", required: true },
      { id: "count", labelAr: "كم تغريدة؟", kind: "number", defaultValue: "١٠٠", min: 1, max: 5000 },
      { id: "period", labelAr: "الفترة", kind: "select", defaultValue: "آخر شهر", options: PERIOD_OPTIONS },
    ],
    build: (v) => `أريد ${nAr(wholeNumber(v.count, 100))} تغريدة عن ${clean(v.topic)} على إكس${periodPhrase(v.period)}.`,
  },
  {
    id: "facebook_topic",
    chipAr: "منشورات فيسبوك عن موضوع",
    titleAr: "منشورات فيسبوك عن موضوع",
    fields: [
      { id: "topic", labelAr: "الموضوع", kind: "text", defaultValue: "", placeholderAr: "اكتب الموضوع أو الكلمة المفتاحية", required: true },
      { id: "country", labelAr: "الدولة", kind: "text", defaultValue: "مصر", placeholderAr: "مثل: مصر" },
      { id: "count", labelAr: "كم منشور؟", kind: "number", defaultValue: "١٠٠", min: 1, max: 5000 },
      { id: "period", labelAr: "الفترة", kind: "select", defaultValue: "آخر ٣ أشهر", options: PERIOD_OPTIONS },
    ],
    build: (v) => `أريد ${nAr(wholeNumber(v.count, 100))} منشور وفيديو من فيسبوك عن ${clean(v.topic)}${clean(v.country) ? ` في ${clean(v.country)}` : ""}${periodPhrase(v.period)}.`,
  },
  {
    id: "companies",
    chipAr: "شركات وصناع قرار",
    titleAr: "شركات وصناع القرار فيها",
    fields: [
      { id: "activity", labelAr: "نوع النشاط", kind: "text", defaultValue: "", placeholderAr: "مثل: مقاولات، مصانع أغذية", required: true },
      { id: "country", labelAr: "الدولة", kind: "text", defaultValue: "مصر", placeholderAr: "مثل: مصر" },
      { id: "count", labelAr: "كم شركة؟", kind: "number", defaultValue: "٥٠", min: 1, max: 2000 },
      { id: "people", labelAr: "صناع القرار", kind: "select", defaultValue: "yes", options: [{ value: "yes", labelAr: "مع صناع القرار والبريد المهني والهاتف" }, { value: "no", labelAr: "الشركات فقط" }] },
    ],
    build: (v) => `أريد ${nAr(wholeNumber(v.count, 50))} شركة ${clean(v.activity)}${clean(v.country) ? ` في ${clean(v.country)}` : ""}${v.people === "no" ? "" : " مع صناع القرار والبريد المهني والهاتف"}.`,
  },
  {
    id: "top_videos_comments",
    chipAr: "أعلى فيديوهات قنوات وتعليقاتها",
    titleAr: "أعلى فيديوهات عدة قنوات مع تعليقاتها",
    fields: [
      { id: "platform", labelAr: "المنصة", kind: "select", defaultValue: "youtube", options: [{ value: "youtube", labelAr: "يوتيوب" }, { value: "tiktok", labelAr: "تيك توك" }] },
      { id: "accounts", labelAr: "القنوات أو الحسابات", kind: "textarea", defaultValue: "", placeholderAr: "اسم أو رابط في كل سطر", helpAr: "اكتب كل قناة في سطر.", required: true },
      { id: "videos", labelAr: "كم فيديو من كل قناة؟", kind: "number", defaultValue: "٥", min: 1, max: 50 },
      { id: "comments", labelAr: "كم تعليق في المجموع؟", kind: "number", defaultValue: "٢٠٠", min: 1, max: 5000 },
    ],
    build: (v) => {
      const list = linesOf(v.accounts);
      const word = v.platform === "tiktok" ? "حساب" : "قناة";
      return `أريد أعلى ${nAr(wholeNumber(v.videos, 5))} فيديوهات مشاهدة من كل ${word} من ${nAr(list.length || 1)} ${v.platform === "tiktok" ? "حسابات" : "قنوات"} ${list.join(" و")} على ${PLATFORM_LABEL[v.platform] ?? "يوتيوب"}، مع التعليقات حتى ${nAr(wholeNumber(v.comments, 200))} تعليق ورابط كل فيديو.`;
    },
  },
];

export const templateFormById = (id: string): TemplateForm | undefined => TEMPLATE_FORMS.find((t) => t.id === id);

/** The values a form starts with: every field's default. */
export function initialTemplateValues(form: TemplateForm): TemplateValues {
  return Object.fromEntries(form.fields.map((f) => [f.id, f.defaultValue]));
}

const looksLikeLink = (v: string): boolean => /^(?:https?:\/\/)?[^\s/]+\.[^\s/]{2,}(?:\/\S*)?$/i.test(v.trim());

/** What is missing before «أرسل» may be pressed, field by field, in plain Arabic (empty = ready). */
export function templateProblems(form: TemplateForm, values: TemplateValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of form.fields) {
    const v = clean(values[f.id]);
    if (f.required && !v) out[f.id] = "هذا الحقل مطلوب.";
    else if (f.link && v && !looksLikeLink(v)) out[f.id] = "اكتب رابطًا صحيحًا.";
  }
  return out;
}

/** The request text of a form, or null while a required field is missing: the text is built only from the fields and is what «أرسل» sends. */
export function buildTemplateRequest(form: TemplateForm, values: TemplateValues): string | null {
  if (Object.keys(templateProblems(form, values)).length > 0) return null;
  return form.build(values);
}
