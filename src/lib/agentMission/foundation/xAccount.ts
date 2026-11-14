import { X_RESERVED_PATHS } from "../../socialTasks";

/**
 * P0, 14 NOV 2026 (msn_93ed6dea95edb303fd2b, msn_fefee20b5a4dfc1aafc2, msn_dd7c2e9c131b8783bf2e): AN X REQUEST THAT NAMES AN ACCOUNT IS SCOPED TO THAT ACCOUNT, OR IT IS NOT PRICED.
 *
 * The customer asked for the tweets of the Saudi Ministry of Health's official account. X's verified search card has no account input, so the named account was never written into the query: one plan searched
 * all of X for «الشائعات الصحية» (the one tweet delivered was another country's ministry), another searched all of X for «الشائعات فقط» (79 tweets from 38 other accounts, none the ministry's) and both were approved,
 * held, charged and closed as «the source gave no more results for this request».
 *
 * The rule, by code, with no model and no guess:
 *  - the account condition on X is the search operator `from:<username>` (documented by the provider's catalog entry for `anyapi.x.search.posts`: «operators like from:, since:, until: … work inline in the query»)
 *    AND an authoritative check of every row: a tweet is chosen, delivered and charged only when its own `username` (the source's `authorUsername`) IS that username (case-insensitive, nothing else: a display
 *    name, a fan account «SaudiMOH_fans» or a similar spelling is never the account);
 *  - the username is never guessed from an Arabic name («وزارة الصحة السعودية» is not a username). A request that names an account only by its name is asked ONCE, before anything is read, held or priced,
 *    for the username or the account link; the customer may instead choose, explicitly, to search all of X (the plan then says the results are not that account's), or cancel;
 *  - an answer that is neither ends the request honestly: nothing is read, held or charged.
 * Pure: no I/O.
 */

/** An X username: 1 to 15 letters, digits or «_». */
const USERNAME = /^[A-Za-z0-9_]{1,15}$/;
const clean = (v: unknown): string => String(v ?? "").replace(/[‎‏‪-‮⁦-⁩]/g, "").replace(/\s+/g, " ").trim();
const valid = (u: string): boolean => USERNAME.test(u) && !X_RESERVED_PATHS.has(u.toLowerCase());

