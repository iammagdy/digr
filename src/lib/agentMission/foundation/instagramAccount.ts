/**
 * ROUND 30: INSTAGRAM, A REQUEST WITH NO ACCOUNT. Instagram has ONE verified tool that reads posts, the posts of a named PUBLIC account (`posts.account`: a username or an account link); there is no keyword search across Instagram, and none is pretended here.
 * A request such as «١٠ منشورات عامة من إنستجرام عن الذكاء الاصطناعي» names no account, so the customer is asked ONCE, before anything is read, held or priced, which account to read (a normal question card of the same mission: no second mission, no approval, no charge).
 * The answer is read by code, never by a model: a username (`alhadath`, `@alhadath`) or an account link. The request's topic and count are untouched (the answer is not read as part of the request). An answer that is not an account, or no answer, ends the request
 * honestly (never a second question). Pure: no I/O.
 */
export const INSTAGRAM_ACCOUNT_QUESTION_AR = "نقدر نجمع منشورات من حساب إنستجرام عام محدد. اكتب اسم المستخدم أو رابط الحساب اللي عايز نبحث فيه.";
export const INSTAGRAM_ACCOUNT_DECLINED_AR = "لا نستطيع تجهيز خطة لمنشورات إنستجرام بدون حساب محدد؛ نقرأ منشورات حساب عام معيّن، ولا نبحث في كل إنستجرام. لم يُخصم منك شيء. أرسل طلبًا جديدًا واذكر فيه اسم الحساب أو رابطه.";
/** The note of the plan that came from an account the customer gave: the results are that account's, not all of Instagram. */
export const instagramAccountNoteAr = (handle: string): string => `النتائج من حساب «@${handle}» وحده، وليست بحثًا في كل إنستجرام.`;

/** The paths of instagram.com that are not an account (a post, a reel, a page of the site): a link to one of them is not an account. */
const NOT_AN_ACCOUNT = new Set(["p", "reel", "reels", "tv", "explore", "accounts", "stories", "tags", "direct", "about", "legal", "developer", "web", "challenge", "directory", "locations", "oauth", "privacy", "terms"]);
const USERNAME = /^[a-z0-9._]{1,30}$/i;
const valid = (u: string): boolean => USERNAME.test(u) && !u.startsWith(".") && !u.endsWith(".") && !u.includes("..") && !NOT_AN_ACCOUNT.has(u.toLowerCase());
const clean = (v: unknown): string => String(v ?? "").replace(/[‎‏‪-‮⁦-⁩]/g, "").replace(/\s+/g, " ").trim();

/** The Instagram username in the customer's answer (lower case), or null: an account link (with or without «https://» and «www.»), an «@username» standing alone in the words, or the whole answer being one username with at least one letter. */
export function instagramAccountOf(answer: unknown): string | null {
  const t = clean(answer);
  if (t === "" || t.length > 200) return null;
  const link = /(?:^|[\s(])(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\/([A-Za-z0-9._]+)(?=[/?#\s)]|$)/i.exec(t);
  if (link) return valid(link[1]) ? link[1].toLowerCase() : null;
  const at = /(?:^|[\s(])@([A-Za-z0-9._]+)(?![A-Za-z0-9._@])/.exec(t);
  if (at) return valid(at[1]) ? at[1].toLowerCase() : null;
  return /[a-z]/i.test(t) && valid(t) ? t.toLowerCase() : null;
}
