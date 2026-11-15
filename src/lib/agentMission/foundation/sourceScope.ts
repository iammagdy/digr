import type { ToolCard } from "./toolCards/types";

/**
 * THE NAMED SOURCE IS PART OF THE CONTRACT, ON EVERY PLATFORM (P0, 14 Nov 2026: msn_93ed6dea95edb303fd2b, msn_fefee20b5a4dfc1aafc2, msn_dd7c2e9c131b8783bf2e: «the Saudi Ministry of Health's X account» was searched
 * across all of X, delivered and charged as completed). ONE general rule, written on the cards' own data, never on a platform or a word:
 *
 *   1. A request that names a source (an account, a page, a channel) is planned only with a service that CARRIES it:
 *        - `input`: the service reads that source's own listing by its identifier (an account's handle, a page's link): what it returns is the source's by construction;
 *        - `lookup`: the service resolves the source by name with evidence (a channel search whose result carries the channel) before reading inside it;
 *        - `name`: a search that writes the source's name into its query (`query.withSource`) and whose rows name their page: each row's author is checked by that name, and widening is the customer's explicit choice;
 *        - `operator`: a search that takes the source as an operator of its query (the card's `query.sourceOperator`, e.g. the provider-documented `from:` of X): every row it returns is then CHECKED by its own author identifier,
 *          exactly (case-insensitive), because a search can return anyone.
 *   2. A source no chosen service can carry with what the customer wrote (a name where an identifier is needed, or a platform whose services cannot restrict to a source at all) is asked ONCE, before anything is priced or held: the
 *      identifier (when some service of the platform can carry one), the explicit choice to search without restricting to the source (the plan then says so), or cancel. The identifier is never guessed.
 *   3. The plan is never priced with an unenforced source (compilePlan refuses it), and the delivery says when delivered items are not the named source's.
 * Pure: no I/O.
 */

/** An identifier the customer can write: letters, digits, «_», «.», «-»; at least one Latin letter. */
const ID = /^[A-Za-z0-9._-]{1,60}$/;
const clean = (v: unknown): string => String(v ?? "").replace(/[‎‏‪-‮⁦-⁩]/g, "").replace(/\s+/g, " ").trim();
const validId = (s: string): boolean => ID.test(s) && /[A-Za-z]/.test(s);
/** Path segments of a profile link that are not the identifier itself but say what follows («/channel/<id>», «/c/<name>», «/user/<name>», «/pages/<name>»). */
const PREFIX_SEGMENTS = new Set(["channel", "c", "user", "pages", "people", "profile"]);

