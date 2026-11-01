import { parseMoment } from "./dateCells";

/**
 * EVERY USEFUL FIELD THE SOURCE GIVES STAYS IN THE CUSTOMER'S FILE. The agent chooses the columns of a stage from a sample page; a sheet that drops the date, the link, the author or the counts the source returned (the live run
 * of 2026-10-28 delivered tweets with no date and no replies column, though the earlier file had both) is poorer for no reason. This module reads the raw page the plan cites, finds the fields that matter for any kind of item
 * (a moment, an author, a link, counts of likes, replies, shares, views, followers, a rating), and says which of them no column of the stage holds. The plan is refused until they are added. Pure; works for posts, comments,
 * videos, companies, people, reviews, places: it looks at the shape of the values, not at a platform.
 */
export type FieldClass = "date" | "author" | "link" | "like" | "reply" | "comment" | "share" | "view" | "rating" | "followers" | "phone" | "email" | "address" | "review_count";

export interface SourceField { cls: FieldClass; path: string }

/** How the customer calls each class (used in the message to the agent and in the plan card). */
export const FIELD_LABEL_AR: Record<FieldClass, string> = { date: "التاريخ والوقت", author: "الكاتب", link: "الرابط", like: "الإعجابات", reply: "الردود", comment: "التعليقات", share: "المشاركات", view: "المشاهدات", rating: "التقييم", followers: "المتابعون", phone: "رقم الهاتف", email: "الإيميل", address: "العنوان", review_count: "عدد التقييمات" };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const isNumeric = (v: unknown) => typeof v === "number" || (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()));
const BAD_FOR_LINK = /image|display|avatar|thumb|photo|picture|cover|icon|media|profile|banner|pic|logo|video|audio|music|download/;
const NOT_A_MOMENT = /duration|timezone|timeline|runtime|lifetime|ttl|elapsed|timeout|interval/;

/** The class of a scalar field, from its path (and value), or null. */
export function classOfField(path: string, value: unknown): FieldClass | null {
  const parts = path.split(".");
  const last = norm(parts[parts.length - 1] ?? "");
  const parent = norm(parts[parts.length - 2] ?? "");
  if (!last) return null;
  if (typeof value === "string" && /^https?:\/\//i.test(value) && /(url|link|permalink|href)$/.test(last) && !BAD_FOR_LINK.test(norm(path)) && !/^(user|author|owner)/.test(parent)) return "link";
  if (!NOT_A_MOMENT.test(last) && /(created|date|time|timestamp|published|posted|updated|when)/.test(last) && parseMoment(value) !== null && (typeof value !== "number" || value > 1e8)) return "date";
  if (isNumeric(value)) {
    // a place's number of reviews first: «reviewcount» holds «view» and would read as a count of views
    if (/(reviewcount|reviewscount|numreviews|numberofreviews|totalreviews|userratingstotal|ratingcount|ratingscount|reviewtotal)/.test(last)) return "review_count";
    if (/(follower|subscriber|fans)/.test(last)) return "followers";
    if (/(like|favorite|favourite|digg|heart|reaction)/.test(last)) return "like";
    if (/(reply|replies)/.test(last)) return "reply";
    if (/comment/.test(last)) return "comment";
    if (/(retweet|repost|share|forward|quote)/.test(last)) return "share";
    if (/(view|play|impression|watch)/.test(last)) return "view";
    if (/(rating|stars?)$/.test(last)) return "rating";
  }
  // CONTACT FIELDS OF A COMPANY OR A PLACE (audit 2026-11: the companies source gives phone_number and street_address and the plan dropped them): a phone, an e-mail address, a street address
  if (typeof value === "string" && value.trim()) {
    const digits = value.replace(/\D/g, "").length;
    if (/(phone|tel|mobile|msisdn|whatsapp)/.test(last) && !/(country|code|type|valid|verif|status|url|link|count|total|has)/.test(last) && digits >= 7 && digits <= 15) return "phone";
    if (/mail/.test(last) && !/(status|valid|verif|deliver|score|quality|domain|provider|total|count|num|has)/.test(last) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) return "email";
    if (/^(streetaddress|address|fulladdress|formattedaddress|addressline1|addressline)$/.test(last)) return "address";
  }
  if (typeof value === "string" && value.trim() && /^(username|screenname|handle|nickname|displayname|authorname|ownername)$/.test(last)) return "author";
  if (typeof value === "string" && value.trim() && /^(name|title|fullname)$/.test(last) && /^(user|author|owner|account|poster|from|creator|channel)$/.test(parent)) return "author";
  return null;
}

/** The main list of items in a page: the longest array of objects within a few levels. */
function mainList(value: unknown): Array<Record<string, unknown>> {
  let best: Array<Record<string, unknown>> = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 5 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      if (v.length > best.length && v.slice(0, 3).every((x) => x !== null && typeof x === "object" && !Array.isArray(x))) best = v as Array<Record<string, unknown>>;
      for (const x of v.slice(0, 2)) walk(x, depth + 1);
      return;
    }
    for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
  };
  walk(value, 0);
  return best;
}

