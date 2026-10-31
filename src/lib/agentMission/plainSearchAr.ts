import { arabicDateLabel } from "./fileNames";
import { toArabicDigits } from "../arabicDigits";

/**
 * A search string as the source reads it («"محمد صلاح" lang:ar since:2026-10-24») told to the customer in plain Arabic:
 * the words in «…», then what each operator MEANS («باللغة العربية», «من ٢٤ أكتوبر ٢٠٢٦», «دون الردود»). Built by code from the recorded
 * string only. An operator this file does not know is DROPPED (the customer never reads code). No Latin digits. Pure: no I/O.
 */

const LANG_AR: Record<string, string> = { ar: "العربية", en: "الإنجليزية", fr: "الفرنسية", de: "الألمانية", es: "الإسبانية", tr: "التركية", fa: "الفارسية", ur: "الأردية", it: "الإيطالية", ru: "الروسية" };

/** What a switch of the form `filter:x`, `is:x` or `has:x` means, positive and negated. A name not listed here is unknown (dropped). */
const SWITCH_AR: Record<string, { on: string; off: string }> = {
  replies: { on: "الردود فقط", off: "دون الردود" },
  reply: { on: "الردود فقط", off: "دون الردود" },
  retweets: { on: "إعادة النشر فقط", off: "دون إعادة النشر" },
  retweet: { on: "إعادة النشر فقط", off: "دون إعادة النشر" },
  nativeretweets: { on: "إعادة النشر فقط", off: "دون إعادة النشر" },
  quote: { on: "الاقتباسات فقط", off: "دون الاقتباسات" },
  media: { on: "ما فيه صور أو فيديو", off: "دون صور أو فيديو" },
  images: { on: "ما فيه صور", off: "دون صور" },
  videos: { on: "ما فيه فيديو", off: "دون فيديو" },
  native_video: { on: "ما فيه فيديو", off: "دون فيديو" },
  links: { on: "ما فيه روابط", off: "دون روابط" },
};

const MIN_AR: Record<string, string> = { min_faves: "لا يقل عدد الإعجابات عن", min_retweets: "لا يقل عدد إعادات النشر عن", min_replies: "لا يقل عدد الردود عن" };

interface Term { key: string; value: string; text: string }

const quote = (s: string): string => `«${s}»`;

function dayLabel(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? arabicDateLabel(date) : null;
}

/** The meaning of one operator, or null when it is not known (or negated in a way that has no plain sentence). */
function operatorTerm(neg: boolean, rawKey: string, rawValue: string): Term | null {
  const key = rawKey.toLowerCase();
  const value = rawValue.replace(/^["']|["']$/g, "").trim();
  if (!value) return null;
  switch (key) {
    case "lang": {
      const name = LANG_AR[value.toLowerCase()];
      return name ? { key: "lang", value, text: neg ? `بلغة غير ${name}` : `باللغة ${name}` } : null;
    }
    case "since": { const d = dayLabel(value); return d && !neg ? { key: "since", value, text: `من ${d}` } : null; }
    case "until": { const d = dayLabel(value); return d && !neg ? { key: "until", value, text: `حتى ${d}` } : null; }
    case "from": { const h = value.replace(/^@/, ""); return h ? { key: neg ? "notfrom" : "from", value: h, text: neg ? `دون ما نشره حساب ${quote(h)}` : `من حساب ${quote(h)}` } : null; }
    case "to": { const h = value.replace(/^@/, ""); return h && !neg ? { key: "to", value: h, text: `موجّه إلى حساب ${quote(h)}` } : null; }
    case "filter": case "is": case "has": {
      const sw = SWITCH_AR[value.toLowerCase()];
      return sw ? { key: `sw:${value.toLowerCase()}`, value, text: neg ? sw.off : sw.on } : null;
    }
    default: {
      const min = MIN_AR[key];
      return min && !neg && /^\d{1,9}$/.test(value) ? { key, value, text: `${min} ${value}` } : null;
    }
  }
}

/**
 * The plain-Arabic reading of a search string. `operators` is true when at least one operator was read (and so the line holds clauses, not only the words).
 * Empty text when nothing the customer could read is left (only unknown operators).
 */
export function plainSearchAr(raw: string): { text: string; operators: boolean } {
  const source = String(raw ?? "").replace(/\s+/g, " ").trim();
  // a clause is one or more terms joined by OR; a group is what stood inside parentheses
  const clauses: Array<{ terms: Term[]; group: boolean }> = [];
  let operators = false;
  let run: string[] = [];
  let group = false;
  let orPending = false;
  const push = (t: Term | null) => {
    if (!t) { orPending = false; return; }
    const last = clauses[clauses.length - 1];
    if (orPending && last && last.group === group) last.terms.push(t);
    else clauses.push({ terms: [t], group });
    orPending = false;
  };
  const flush = () => {
    if (run.length) push({ key: "text", value: run.join(" "), text: quote(run.join(" ")) });
    run = [];
  };
  const re = /(-?)"([^"]*)"|([()])|([^\s()"]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m[2] !== undefined) {
      flush();
      const phrase = m[2].trim();
      if (phrase) push({ key: "text", value: phrase, text: m[1] ? `دون ${quote(phrase)}` : quote(phrase) });
      continue;
    }
    if (m[3]) { flush(); group = m[3] === "("; orPending = false; continue; }
    const word = m[4];
    if (word === "OR") { flush(); orPending = true; continue; }
    const op = /^(-?)([A-Za-z_]+):(.*)$/.exec(word);
    if (op) {
      flush();
      operators = true;
      push(operatorTerm(op[1] === "-", op[2], op[3]));
      continue;
    }
    if (word.length > 1 && word.startsWith("-") && !/^-+\d*$/.test(word)) { flush(); push({ key: "not", value: word.slice(1), text: `دون ${quote(word.slice(1))}` }); continue; }
    run.push(word);
  }
  flush();
  const parts = clauses.map((c) => {
    const first = c.terms[0];
    const same = c.terms.length > 1 && c.terms.every((t) => t.key === first.key);
    // «من حساب «أ» أو «ب»» (one clause for the same operator), anything else joined by «أو»
    const body = same && (first.key === "from" || first.key === "to")
      ? `${first.text.slice(0, first.text.indexOf("«"))}${c.terms.map((t) => quote(t.value)).join(" أو ")}`
      : c.terms.map((t) => t.text).join(" أو ");
    return c.group ? `مع إحدى الكلمات: ${body}` : body;
  });
  return { text: toArabicDigits(parts.join("، ")), operators };
}