/** The identifier a profile link carries: its first meaningful path segment, without «@». Null when the text is not a link or carries none. */
export function idOfLink(text: unknown): string | null {
  const t = clean(text);
  const m = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(\/[^\s?#]*)?/i.exec(t);
  if (!m || !m[1]) return null;
  const segs = m[1].split("/").filter(Boolean);
  const seg = PREFIX_SEGMENTS.has((segs[0] ?? "").toLowerCase()) ? segs[1] : segs[0];
  // P0 (15 Nov 2026, msn_c6767995ad124f9edbec): a link at the end of a sentence carries the sentence's punctuation («https://x.com/SaudiMOH.»); the identifier never ends with it (the search was sent as `from:SaudiMOH.`, a handle that
  // does not exist, and answered 0 rows twice)
  const id = (seg ?? "").replace(/^@/, "").replace(/[.\-]+$/, "");
  return validId(id) ? id : null;
}

/** The identifier a source text IS: a profile link, «@identifier», or one bare identifier. An Arabic name, or several words, give null. */
export function sourceIdOf(sourceText: unknown): string | null {
  const t = clean(sourceText);
  if (t === "") return null;
  const link = /^(?:https?:\/\/|www\.)/i.test(t) || /^[a-z0-9-]+\.[a-z]{2,}\//i.test(t) ? idOfLink(t) : null;
  if (link) return link;
  const bare = t.replace(/^@/, "").replace(/[.\-،,؛;:!?؟]+$/, "");
  return validId(bare) ? bare : null;
}

/** The identifier written in free words: a profile link, or «@identifier» standing alone; null when none (an e-mail address is not one). */
export function sourceIdIn(text: unknown): string | null {
  const t = clean(text);
  const link = /(?:^|[\s(«"'])((?:https?:\/\/)?(?:www\.|m\.|mobile\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s)»"']+)/i.exec(t);
  if (link) { const id = idOfLink(link[1]); if (id) return id; }
  const at = /(?:^|[\s(«"'،,:])@([A-Za-z0-9._]{1,60})(?![A-Za-z0-9_@])/.exec(t);
  return at && validId(at[1].replace(/\.+$/, "")) ? at[1].replace(/\.+$/, "") : null;
}

/** THE EXACT AUTHOR CHECK of one row: one of the row's own author identifiers (its username, its author link's identifier, its channel id) IS the identifier. Never a display name, never «contains». */
export function rowIsBy(row: Record<string, unknown>, id: string): boolean {
  const want = clean(id).replace(/^@/, "").toLowerCase();
  if (want === "") return false;
  const ids = [row.username, row.channel_id, row.author_id].map((v) => clean(v).replace(/^@/, "").toLowerCase()).filter(Boolean);
  const link = idOfLink(row.author_url);
  if (link) ids.push(link.toLowerCase());
  return ids.includes(want);
}

export type SourceCarry = "input" | "lookup" | "operator" | "name";
/** How a card carries the Ask's named source, or null when it cannot (with what the customer wrote). `writable` says whether the source text can be written in the card's input (compilePlan's `sourceInputOf`). */
export function sourceCarryOf(card: ToolCard, sourceText: string | null, writable: boolean): SourceCarry | null {
  if (card.inputs.source?.kind === "channel_id") return "lookup";
  if (card.inputs.source && writable) return "input";
  if (card.inputs.query?.sourceOperator && sourceIdOf(sourceText)) return "operator";
  // a search that writes the source's NAME into its query (the card's `query.withSource`, Facebook's keyword search) and whose rows carry the author's page: the plan keeps the source's own rows (each row's author checked by name), and
  // widening to other sources is the customer's explicit choice before approval (decision 7.5: «only the ones found» / «fill from other pages» / cancel)
  if (card.inputs.query?.withSource && String(sourceText ?? "").trim() !== "") return "name";
  return null;
}
/** Whether a card could carry SOME source given its identifier (an input or an operator): the question then asks for the identifier; with none, it says the platform's services cannot restrict to a source. */
export const cardCanTakeId = (card: ToolCard): boolean => Boolean(card.inputs.source || card.inputs.query?.sourceOperator);

/** The customer's answer to the source question, read by code: an identifier, the explicit choice to search without the source, or cancel. Null: none of them (the request then ends honestly). */
export type SourceAnswer = { kind: "id"; id: string } | { kind: "widen" } | { kind: "cancel" };
export const SOURCE_OPTIONS_AR = { widen: "ابحث بدون تقييد بالمصدر", cancel: "ألغِ الطلب" } as const;
export function sourceAnswerOf(answer: unknown): SourceAnswer | null {
  const t = clean(answer);
  if (t === "" || t.length > 300) return null;
  if (t === SOURCE_OPTIONS_AR.cancel) return { kind: "cancel" };
  if (t === SOURCE_OPTIONS_AR.widen) return { kind: "widen" };
  const id = sourceIdOf(t) ?? sourceIdIn(t);
  return id ? { kind: "id", id } : null;
}

/** The question, before anything is priced. `byId`: some service of the platform can carry a source given its identifier. */
export function sourceQuestionAr(platformAr: string, name: string | null, byId: boolean): string {
  const who = name ? `«${name}»` : "المصدر الذي تقصده";
  if (!byId) return `طلبت محتوى ${who} على ${platformAr}، وخدماتنا على ${platformAr} لا تستطيع تقييد البحث بحساب أو صفحة محددة. هل نبحث بدون تقييد بالمصدر (والنتائج قد تأتي من أي حساب، ونقول ذلك في الخطة)، أم نلغي الطلب؟`;
  return `لكي تأتي النتائج من ${who} وحده على ${platformAr} نحتاج اسم المستخدم أو رابط الحساب أو الصفحة كما هو على ${platformAr}؛ لا نخمّنه من الاسم. اكتبه، أو اختر «${SOURCE_OPTIONS_AR.widen}» إن أردت نتائج من أي حساب.`;
}
/** The end of a request whose source question got no usable answer (or whose identifier no service could carry): nothing was priced or held. */
export const SOURCE_DECLINED_AR = "لم نجهّز خطة لهذا الطلب: طلبت محتوى مصدر محدد، ولم يصلنا ما نقيّد به البحث على هذا المصدر، ولا نخمّنه، ولن نبحث بلا تقييد ونعرض النتائج كأنها منه. لم يُخصم منك شيء. أرسل طلبًا جديدًا واذكر فيه اسم المستخدم أو رابط الحساب، أو اطلب صراحةً البحث بدون تقييد بالمصدر.";
export const SOURCE_CANCELLED_AR = "أُلغيت هذه المهمة ولم يُخصم شيء.";
/** The plan's note when a search carries the source by its operator: that source alone, every item checked. */
export const sourceOperatorNoteAr = (id: string): string =>
  `النتائج من حساب «@${id}» وحده: طلبنا من المصدر محتوى هذا الحساب فقط، ونتحقق من صاحب كل عنصر، فلا يُسلَّم ولا يُحتسب أي عنصر من حساب آخر. العدد النهائي قد يكون أقل من المطلوب إن لم ينشر الحساب ما يكفي.`;
/** The plan's note when the customer chose, at the question, to search without the source. */
export const sourceWidenedNoteAr = (name: string | null): string => `اخترتَ البحث بدون تقييد بالمصدر: النتائج غير مقيّدة بـ${name ? `«${name}»` : "المصدر الذي سمّيته"}، وقد تأتي من أي حساب.`;
