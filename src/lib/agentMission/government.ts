/**
 * GOVERNMENT, MILITARY AND PUBLIC BODIES, FROM EVIDENCE IN THE ROW. A customer who asks for companies «بدون جهات حكومية» must not get a ministry, an armed-forces authority or a state research institute among them. Live retest of 2026-10-29: a list of
 * contracting companies came with «Egyptian Armed Forces Engineering Authority» (mod.gov.eg) and a government research centre (hbrc.edu.eg) while the card promised to exclude government bodies. The check reads only what the row itself says:
 *   - the website's domain: a government (.gov, .gov.xx, .gob, .gouv), military (.mil, .mil.xx) or academic (.edu, .edu.xx, .ac.xx) suffix is DEFINITE evidence of a public body for a company list;
 *   - the name and the description: words that make a body public (ministry, authority, armed forces, governorate, municipality, «وزارة»، «هيئة»، «القوات المسلحة»، «محافظة»، «جهاز») are DEFINITE;
 *   - words that MAY mean a public body (research institute or centre, university, academy, national, state, public) are UNCLEAR: the row goes to the model check, never straight to delivery.
 * Pure: no I/O, no import (the relevance check imports it).
 */
export type GovernmentVerdict = "government" | "unclear" | "ok";

const fold = (s: string): string => String(s ?? "").toLowerCase().replace(/[ً-ٰٟـ]/g, "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");

/** The host names a field holds (a link, a bare domain, several links). */
export function hostsOf(value: unknown): string[] {
  const out: string[] = [];
  for (const m of String(value ?? "").matchAll(/(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:[\/?#]|\b)/gi)) out.push(m[1].toLowerCase());
  return out;
}

const PUBLIC_SUFFIX_SECOND = new Set(["gov", "mil", "edu", "ac", "gouv", "gob", "govt", "go"]);
const PUBLIC_SUFFIX_TOP = new Set(["gov", "mil", "edu"]);

/** True when a host ends in a government, military or academic suffix: «mod.gov.eg», «hbrc.edu.eg», «army.mil», «nasa.gov», «ox.ac.uk». */
export function isPublicHost(host: string): boolean {
  const labels = host.toLowerCase().split(".").filter(Boolean);
  if (labels.length < 2) return false;
  const top = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  if (PUBLIC_SUFFIX_TOP.has(top)) return true;
  // a country suffix after the public one («.gov.eg», «.edu.eg», «.ac.uk», «.go.jp»)
  return labels.length >= 3 && top.length === 2 && PUBLIC_SUFFIX_SECOND.has(second);
}

const STRONG_LATIN = /\b(?:ministry|ministries|ministerial|armed\s+forces|military|army|governorate|municipality|municipal|government(?:al)?|authority|police|presidency|parliament|general\s+organi[sz]ation|public\s+sector|state[-\s]owned)\b/i;
const STRONG_ARABIC = ["وزاره", "القوات المسلحه", "الجيش", "محافظه", "هيئه", "الهيئه العامه", "جهاز", "بلديه", "مجلس مدينه", "حكومي", "حكوميه", "حكومه", "الشرطه", "رئاسه الجمهوريه", "مجلس الوزراء", "الهيئه الهندسيه"];
const WEAK_LATIN = /\b(?:research|institute|institution|centre|center|university|academy|college|national|public|foundation|council|commission)\b/i;
const WEAK_ARABIC = ["بحوث", "ابحاث", "معهد", "مركز", "جامعه", "اكاديميه", "كليه", "قومي", "وطني", "مجلس", "مؤسسه"];

const hasArabicWord = (text: string, words: ReadonlyArray<string>): boolean => {
  const t = ` ${fold(text).replace(/[^\p{L}\s]/gu, " ")} `;
  return words.some((w) => t.includes(` ${w} `) || t.includes(` ال${w} `) || (w.includes(" ") && t.includes(w)));
};

/** What the NAME and the DESCRIPTION say: «government» (definite), «unclear» (may be a public body), «ok». */
export function textGovernmentVerdict(text: string): GovernmentVerdict {
  if (!text.trim()) return "ok";
  if (STRONG_LATIN.test(text) || hasArabicWord(text, STRONG_ARABIC)) return "government";
  if (WEAK_LATIN.test(text) || hasArabicWord(text, WEAK_ARABIC)) return "unclear";
  return "ok";
}

/** The verdict on one mapped item: `evidenceFields` are the mapped keys that can carry a website, a name or a description. */
export function governmentVerdict(mapped: Record<string, unknown>, evidenceFields: ReadonlyArray<string>): GovernmentVerdict {
  let worst: GovernmentVerdict = "ok";
  for (const k of evidenceFields) {
    const v = mapped[k];
    if (v === null || v === undefined) continue;
    const s = String(v);
    if (hostsOf(s).some(isPublicHost)) return "government";
    // a field that is only a link or a domain carries no words to read
    const words = textGovernmentVerdict(s.replace(/https?:\/\/\S+|www\.\S+/gi, " "));
    if (words === "government") return "government";
    if (words === "unclear") worst = "unclear";
  }
  return worst;
}

/** The request or a card sentence leaves out government bodies («بدون جهات حكومية», «دون الجهات الحكومية», «غير حكومية», «ما عدا الهيئات الحكومية»). */
export const EXCLUDES_GOVERNMENT = /(?:دون|بدون|بلا|استبعاد|استبعد\S*|تستبعد|يستبعد|عدا|ما\s?عدا|ماعدا|غير|مش|ولا)\s+(?:ال)?(?:جهات|جهه|هيئات|مؤسسات|شركات|مصالح|اجهزه|أجهزة)?\s*(?:ال)?(?:حكوم|عسكر)/;
export const excludesGovernment = (text: unknown): boolean => EXCLUDES_GOVERNMENT.test(String(text ?? "").replace(/[ً-ٟـ]/g, ""));
