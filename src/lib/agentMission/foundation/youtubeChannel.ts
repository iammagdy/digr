/**
 * ROUND 31: YOUTUBE, A REQUEST WITH NO CHANNEL. The verified YouTube cards find a CHANNEL by name and search for videos INSIDE a channel (comments and replies come after); none searches all of YouTube. A request that names no channel (and does not ask for «the official
 * channels» of a named event) used to be turned into a lookup of «<topic> الرسمية», a guess that the first result is an official channel (live QA 4 Nov 2026, `msn_5349f30a20f414417b5a`, `msn_175b3946d0810ce262be`: one channel call answered, no video call followed, «مصادرنا لا تخدم»).
 * Now the customer is asked ONCE, before anything is read, held or priced, which channel; the answer (a name, an `@handle`, a channel link, a channel id) is read by code; a name or a handle is looked up with the verified channel search and used ONLY if a result really carries it
 * (never «the first result»); a channel id needs no lookup. The plan says it is a search inside that channel, not across YouTube. The topic and the count stay the request's own. No usable answer, or a channel that cannot be identified, ends honestly with nothing charged. Pure: no I/O.
 */
export const YOUTUBE_CHANNEL_QUESTION_AR = "نقدر نبحث عن الفيديوهات داخل قناة يوتيوب محددة. اكتب اسم القناة أو رابطها عشان نكمل البحث.";
export const YOUTUBE_CHANNEL_DECLINED_AR = "لا نستطيع تجهيز خطة لفيديوهات يوتيوب بدون قناة محددة؛ نبحث عن الفيديوهات داخل قناة معيّنة، ولا نبحث في كل يوتيوب. لم يُخصم منك شيء. أرسل طلبًا جديدًا واذكر فيه اسم القناة أو رابطها.";
export const YOUTUBE_CHANNEL_UNIDENTIFIED_AR = "لم نستطع تحديد قناة يوتيوب بهذا الاسم بدقة كافية، فلم نجهّز خطة ولم يُخصم منك شيء. أرسل طلبًا جديدًا واكتب اسم القناة كما يظهر على يوتيوب أو رابطها.";
/** The note of the plan of a channel the customer gave: a search inside that one channel (named by its Arabic title when it has one), not across YouTube, and the customer checks it is the one meant. */
export const youtubeChannelNoteAr = (display: string | null): string => `هذا بحث داخل ${display ? `القناة «${display}»` : "القناة التي حدّدتها"} وحدها، وليس بحثًا في كل يوتيوب. راجع أنها القناة المقصودة قبل الاعتماد.`;

export type YoutubeChannelRef = { kind: "id"; id: string } | { kind: "handle"; handle: string } | { kind: "name"; name: string };

const clean = (v: unknown): string => String(v ?? "").replace(/[‎‏‪-‮⁦-⁩]/g, "").replace(/\s+/g, " ").trim();
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const HANDLE = /^[\p{L}\p{N}._-]{3,30}$/u;
/** Answers that say there is no channel («مش عارف», «أي قناة»): never looked up. */
const NO_CHANNEL = new Set(["مش عارف", "مش عارفه", "مش عارفة", "معرفش", "لا اعرف", "لا أعرف", "لا", "لأ", "لا يوجد", "مفيش", "مافيش", "عام", "عامه", "عامة", "اي قناه", "أي قناة", "اي قناة", "اي حاجه", "أي حاجة", "اي حاجة", "اي واحده", "أي واحدة", "مش مهم", "الغي", "ألغِ", "الغاء", "إلغاء", "cancel", "no"]);
const normAr = (s: string): string => s.replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").toLowerCase();
const decode = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };

/** The channel the customer's answer names, or null: a channel link (`/channel/UC…`, `/@handle`, `/c/name`, `/user/name`), `@handle`, a channel id, or a name (a leading «قناة» is dropped). A video, playlist, Short or search link is not a channel. */
export function youtubeChannelOf(answer: unknown): YoutubeChannelRef | null {
  const t = clean(answer);
  if (t.length < 2 || t.length > 120) return null;
  const link = /(?:^|[\s(])(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/(\S*)/i.exec(t);
  if (link) {
    const path = link[1].replace(/[?#].*$/, "").replace(/\)+$/, "");
    const id = /^channel\/(UC[A-Za-z0-9_-]{22})(?:\/|$)/.exec(path);
    if (id) return { kind: "id", id: id[1] };
    const handle = /^@([^/]+)(?:\/|$)/.exec(path);
    if (handle) { const h = decode(handle[1]); return HANDLE.test(h) ? { kind: "handle", handle: h.toLowerCase() } : null; }
    const named = /^(?:c|user)\/([^/]+)(?:\/|$)/.exec(path);
    if (named) { const n = clean(decode(named[1])); return n.length >= 2 ? { kind: "name", name: n } : null; }
    return null;
  }
  if (/https?:|\/|youtu\.be/i.test(t)) return null;
  if (CHANNEL_ID.test(t)) return { kind: "id", id: t };
  const at = /^@([^\s@]+)$/.exec(t);
  if (at) return HANDLE.test(at[1]) ? { kind: "handle", handle: at[1].toLowerCase() } : null;
  if (NO_CHANNEL.has(t.toLowerCase()) || NO_CHANNEL.has(t)) return null;
  const name = clean(t.replace(/^(?:قناة|قناه|channel)\s+/i, ""));
  return name.length >= 2 && name.length <= 60 && /[\p{L}]/u.test(name) ? { kind: "name", name } : null;
}

/**
 * THE CHANNEL AMONG THE LOOKUP'S RESULTS: an id is itself; a handle is the result whose own handle is it; a name is the FIRST result (in the source's order) whose title or handle carries every word of the name (a leading «ال» and the usual letter variants ignored).
 * No result carries it: null, and nothing is guessed from the order of the results. Pure.
 */
export function matchChannel(ref: YoutubeChannelRef, rows: ReadonlyArray<{ id: string; title?: string; handle?: string }>): { id: string; title?: string } | null {
  if (ref.kind === "id") return { id: ref.id };
  const usable = rows.filter((r) => typeof r.id === "string" && r.id !== "");
  if (ref.kind === "handle") {
    const hit = usable.find((r) => typeof r.handle === "string" && r.handle.replace(/^@/, "").toLowerCase() === ref.handle);
    return hit ? { id: hit.id, ...(hit.title ? { title: hit.title } : {}) } : null;
  }
  const words = normAr(ref.name).split(/\s+/).map((w) => w.replace(/^ال/, "")).filter((w) => w.length > 1);
  if (words.length === 0) return null;
  const hit = usable.find((r) => { const hay = normAr(`${r.title ?? ""} ${(r.handle ?? "").replace(/^@/, "")}`); return words.every((w) => hay.includes(w)); });
  return hit ? { id: hit.id, ...(hit.title ? { title: hit.title } : {}) } : null;
}