/** The username of an x.com / twitter.com account link in the text, or null (a link to a tweet keeps its account: `x.com/<user>/status/<id>`). */
function linkHandleIn(text: string): string | null {
  const m = /(?:^|[\s(«"'])(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?=[/?#\s)»"']|$)/i.exec(text);
  return m && valid(m[1]) ? m[1] : null;
}

/** The username the customer wrote in the text (an account link, or «@username» standing alone), as written; null when none. An e-mail address is not a username. */
export function xHandleIn(text: unknown): string | null {
  const t = clean(text);
  const link = linkHandleIn(t);
  if (link) return link;
  const at = /(?:^|[\s(«"'،,:])@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_.@])/.exec(t);
  return at && valid(at[1]) ? at[1] : null;
}

/** The username a source text IS (the Ask's named source): «@SaudiMOH», «SaudiMOH», an account link. An Arabic name, or words that are not one username, give null. */
export function xHandleOfSource(sourceText: unknown): string | null {
  const t = clean(sourceText);
  if (t === "") return null;
  const link = linkHandleIn(t);
  if (link) return link;
  const bare = t.replace(/^@/, "");
  return /[A-Za-z]/.test(bare) && valid(bare) ? bare : null;
}

/** The username an X Ask is scoped to: the platform is X and the named source is a username. Null otherwise (another platform, no source, or a source named only by an Arabic name). */
export function xHandleOfAsk(ask: { platform?: string | null; source?: { kind?: string; text?: string | null } | null }): string | null {
  if (ask.platform !== "x" || ask.source?.kind !== "named") return null;
  return xHandleOfSource(ask.source.text);
}

/** THE AUTHORITATIVE CHECK of one row: its own username IS the account (case-insensitive; «@» ignored). Nothing else counts: not the display name, not a username that only contains it. */
export function xHandleMatches(handle: string, username: unknown): boolean {
  const want = clean(handle).replace(/^@/, "").toLowerCase();
  const have = clean(username).replace(/^@/, "").toLowerCase();
  return want !== "" && valid(want) && have === want;
}

/** Words after a name that end it (a preposition, the platform, a period, a conjunction, an instruction). */
const NAME_STOP = /^(?:على|علي|ع|في|فى|من|عن|حول|خلال|آخر|اخر|أو|او|و?منذ|بين|مع|إكس|اكس|أكس|تويتر|x|twitter|منصة|منصه|فقط|بس|لمدة|مدة|طوال|تخص|بخصوص|حتى|لحد|الى|إلى|بتاريخ|سنة|سنه|عام|شهر|تغريدة|تغريدات|تغريده|منشور|منشورات|بوست|بوستات)$/i;
const INSTITUTION = "(?:ال)?(?:وزارة|وزاره|هيئة|هيئه|مركز|جامعة|جامعه|مجلس|مؤسسة|مؤسسه|سفارة|سفاره|منظمة|منظمه|وكالة|وكاله|بلدية|بلديه|أمانة|امانة|امانه|إمارة|امارة|نادي|جمعية|جمعيه|شرطة|شرطه|رئاسة|رئاسه|ديوان|مستشفى|مستشفي|قيادة|قياده)";
/** The name that starts at the first word and runs up to three more words, stopping at a word that ends it or at punctuation. */
function nameFrom(rest: string): string | null {
  const words = rest.split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (const raw of words) {
    const w = raw.replace(/[.،,؛;:!؟?()«»"']+$/u, "");
    if (w === "" || (kept.length > 0 && NAME_STOP.test(w))) break;
    kept.push(w);
    if (raw !== w || kept.length >= 4) break;
  }
  const name = kept.join(" ").trim();
  return name.length >= 3 ? name : null;
}

/**
 * THE ACCOUNT AN X REQUEST NAMES BY ITS NAME ONLY (no username), as the customer wrote it, or null:
 *  - «الصفحة الرسمية لوزارة الصحة السعودية», «الحساب الرسمي لـ هيئة الغذاء والدواء» (an official page or account OF a name);
 *  - «من حساب وزارة الصحة السعودية», «عبر حساب …» (an account by its name);
 *  - «على وزارة الصحة السعودية», «عبر وزارة …», «لوزارة …» (an institution named after a preposition, on X: the posts of that institution's account).
 * Read on the request's words only when the platform is X (the caller's rule). An instruction like «فقط» is never part of the name.
 */
export function xAccountMentionOf(text: unknown): string | null {
  const t = clean(text);
  if (t === "") return null;
  const official = /(?:^|\s)(?:ال)?(?:صفحة|صفحه|حساب)\s+(?:ال)?رسمي[ةه]?\s+(?:ل|لـ)\s*(\S.*)$/u.exec(t);
  if (official) { const n = nameFrom(official[1]); if (n) return n; }
  const byAccount = /(?:^|\s)(?:من|عبر|على|علي|في|فى)\s+(?:ال)?(?:حساب|صفحة|صفحه)\s+(?!(?:ال)?رسمي)(\S.*)$/u.exec(t);
  if (byAccount) { const n = nameFrom(byAccount[1]); if (n) return n; }
  const institution = new RegExp(`(?:^|\\s)(?:(?:على|علي|عبر|من|لدى|في|فى)\\s+|ل|لـ\\s*)(${INSTITUTION}\\s+\\S.*)$`, "u").exec(t);
  if (institution) { const n = nameFrom(institution[1]); if (n && n.split(/\s+/).length >= 2) return n; }
  return null;
}

/** The customer's answer to the X account question, read by code. */
export type XAccountAnswer = { kind: "handle"; handle: string } | { kind: "all" } | { kind: "cancel" };
export const X_ACCOUNT_OPTIONS_AR = { all: "ابحث في كل إكس بدون تقييد بحساب", cancel: "ألغِ الطلب" } as const;

/** The answer: a username (an account link, «@username», «اسم الحساب المطلوب: username», or the whole answer being one username), the explicit choice to search all of X, or a cancellation. Null: none of them. */
export function xAccountAnswerOf(answer: unknown): XAccountAnswer | null {
  const t = clean(answer);
  if (t === "" || t.length > 300) return null;
  if (t === X_ACCOUNT_OPTIONS_AR.cancel || /^(?:[أاإ]لغ[يِ]?|[أاإ]لغاء|الغي)(?:\s|$)/u.test(t)) return { kind: "cancel" };
  if (t === X_ACCOUNT_OPTIONS_AR.all || /كل\s+(?:إكس|اكس|أكس|تويتر|x\b)|بدون\s+(?:تقييد|تحديد)\s+(?:ب|ل)?(?:ال)?حساب|بحث\s+عام\s+(?:في|على)/iu.test(t)) return { kind: "all" };
  const labelled = /اسم\s+(?:ال)?حساب(?:\s+المطلوب)?\s*[:：]\s*@?([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/u.exec(t);
  if (labelled && valid(labelled[1])) return { kind: "handle", handle: labelled[1] };
  const inText = xHandleIn(t);
  if (inText) return { kind: "handle", handle: inText };
  const whole = t.replace(/^@/, "");
  return /[A-Za-z]/.test(whole) && valid(whole) ? { kind: "handle", handle: whole } : null;
}

/** The question, before anything is read, held or priced. */
export function xAccountQuestionAr(name: string | null): string {
  const who = name ? `حساب «${name}»` : "الحساب الذي تقصده";
  return `على إكس نقيّد البحث بحساب واحد باسم المستخدم الخاص به فقط، ولا نخمّن اسم المستخدم من اسم الجهة. اكتب اسم المستخدم (مثل @example) أو رابط ${who} على إكس، أو اختر «${X_ACCOUNT_OPTIONS_AR.all}» إن أردت تغريدات من أي حساب.`;
}

/** The end of a request whose account question got no usable answer: nothing was read, held or charged. */
export const X_ACCOUNT_DECLINED_AR = "لم نجهّز خطة لهذا الطلب: طلبت تغريدات حساب محدد على إكس، ولم يصلنا اسم المستخدم الخاص به، ولا نخمّنه من اسم الجهة، ولن نبحث في كل إكس ونعرض النتيجة كأنها من الحساب. لم يُخصم منك شيء. أرسل طلبًا جديدًا واذكر فيه اسم المستخدم (مثل @example) أو رابط الحساب، أو اطلب صراحةً البحث في كل إكس.";
/** The end of a request the customer cancelled at the account question. */
export const X_ACCOUNT_CANCELLED_AR = "أُلغيت هذه المهمة ولم يُخصم شيء.";

/** The plan's note of an account-scoped X plan. */
export const xAccountNoteAr = (handle: string): string =>
  `النتائج من حساب «@${handle}» وحده: طلبنا من المصدر تغريدات هذا الحساب فقط، ونتحقق من اسم المستخدم في كل تغريدة، فلا تُسلَّم ولا تُحتسب أي تغريدة من حساب آخر. العدد النهائي قد يكون أقل من المطلوب إن لم ينشر الحساب ما يكفي.`;
/** The plan's note when the customer chose, at the account question, to search all of X. */
export const xAllAccountsNoteAr = (name: string | null): string =>
  `اخترتَ البحث في كل إكس: النتائج غير مقيّدة بحساب${name ? ` «${name}»` : ""}، وقد تأتي من أي حساب.`;