function flatten(row: Record<string, unknown>, prefix = "", depth = 0, out: Array<[string, unknown]> = []): Array<[string, unknown]> {
  for (const [k, v] of Object.entries(row)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) { if (depth < 2) flatten(v as Record<string, unknown>, path, depth + 1, out); }
    else if (!Array.isArray(v)) out.push([path, v]);
  }
  return out;
}

/** The useful fields of the items of a saved page (text of a JSON page): one entry per class, the first path that carries it. Empty when the page is not a list of items. */
export function usefulFieldsOfPage(pageText: string | null | undefined): SourceField[] {
  if (!pageText) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(pageText); } catch { return []; }
  const rows = mainList(parsed).slice(0, 3);
  const found = new Map<FieldClass, string>();
  for (const row of rows) {
    for (const [path, value] of flatten(row)) {
      const cls = classOfField(path, value);
      if (cls && !found.has(cls)) found.set(cls, path);
    }
  }
  return [...found].map(([cls, path]) => ({ cls, path }));
}

const COVER: Record<FieldClass, { title: RegExp; key: RegExp }> = {
  date: { title: /تاريخ|وقت|موعد|ساعة|توقيت|نُشر|نشر/, key: /(date|time|created|published|posted|updated|when)/i },
  author: { title: /كاتب|حساب|صاحب|مستخدم|ناشر|مؤلف|الاسم|اسم/, key: /(author|user|handle|account|owner|poster|creator|channel|name)/i },
  link: { title: /رابط|لينك|وصلة/, key: /(url|link|permalink|href)/i },
  like: { title: /إعجاب|اعجاب|لايك|قلوب|تفاعل/, key: /(like|fav|digg|heart|reaction)/i },
  reply: { title: /ردود|الردود|عدد الرد|^رد/, key: /(reply|replies)/i },
  comment: { title: /تعليق|تعليقات/, key: /comment/i },
  share: { title: /مشاركة|مشاركات|إعادة|اعادة|ريتويت|إعادات/, key: /(share|retweet|repost|forward|quote)/i },
  view: { title: /مشاهدة|مشاهدات|عرض|تشغيل/, key: /(view|play|impression|watch)/i },
  rating: { title: /تقييم|نجوم|درجة|تصنيف/, key: /(rating|star)/i },
  followers: { title: /متابع/, key: /(follower|subscriber|fans)/i },
  phone: { title: /هاتف|تليفون|موبايل|محمول|جوال|واتس/, key: /(phone|tel|mobile|msisdn|whatsapp)/i },
  email: { title: /إيميل|ايميل|بريد/, key: /mail/i },
  address: { title: /عنوان|مقر|شارع/, key: /(address|street)/i },
  review_count: { title: /عدد\s*(ال)?(تقييم|مراجع)|تقييمات|مراجعات/, key: /review/i },
};

/** True when one of the columns holds this class of field (by its Arabic title or its key). */
export const columnsCover = (cls: FieldClass, columns: ReadonlyArray<{ key: string; title_ar: string }>): boolean => columns.some((c) => COVER[cls].title.test(c.title_ar) || COVER[cls].key.test(c.key));

/** The useful fields the page gives that no column holds. */
export function uncoveredFields(fields: ReadonlyArray<SourceField>, columns: ReadonlyArray<{ key: string; title_ar: string }>): SourceField[] {
  return fields.filter((f) => !columnsCover(f.cls, columns));
}
