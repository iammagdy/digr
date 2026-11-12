/**
 * THE CUSTOMER'S OWN BUSINESS, NOT NAMED (live evaluation round 9, D2: «محتاج معلومات عن منافسين شركتي»).
 *
 * A request about the customer's OWN company, brand, product, venue or account («شركتي», «البراند بتاعنا», «my company», «صفحتي») cannot be planned until the customer says WHICH one: no source can find «my company». Before this check the
 * request became a mission and the worker asked «ما اسم شركتك ونشاطها؟» on its card, after a mission had been created. Now the chat asks the question itself, in the conversation, and nothing is created.
 *
 * Pure (no database, no network, no clock). It only ever ASKS: it never refuses, narrows, prices or approves anything.
 *   - `selfReferenceOf(text)`: the kind of the first own-business reference in the text, or null;
 *   - `selfReferenceUnresolved(turns)`: the reference of the LATEST customer turn that names one, when neither that turn nor any later turn identifies it (a name, a sector, a link, «إحنا شركة …»);
 *   - `selfReferenceQuestionAr(kind)`: one natural Egyptian-Arabic question about what is missing.
 */
export type SelfReferenceKind = "company" | "brand" | "venue" | "account";

const normalize = (t: string): string =>
  t.replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").toLowerCase();

/** Arabic word boundaries (\b does not work on Arabic letters). */
const W = (alts: string) => new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${alts})(?=$|[^\\p{L}\\p{N}])`, "u");

const PATTERNS: ReadonlyArray<[SelfReferenceKind, RegExp]> = [
  ["company", W("شركتي|شركتنا|الشركه بتاعتي|الشركه بتاعتنا|مشروعي|مشروعنا|بيزنسي|البيزنس بتاعي|البيزنس بتاعنا|my company|our company|my business|our business|my startup|our startup|sherkety|sherkiti|sherketi|sherketna")],
  // not «منتجي» alone: it is also «the producers of» («منتجي الأفلام»)
  ["brand", W("براندي|البراند بتاعي|البراند بتاعنا|ماركتي|ماركتنا|منتجنا|منتجاتي|منتجاتنا|المنتج بتاعي|المنتج بتاعنا|my brand|our brand|my products?|our products?")],
  // not «فندقي» alone: it is also the adjective «hotel-» («قطاع فندقي»)
  ["venue", W("مطعمي|مطعمنا|فندقنا|الفندق بتاعي|الفندق بتاعنا|متجري|متجرنا|عيادتي|عيادتنا|الكافيه بتاعي|المحل بتاعي|المحل بتاعنا|my restaurant|our restaurant|my hotel|our hotel|my store|our store|my shop|our shop|my clinic")],
  ["account", W("صفحتي|صفحتنا|حسابي|حسابنا|قناتي|قناتنا|اكونتي|الاكونت بتاعي|الاكونت بتاعنا|الصفحه بتاعتي|الصفحه بتاعتنا|my page|our page|my account|our account|my channel|our channel")],
];

/**
 * Words that IDENTIFY the business (a name, a sector, a link, a description of themselves): with one of them in the same or a later turn the reference is resolved, and the model's reading goes on as before. Deliberately generous: a
 * missed identification only keeps today's path (the worker asks on the card); it never refuses anything.
 */
const IDENTIFIED = [
  W("اسمها|اسمه|اسمنا|اسمهم|اسم شركتي|اسم شركتنا|اسم البراند|اسم الصفحه|اسم القناه|اسم المطعم|اسم الفندق|اسم المحل"),
  W("احنا|نحن|انا شركه|بنشتغل|نشتغل|بنبيع|نبيع|نشاطنا|نشاطها|نشاطه|نشاطي|مجالنا|مجالها|مجاله|مجالي|في مجال|متخصصين|متخصصه|بتشتغل في|تعمل في|شركه|براند|ماركه|مطعم|فندق|عياده|متجر|محل|صفحه|قناه|حساب"),
  W("called|named|we are|we're|i run|i own|our company is|my company is|in the [a-z ]+ (?:industry|sector|market)"),
  /https?:\/\/|www\.|@[A-Za-z0-9_.]{2,}|[A-Za-z0-9-]+\.(?:com|net|org|eg|io|co|app|tech)\b/i,
];

/** Phrases where an own-business word means something else («متوسط حسابي»: the arithmetic mean). */
const NOT_OWN = /(?:متوسط|وسط) حسابي/gu;

export function selfReferenceOf(text: string): SelfReferenceKind | null {
  const t = normalize(text).replace(NOT_OWN, " ");
  for (const [kind, re] of PATTERNS) if (re.test(t)) return kind;
  return null;
}

/** The identification words of a text, after its own-business phrases are taken out («شركتي» must not count as the word «شركه»). */
function identifies(text: string): boolean {
  let t = normalize(text);
  for (const [, re] of PATTERNS) t = t.replace(new RegExp(re.source, "gu"), " ");
  return IDENTIFIED.some((re) => re.test(t));
}

/**
 * The own-business reference that nothing in the conversation identifies, or null. The latest customer turn that names one is the one that counts; it is resolved by identification words in that turn or by ANY later customer turn
 * (the customer answered something after it: the model reads the answer).
 */
export function selfReferenceUnresolved(turns: ReadonlyArray<string>): SelfReferenceKind | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const kind = selfReferenceOf(turns[i] ?? "");
    if (!kind) continue;
    if (i < turns.length - 1) return null;
    return identifies(turns[i] ?? "") ? null : kind;
  }
  return null;
}

/** One natural question in the chat, about the one thing that is missing. */
export function selfReferenceQuestionAr(kind: SelfReferenceKind): string {
  switch (kind) {
    case "company":
      return "عشان أجهّز طلبك صح: إيه اسم شركتك ونشاطها، وبتشتغلوا في أنهي مدينة أو سوق؟";
    case "brand":
      return "عشان أجهّز طلبك صح: إيه اسم البراند أو المنتج بتاعك ومجاله، وبتبيعوا في أنهي سوق؟";
    case "venue":
      return "عشان أجهّز طلبك صح: إيه اسم المكان بتاعك بالظبط، وفي أنهي مدينة؟";
    case "account":
      return "عشان أجهّز طلبك صح: إيه اسم الصفحة أو الحساب بتاعك أو رابطه، وعلى أنهي منصة؟";
  }
}
