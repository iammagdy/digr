import { formatAr, toArabicDigits } from "../arabicDigits";
import { countAr, knownItemNoun } from "./itemNoun";

/**
 * THE NAMES THE CUSTOMER SEES ON A MISSION'S FILES, built from the mission (never a generic «نتائج البحث»):
 *   file   = what + count + date, in Arabic, Arabic-Indic digits:   «تغريدات عن محمد صلاح - ٣٠٠ - ٢٨ أكتوبر ٢٠٢٦»
 *   sheet  = the stage's title cut at a WORD boundary within Excel's 31 characters (no cut letter, no half word)
 */
const AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
/** Characters a file name must not hold (Windows, macOS, a URL path). */
const FORBIDDEN_IN_FILE_NAME = /[\\/:*?"<>|\u0000-\u001f]/g;

/** «٢٨ أكتوبر ٢٠٢٦» (UTC, so the same date everywhere). */
export function arabicDateLabel(date: Date): string {
  return `${toArabicDigits(date.getUTCDate())} ${AR_MONTHS[date.getUTCMonth()]} ${toArabicDigits(date.getUTCFullYear())}`;
}

/** «التغريدات» -> «تغريدات», «تعليقات كل منشور» -> «تعليقات»: the plain noun of a stage title (leading «ال» dropped, only the first words kept). */
export function nounOfStageTitle(title: string): string {
  const words = String(title ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return "";
  const first = words[0].replace(/^ال(?=[؀-ۿ]{3,})/, "");
  // a title that starts with a known noun is that noun alone («التغريدات التي تذكر محمد صلاح» → «تغريدات», never «تغريدات التي»)
  if (knownItemNoun(words[0])) return first;
  // a title like «تعليقات كل منشور» is the noun and its owner: the noun stands for the file
  return /^(كل|لكل|من|في|على|عن)$/.test(words[1] ?? "") ? first : [first, ...words.slice(1, 2)].join(" ").trim();
}

/** The platforms a request names after «على / في / عبر» («على إكس», «في تيك توك», «على يوتيوب»): never part of a subject. */
const PLATFORM_WORD = "(?:إكس|اكس|x|تويتر|يوتيوب|فيسبوك|فيس\\s?بوك|انستجرام|إنستجرام|انستغرام|إنستغرام|تيك\\s?توك|لينكد\\s?إن|لينكدان|جوجل(?:\\s?ماب(?:س)?)?|خرائط\\s?جوجل|ماب(?:س)?|سناب(?:\\s?شات)?|تليجرام|تيليجرام)";
const PLATFORM_CUT = new RegExp(`\\s+(?:على|في|عبر|من\\s+على)\\s+${PLATFORM_WORD}(?=\\s|$|[،,.])`, "i");
/** Where a subject ends when the request goes on to details: a preposition that opens a new clause, a conjunction with «كل», a count. */
const SUBJECT_END = /\s+(?:في|على|مع|ومع|من|ومن|خلال|بين|بعد|عبر|و(?=كل)|وكل|ولكل|لكل)\s+/;
const stripPlatform = (text: string): string => text.split(PLATFORM_CUT)[0];

/** The name of the account, channel or page the request points at («من قناة أون سبورت على يوتيوب» → «أون سبورت», «من حساب محمد صلاح على إكس» → «محمد صلاح»). */
function accountSubject(requestText: string): string {
  // ROUND 37: «الحساب» in a LIST OF FIELDS the customer asks for («… وتاريخ النشر واسم الحساب وعدد المشاهدات») is a column, not an account the request names.
  // Live (mission msn_b56312efe3a41bef94a8): the words after it, «وعدد المشاهدات», became the subject and the file was named «٥ ريلز عن وعدد المشاهدات».
  // A noun that follows a field word (name, owner, link, count of …) names a column; only «من حساب X», «قناة X»… name a source.
  const m = /(?:^|\s)(?:من|لدى|عند|على|ل|لل)?\s*(?<!(?:اسم|أسماء|اسماء|صاحب|أصحاب|اصحاب|رابط|روابط|عدد|عنوان|وصف)\s+)(?:حساب|الحساب|قناة|القناة|صفحة|الصفحة|بروفايل|البروفايل|ملف|مستخدم)\s+([^،,.؟?!\n]{1,60})/.exec(requestText);
  if (!m) return "";
  return stripPlatform(m[1]).split(SUBJECT_END)[0].trim();
}

const LEADING_REQUEST_WORDS = /^(?:هات|هاتلي|هاتي|عايز|عايزة|عاوز|عاوزة|محتاج|محتاجة|ابغى|أبغى|أريد|اريد|اعمل|اعملي|جيب|جيبلي|ابحث|دور|اجمع|اجمعلي|لي|لى)$/;
const FILLER_WORDS = /^(?:آخر|اخر|أحدث|احدث|أول|اول|كل|من|عن|في|على|مع|و|ومن|ومع|لكل|حول|بخصوص)$/;

/** The subject of a stage title or a request when nothing names it: the words left after the verb, the count, the kind of item, the platform and the filler words. */
function residualSubject(text: string): string {
  const words = stripPlatform(String(text ?? "")).replace(/[«»"،,.؟?!:؛]/g, " ").split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (const w of words) {
    if (LEADING_REQUEST_WORDS.test(w) || FILLER_WORDS.test(w) || /^[0-9٠-٩]+$/.test(w) || knownItemNoun(w)) { if (kept.length > 0) break; continue; }
    if (/^(?:حساب|قناة|صفحة|الحساب|القناة|الصفحة)$/.test(w) && kept.length === 0) continue;
    kept.push(w);
    if (kept.length >= 4) break;
  }
  return kept.join(" ").trim();
}

/**
 * What the mission is ABOUT, short, ALWAYS when the request or the plan says anything about it: the first Arabic term of the relevance rule («محمد صلاح»), else the account, channel or page the request names («أون سبورت»), else the words after «عن» in the request,
 * else the place or business it names, else what is left of the first stage's title, else of the request. One function for every mission type (posts, comments, replies, reviews, companies, employees).
 */
export function subjectOfMission(input: { plan: { stages: Array<{ deliver: boolean; title_ar?: string; relevance?: { terms: string[]; subject_ar: string; entity?: boolean } }> }; requestText?: string | null }): string {
  return subjectInfo(input).text;
}

type SubjectInput = Parameters<typeof subjectOfMission>[0];
/**
 * ROUND 26 (item 8): an opinion request names its subject after a preposition: «رأي الناس في الذكاء الاصطناعي», «آراء الجمهور عن X», «كلام المستخدمين حول X».
 * The subject is the part after the preposition; the opinion phrase is never the title's subject.
 */
const OPINION_HEAD = /^(?:رأي|آراء|أراء|كلام|انطباعات|ردود\s+فعل|مشاعر|موقف|مواقف)\s+(?:ال)?(?:ناس|جمهور|مستخدمين|متابعين|عملاء|زبائن)\s+(?:في|عن|حول|تجاه|بخصوص|على)\s+(.+)$/;

/** The subject and whether it was read from what is left of a title or the request (a sector or a topic: «مقاولات»), which a noun takes without «عن» («شركات مقاولات»). */
function subjectInfo(input: SubjectInput): { text: string; residual: boolean } {
  const stage = [...input.plan.stages].reverse().find((s) => s.relevance) ?? null;
  if (stage?.relevance) {
    const arabic = stage.relevance.terms.find((t) => /[؀-ۿ]/.test(t) && !/[A-Za-z]/.test(t));
    if (arabic) return { text: arabic.trim(), residual: Boolean(stage.relevance.entity) };
    const words = stage.relevance.subject_ar.trim().split(/\s+/).slice(0, 3).join(" ");
    if (words) return { text: words, residual: false };
  }
  const request = String(input.requestText ?? "");
  const account = accountSubject(request);
  if (account) return { text: account, residual: false };
  const m = /(?:^|\s)(?:عن|حول|بخصوص)\s+([؀-ۿ0-9٠-٩A-Za-z][^،,.؟?!\n]{1,60})/.exec(request);
  if (m) {
    // ROUND 26 (item 8): «رأي الناس في الذكاء الاصطناعي» is about the second part: the opinion phrase is not the subject
    const rest = stripPlatform(m[1]).trim();
    const opinion = OPINION_HEAD.exec(rest);
    // the subject ends where the request goes on to details (a period, a count, a platform word)
    const cut = (opinion ? opinion[1] : rest).split(/\s+(?:في|على|مع|من|خلال|بين|بعد)\s+/)[0].trim();
    if (cut) return { text: cut, residual: false };
  }
  // ROUND 26 (item 8): a request that quotes its subject and has no «عن» («٢٠ تغريدة على X فيها "العاصمة الإدارية"»): the quoted words are the subject
  const quoted = /["“«]([^"”»\n]{2,60})["”»]/.exec(request);
  if (quoted && quoted[1].trim()) return { text: quoted[1].trim(), residual: false };
  // a request about a PLACE or a business names it without «عن» («تقييمات من جوجل ماب لمطعم كشري أبو طارق في القاهرة»): the name starts at the kind of place
  const place = /(?:^|\s)(?<!(?:كل|لكل)\s)(?:ل|لل)?((?:مطعم|مطاعم|كافيه|مقهى|فندق|محل|صيدلية|عيادة|مستشفى|مدرسة|جامعة|مول|بنك|شركة|معرض|مصنع|نادي)\s[^،,.؟?!\n]{1,60})/.exec(request);
  if (place) {
    const cut = place[1].split(/\s+(?:في|على|مع|من|خلال|بين|بعد|اللي|الذي)\s+/)[0].trim();
    if (cut) return { text: cut, residual: false };
  }
  // nothing names it: what the first stage's title says beyond its noun («آخر تغريدات محمد صلاح» → «محمد صلاح»), then the request's own words
  const root = input.plan.stages.find((s) => s.title_ar) ?? null;
  const text = (root?.title_ar ? residualSubject(root.title_ar) : "") || residualSubject(request);
  return { text, residual: true };
}

/** «١٠ تغريدات» / «تغريدة واحدة» / «تغريدتان» for a count and a noun of the stage title (the plural rules of itemNoun.ts); an unknown noun is the count and the noun. */
export function countPhraseAr(count: number, noun: string): string {
  const item = knownItemNoun(noun);
  return item ? countAr(count, item, { subject: true }) : `${formatAr(count)} ${noun}`;
}

/** The count phrase with the subject: «١٠ تغريدات عن الذكاء الاصطناعي»; an entity sector takes it with no «عن». */
function withCountAr(countPart: string, noun: string, info: { text: string; residual: boolean }): string {
  if (!info.text) return countPart;
  return info.residual && ENTITY_NOUN.test(noun) ? `${countPart} ${info.text}` : `${countPart} عن ${info.text}`;
}

/** The stage fields the title reads (a plan's stages, or the stored public plan's). */
type TitleStage = { deliver: boolean; title_ar: string; parent_key?: string | null; expected_rows?: number; planned_rows?: number; relevance?: { terms: string[]; subject_ar: string } };

/**
 * ROUND 27 (item 6): a request for videos or posts WITH THEIR COMMENTS AND REPLIES is named by its PARENT items, not by the count and the noun of the last stage:
 * «فيديوهان مع التعليقات والردود عن الذكاء الاصطناعي - ٤ نوفمبر ٢٠٢٦» (never «٣٢٢ ردًا عن ...»). The parents' count is the one the file holds for the first stage (`parentDelivered`), else the stage's planned rows.
 * Null when the plan is not of that shape (no delivered child stage, a child that is neither comments nor replies, a parent whose noun is unknown): the older rule then names the file.
 */
function withChildrenPhraseAr(stages: ReadonlyArray<TitleStage>, parentDelivered: number | null | undefined, info: { text: string; residual: boolean }): string | null {
  const delivering = stages.filter((s) => s.deliver);
  const parent = delivering.find((s) => !s.parent_key);
  const children = delivering.filter((s) => Boolean(s.parent_key));
  if (!parent || children.length === 0) return null;
  const kinds = new Set<string>();
  for (const c of children) {
    const kind = /^\s*(?:ال)?رد/.test(c.title_ar) ? "replies" : /تعليق/.test(c.title_ar) ? "comments" : null;
    if (!kind) return null;
    kinds.add(kind);
  }
  // a parent titled «آخر فيديوهات قناة ...» is named by its noun («فيديوهات»)
  const noun = nounOfStageTitle(parent.title_ar.replace(/^\s*(?:آخر|اخر|أحدث|احدث)\s+/, ""));
  if (!noun || !knownItemNoun(noun)) return null;
  const count = typeof parentDelivered === "number" && Number.isFinite(parentDelivered) && parentDelivered > 0 ? Math.floor(parentDelivered) : Math.max(0, Math.floor(Number(parent.expected_rows ?? parent.planned_rows) || 0));
  if (count <= 0) return null;
  const withWhat = kinds.has("comments") && kinds.has("replies") ? "التعليقات والردود" : kinds.has("comments") ? "التعليقات" : "الردود";
  return withCountAr(`${countPhraseAr(count, noun)} مع ${withWhat}`, noun, info);
}

/** The kinds of entity a sector names directly («شركات مقاولات», «مطاعم كشري»): the noun takes it with no «عن». */
const ENTITY_NOUN = /^(?:ال)?(?:شركات|شركة|مطاعم|مطعم|أماكن|اماكن|مكان|مصانع|مصنع|فنادق|فندق|محلات|محل)$/;
const phraseOf = (noun: string, info: { text: string; residual: boolean }): string => (info.residual && ENTITY_NOUN.test(noun) ? `${noun} ${info.text}` : `${noun} عن ${info.text}`);

/** The whole file name without its extension: «تغريدات عن محمد صلاح - ٣٠٠ - ٢٨ أكتوبر ٢٠٢٦». Never empty, never longer than 100 characters, no forbidden character. */
export function missionFileTitleAr(input: { plan: { stages: Array<TitleStage> }; requestText?: string | null; delivered: number; date: Date; /** ROUND 27: the parent items the file holds (the first stage), for a request with comments and replies. */ parentDelivered?: number | null }): string {
  const delivering = input.plan.stages.filter((s) => s.deliver);
  const last = delivering[delivering.length - 1];
  const noun = nounOfStageTitle(last?.title_ar ?? "") || "نتائج";
  const info = subjectInfo({ plan: input.plan, requestText: input.requestText });
  // ROUND 26 (item 8): the count with its noun leads («١٠ تغريدات عن الذكاء الاصطناعي - ٤ نوفمبر ٢٠٢٦»), never a bare count between the parts
  const what = withChildrenPhraseAr(input.plan.stages, input.parentDelivered, info) ?? withCountAr(countPhraseAr(Math.max(0, Math.floor(input.delivered)), noun), noun, info);
  const title = `${what} - ${arabicDateLabel(input.date)}`;
  return title.replace(FORBIDDEN_IN_FILE_NAME, " ").replace(/\s+/g, " ").trim().slice(0, 100).trim();
}

/**
 * ROUND 27 (item 6): «<what> - <day month year>», the form of the file's name since round 26 («١٠ تغريدات عن الذكاء الاصطناعي - ٤ نوفمبر ٢٠٢٦»). The older form had the count between the parts («<what> - ١٠ - <date>»). A stored name in the current form is THE name of the file,
 * in the download and in the methodology list alike (same words and same date, even when the request was made the day before it finished); an older one is built again from the mission by both.
 */
const CURRENT_TITLE_FORM = /^(?!.* - [٠-٩]+ - ).+ - [٠-٩]{1,2} \S+ [٠-٩]{4}$/;
export const isCurrentTitleForm = (name: string): boolean => CURRENT_TITLE_FORM.test(String(name ?? "").trim()) && /(?:^|\s)عن\s/.test(name);

export const EXCEL_SHEET_NAME_MAX = 31;

/** A word a phrase cannot end on («تغريدات عن الذكاء الاصطناعي في»): when a title is cut, these are dropped from its end. */
const DANGLING_LAST_WORD = new Set(["في", "عن", "من", "على", "إلى", "الى", "مع", "و", "أو", "او", "آخر", "خلال", "حول", "بين"]);

/** A sheet name Excel accepts, cut at a word boundary (and never on a dangling «في / عن / من»): at most 31 characters, none of [ ] : * ? / \, unique in the book (a number is added to a duplicate). */
export function wordBoundarySheetName(title: string, used: Set<string>, fallback: string): string {
  const clean = String(title || "").replace(/[\[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim();
  const fit = (text: string, max: number): string => {
    if ([...text].length <= max) return text;
    const words = text.split(" ");
    let out = "";
    let kept = 0;
    for (const w of words) {
      const next = out ? `${out} ${w}` : w;
      if ([...next].length > max) break;
      out = next;
      kept += 1;
    }
    // the title was cut: a phrase must not stop on a preposition or a conjunction, so those are taken off the end (at least one word stays)
    while (kept > 1 && DANGLING_LAST_WORD.has(words[kept - 1])) {
      kept -= 1;
      out = words.slice(0, kept).join(" ");
    }
    // a single word longer than the limit has no boundary to cut at: it is cut, and only then
    return out || [...text].slice(0, max).join("");
  };
  const base = fit(clean, EXCEL_SHEET_NAME_MAX) || fallback;
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n += 1) {
    const suffix = ` ${toArabicDigits(n)}`;
    name = `${fit(clean || fallback, EXCEL_SHEET_NAME_MAX - suffix.length)}${suffix}`;
  }
  used.add(name.toLowerCase());
  return name;
}


/** What the mission is, in a few words, for a notice or an e-mail: «تغريدات عن محمد صلاح» (the file name without its count and date); a mission with no plan (planning failed) is its request, shortened at a word boundary. */
export function missionTitleAr(input: { plan?: { stages: Array<TitleStage> } | null; parentDelivered?: number | null; requestText?: string | null; /** ROUND 26 (item 8): the count the title leads with (the delivered count); default: the planned rows of the delivered stages. */ delivered?: number | null }): string {
  if (input.plan && Array.isArray(input.plan.stages) && input.plan.stages.length > 0) {
    const delivering = input.plan.stages.filter((s) => s.deliver);
    const last = delivering[delivering.length - 1] ?? input.plan.stages[input.plan.stages.length - 1];
    const noun = nounOfStageTitle(last?.title_ar ?? "");
    const info = subjectInfo({ plan: input.plan, requestText: input.requestText });
    // ROUND 26 (item 8): the count of the delivered stages leads the title, with its noun
    const planned = input.plan.stages.filter((s) => s.deliver).reduce((n, s) => n + Math.max(0, Math.floor(Number((s as { expected_rows?: unknown }).expected_rows) || 0)), 0);
    const total = typeof input.delivered === "number" && Number.isFinite(input.delivered) ? Math.max(0, Math.floor(input.delivered)) : planned;
    // ROUND 27 (item 6): a request with comments and replies is named by its parents
    const withChildren = withChildrenPhraseAr(input.plan.stages, input.parentDelivered, info);
    if (withChildren) return withChildren.replace(FORBIDDEN_IN_FILE_NAME, " ").replace(/\s+/g, " ").trim();
    if (noun) return (total > 0 ? withCountAr(countPhraseAr(total, noun), noun, info) : info.text ? phraseOf(noun, info) : noun).replace(FORBIDDEN_IN_FILE_NAME, " ").replace(/\s+/g, " ").trim();
  }
  const words = String(input.requestText ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  let out = "";
  for (const w of words) { const next = out ? `${out} ${w}` : w; if ([...next].length > 48) break; out = next; }
  return toArabicDigits(out) || "مهمتك";
}

/** The characters a download name may not carry once it reaches a header or a path (the same set for every download). */
const FORBIDDEN_IN_DOWNLOAD = /[/\\?%*:|"<>]/g;

/**
 * THE ONE NAME A DOWNLOAD OF A MISSION'S FILE CARRIES, whichever way the customer reaches it (the completion panel, «طلباتي», the e-mail's link, the admin's link; the Excel and the CSV): the name stored with the file when it was delivered,
 * else the name built from the mission («تغريدات عن محمد صلاح - ٦٧ - ٢٩ أكتوبر ٢٠٢٦.xlsx»), and only for a mission that has no plan at all the file's own name. A generic «result.xlsx» is never what a customer saves.
 */
export function missionDownloadName(input: { files?: unknown; kind: string; plan?: { stages: Array<TitleStage> } | null; requestText?: string | null; deliveredUnits?: number | null; date?: Date | string | number | null }): string {
  const kind = String(input.kind ?? "").toLowerCase();
  const list = Array.isArray(input.files) ? (input.files as Array<Record<string, unknown>>) : [];
  const own = list.find((f) => f && String(f.kind ?? "").toLowerCase() === kind);
  const stored = typeof own?.download_name === "string" ? own.download_name.trim() : "";
  const strip = (name: string): string => name.replace(new RegExp(`\\.${kind}$`, "i"), "");
  // ROUND 27: a stored name that is not in the current form is built again from the mission (the methodology list does the same), so both carry the same words
  let title = stored && (isCurrentTitleForm(strip(stored)) || !(input.plan && Array.isArray(input.plan.stages) && input.plan.stages.length > 0)) ? strip(stored) : "";
  if (!title && input.plan && Array.isArray(input.plan.stages) && input.plan.stages.length > 0) {
    const when = new Date(input.date ?? Date.now());
    title = missionFileTitleAr({ plan: input.plan, requestText: input.requestText, delivered: Number(input.deliveredUnits) || 0, date: Number.isNaN(when.getTime()) ? new Date() : when });
  }
  if (!title) return typeof own?.name === "string" && own.name ? own.name : `result.${kind}`;
  return `${title}.${kind}`.replace(FORBIDDEN_IN_DOWNLOAD, "-").trim();
}
