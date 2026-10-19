import crypto from "crypto";
import { SOCIAL_COLUMN_ORDER, inferSocialRowKind, normalizeSocialRow, toIsoDate, type SocialRowKind } from "./socialRows";
import { toArabicDigits } from "../arabicDigits";
import { localizeCityFromAddress } from "./addressParser";
import { resolveCompanyLinks } from "../companyUrls";

export interface CodebookEntry {
  field: string;
  titleAr: string;
  descriptionAr: string;
  dataType: string;
}

export interface DatasetKpis {
  totalRecords: number;
  totalViews: number;
  totalLikes: number;
  totalShares: number;
  totalComments: number;
  earliestDate: string | null;
  latestDate: string | null;
  duplicatesRemoved: number;
  dataCompletenessPct: number;
}

export interface NormalizedDataset {
  metadata: {
    platform: string;
    title: string;
    jobId?: string;
    collectedAt: string;
    rowsCount: number;
    methodology: string;
    entityType: "posts" | "comments" | "profile" | "search" | "tabular" | "companies" | "people";
    targetRequested?: number | string | null;
    reportContext?: Record<string, any>;
    /** Set for comment and video results of the verified social services (fixed Arabic schema). */
    socialKind?: SocialRowKind;
  };
  profile: Record<string, any> | null;
  rows: Array<Record<string, any>>;
  columns: string[];
  codebook: CodebookEntry[];
  kpis: DatasetKpis;
}

/**
 * Escapes formula injection in cell strings.
 * If a cell begins with '=', '+', '-', '@', '\t', or '\r', prefix with a single quote,
 * except for a plain phone number or account handle, which cannot be a formula.
 */
export function escapeFormula(value: any): any {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  // A phone number (+20 100 123 4567) and a plain account handle (@name) cannot form a formula, so they
  // are delivered untouched instead of showing a stray apostrophe in front of the value.
  const digits = trimmed.replace(/\D/g, "").length;
  if (/^\+?[\d\s().-]+$/.test(trimmed) && digits >= 6 && digits <= 15) return value;
  if (/^@[A-Za-z0-9_.]{1,30}$/.test(trimmed)) return value;
  if (/^[=+\-@\t\r]/.test(value) || /^[=+\-@\t\r]/.test(trimmed)) {
    return `'${value}`;
  }
  return value;
}

/**
 * Recursively scrubs upstream provider keys and internal cost identifiers.
 */
export function scrubProviderLeaks(obj: any): any {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map(scrubProviderLeaks);
  }

  const SENSITIVE_PATTERNS = [
    /treg/i,
    /tikhub/i,
    /apify/i,
    /rapidapi/i,
    /upstream/i,
    /cost_usd/i,
    /provider_price/i,
    /token_cost/i,
    /raw_provider/i,
    /api_key/i,
    /auth_token/i,
  ];

  const cleaned: Record<string, any> = {};
  for (const [key, val] of Object.entries(obj)) {
    const isSensitive = SENSITIVE_PATTERNS.some((pattern) => pattern.test(key));
    if (!isSensitive) {
      cleaned[key] = scrubProviderLeaks(val);
    }
  }
  return cleaned;
}

/**
 * Detects the platform from slug, endpoint, or metadata.
 */
export function detectPlatform(text?: string): string {
  const str = (text || "").toLowerCase();
  if (str.includes("twitter") || str.includes("tweets") || str.includes(" x") || str.startsWith("x-") || str.includes(".x.")) {
    return "X (تويتر)";
  }
  if (str.includes("youtube")) {
    return "يوتيوب";
  }
  if (str.includes("tiktok")) {
    return "تيك توك";
  }
  if (str.includes("facebook")) {
    return "فيسبوك";
  }
  if (str.includes("instagram")) {
    return "إنستغرام";
  }
  if (str.includes("google") || str.includes("serp")) {
    return "جوجل";
  }
  if (str.includes("telegram")) {
    return "تيليجرام";
  }
  if (str.includes("people") || str.includes("decision-maker") || str.includes("decision maker")) {
    return "بيانات صناع القرار والمهنيين";
  }
  if (str.includes("company") || str.includes("companies") || str.includes("b2b") || str.includes("icypeas")) {
    return "قواعد بيانات الشركات والأعمال";
  }
  return "مصادر متاحة";
}

/**
 * Standard column dictionary for dynamic codebook mapping.
 */
const COLUMN_METADATA_MAP: Record<string, { titleAr: string; descAr: string; type: string }> = {
  id: { titleAr: "معرف السجل", descAr: "المعرف الرقمي المتسلسل للسجل داخل المنصة", type: "نص (String)" },
  source_id: { titleAr: "معرف المصدر الأصلي", descAr: "المعرف الفريد للمنشور أو التعليق على المنصة المصدر", type: "نص (String)" },
  company_name: { titleAr: "اسم الشركة", descAr: "الاسم التجاري الرسمي للشركة أو المؤسسة", type: "نص (String)" },
  contact_name: { titleAr: "اسم جهة الاتصال", descAr: "اسم جهة الاتصال المهنية كما ورد في المصدر", type: "نص (String)" },
  job_title: { titleAr: "المسمى الوظيفي", descAr: "المسمى الوظيفي كما ورد في المصدر", type: "نص (String)" },
  work_email: { titleAr: "البريد المهني", descAr: "عنوان البريد المهني كما ورد في المصدر، دون تحقق مستقل", type: "نص (String)" },
  contact_name_presence_status: { titleAr: "توفر اسم جهة الاتصال", descAr: "يوضح فقط ما إذا كان المصدر قد أعاد قيمة للاسم؛ ولا يعني التحقق منه", type: "نص (String)" },
  work_email_presence_status: { titleAr: "توفر البريد المهني", descAr: "يوضح فقط ما إذا كان المصدر قد أعاد قيمة للبريد المهني؛ ولا يعني التحقق من صحتها", type: "نص (String)" },
  job_title_presence_status: { titleAr: "توفر المسمى الوظيفي", descAr: "يوضح فقط ما إذا كان المصدر قد أعاد قيمة للمسمى الوظيفي؛ ولا يعني التحقق منه", type: "نص (String)" },
  industry: { titleAr: "مجال النشاط", descAr: "التخصص أو القطاع التجاري والصناعي", type: "نص (String)" },
  website: { titleAr: "الموقع الإلكتروني", descAr: "رابط النطاق الرقمي الرسمي للمنشأة", type: "رابط (URL)" },
  linkedin_url: { titleAr: "رابط لينكد إن", descAr: "رابط الصفحة المهنية للشركة على منصة لينكد إن", type: "رابط (URL)" },
  city: { titleAr: "المدينة", descAr: "المدينة المستخرجة من عنوان الجهة؛ تُترك فارغة إن لم يتضمن العنوان مدينة معروفة", type: "نص (String)" },
  location: { titleAr: "المقر والنطاق الجغرافي", descAr: "العنوان أو المدينة والدولة المسجلة للمقر", type: "نص (String)" },
  headcount: { titleAr: "حجم العمالة", descAr: "العدد التقديري للعاملين بالمنشأة", type: "رقم صحيح (Integer)" },
  description: { titleAr: "نبذة عن النشاط", descAr: "الوصف التعريفي المعتمد لطبيعة خدمات ومنتجات الشركة", type: "نص طويل (Text)" },
  phone: { titleAr: "رقم الهاتف المهني", descAr: "رقم هاتف مهني كما ورد من المصدر، دون تحقق مستقل", type: "نص (String)" },
  phone_presence_status: { titleAr: "توفر رقم الهاتف", descAr: "يوضح فقط ما إذا كان المصدر قد أعاد رقم هاتف؛ ولا يعني التحقق منه", type: "نص (String)" },
  work_email_verification_status: { titleAr: "حالة التحقق من البريد", descAr: "حالة تحقق مستقلة إن أرجعها المصدر، وإلا فلا تُستنتج", type: "نص (String)" },
  phone_verification_status: { titleAr: "حالة التحقق من الهاتف", descAr: "حالة تحقق مستقلة إن أرجعها المصدر، وإلا فلا تُستنتج", type: "نص (String)" },
  founded_year: { titleAr: "سنة التأسيس", descAr: "تاريخ وسنة إنشاء الشركة أو بدء النشاط", type: "رقم صحيح (Integer)" },
  tweet_id: { titleAr: "معرف التغريدة", descAr: "المعرف الرقمي الرسمي للتغريدة على منصة X", type: "نص (String)" },
  video_id: { titleAr: "معرف المقطع", descAr: "المعرف الفريد لمقطع الفيديو على المنصة", type: "نص (String)" },
  comment_id: { titleAr: "معرف التعليق", descAr: "المعرف الفريد للتعليق على المنصة", type: "نص (String)" },
  parent_id: { titleAr: "معرف التعليق الأب", descAr: "معرف التعليق الرئيسي الأصلي الذي يتبع له هذا الرد", type: "نص (String)" },
  is_reply: { titleAr: "هل هو رد فرعي؟", descAr: "تحديد ما إذا كان السجل رداً متداخلاً أم تعليقاً رئيسياً مستقلاً", type: "منطقي (Boolean)" },
  published_at: { titleAr: "تاريخ ووقت النشر", descAr: "تاريخ وتوقيت النشر الأصلي بالتوقيت العالمي الموحد (UTC)", type: "تاريخ ووقت (ISO 8601)" },
  created_at: { titleAr: "تاريخ الإنشاء", descAr: "تاريخ وتوقيت إنشاء السجل", type: "تاريخ ووقت (ISO 8601)" },
  username: { titleAr: "اسم المستخدم", descAr: "اسم الحساب أو المعرف الفريد للمستخدم مسبوقاً بعلامة @", type: "نص (String)" },
  author_name: { titleAr: "الاسم المعروض", descAr: "الاسم الظاهر للمستخدم أو صاحب الحساب", type: "نص (String)" },
  display_name: { titleAr: "الاسم المعروض", descAr: "الاسم الظاهر للمستخدم أو القناة", type: "نص (String)" },
  text: { titleAr: "نص المحتوى", descAr: "النص الكامل للمنشور أو التغريدة كما نُشرت علناً", type: "نص طويل (Text)" },
  comment_text: { titleAr: "نص التعليق", descAr: "النص الكامل للتعليق الأصلي أو الرد", type: "نص طويل (Text)" },
  bio: { titleAr: "النبذة التعريفية", descAr: "النص التعريفي المسجل في الملف الشخصي للحساب", type: "نص طويل (Text)" },
  author_verified: { titleAr: "حساب موثّق", descAr: "هل أرجع المصدر أن صاحب المحتوى حساب موثّق بالعلامة الرسمية؛ لا يُستنتج إن لم يرد", type: "منطقي (Boolean)" },
  verified: { titleAr: "حالة التوثيق", descAr: "حالة توثيق الحساب بالعلامة الرسمية (نعم / لا)", type: "منطقي (Boolean)" },
  followers: { titleAr: "عدد المتابعين", descAr: "إجمالي عدد المتابعين للحساب", type: "رقم صحيح (Integer)" },
  followers_count: { titleAr: "عدد المتابعين", descAr: "إجمالي عدد المتابعين للحساب وقت الجمع", type: "رقم صحيح (Integer)" },
  following: { titleAr: "الحسابات المتابَعة", descAr: "عدد الحسابات التي يتابعها صاحب الملف", type: "رقم صحيح (Integer)" },
  following_count: { titleAr: "الحسابات المتابَعة", descAr: "عدد الحسابات التي يتابعها صاحب الملف", type: "رقم صحيح (Integer)" },
  likes: { titleAr: "عدد الإعجابات", descAr: "إجمالي عدد الإعجابات التي حصدها المنشور", type: "رقم صحيح (Integer)" },
  likes_count: { titleAr: "عدد الإعجابات", descAr: "إجمالي عدد الإعجابات المسجلة", type: "رقم صحيح (Integer)" },
  retweets_count: { titleAr: "إعادة النشر", descAr: "عدد مرات إعادة نشر التغريدة أو مشاركتها", type: "رقم صحيح (Integer)" },
  shares_count: { titleAr: "عدد المشاركات", descAr: "إجمالي مرات مشاركة المنشور عبر المنصة", type: "رقم صحيح (Integer)" },
  replies_count: { titleAr: "عدد الردود", descAr: "عدد الردود والتعليقات المباشرة على المنشور", type: "رقم صحيح (Integer)" },
  quotes_count: { titleAr: "عدد الاقتباسات", descAr: "عدد التغريدات المقتبسة للمنشور", type: "رقم صحيح (Integer)" },
  views: { titleAr: "عدد المشاهدات", descAr: "إجمالي عدد المشاهدات المسجلة للمحتوى", type: "رقم صحيح (Integer)" },
  views_count: { titleAr: "عدد المشاهدات", descAr: "إجمالي عدد المشاهدات المسجلة للمحتوى", type: "رقم صحيح (Integer)" },
  videos_count: { titleAr: "عدد مقاطع الفيديو", descAr: "إجمالي المقاطع المنشورة في الحساب", type: "رقم صحيح (Integer)" },
  language: { titleAr: "لغة المحتوى", descAr: "رمز اللغة المكتشف للمحتوى المنشور (مثل ar أو en)", type: "نص (Code)" },
  url: { titleAr: "الرابط المباشر", descAr: "الرابط التشعبي المباشر للوصول للمنشور على الويب", type: "رابط (URI)" },
  profile_url: { titleAr: "رابط الملف الشخصي", descAr: "الرابط المباشر لصفحة الحساب الشخصي", type: "رابط (URI)" },
  bio_link: { titleAr: "الرابط الخارجي بالملف", descAr: "الرابط الخارجي المضاف في ملف الحساب إن وجد", type: "رابط (URI)" },
  video_url: { titleAr: "رابط الفيديو أو المنشور", descAr: "رابط الفيديو أو المنشور الذي كُتب عليه التعليق", type: "رابط (URI)" },
  video_title: { titleAr: "عنوان الفيديو أو المنشور", descAr: "عنوان أو وصف الفيديو أو المنشور الذي كُتب عليه التعليق", type: "نص (String)" },
  pinned: { titleAr: "تعليق مثبّت", descAr: "هل ثبّت صاحب المحتوى هذا التعليق", type: "منطقي (Boolean)" },
  hearted_by_creator: { titleAr: "أعجب به صاحب المحتوى", descAr: "هل أعجب صاحب المحتوى بهذا التعليق", type: "منطقي (Boolean)" },
  video_caption: { titleAr: "عنوان أو وصف الفيديو", descAr: "نص الوصف أو العنوان كما نُشر", type: "نص طويل (Text)" },
  channel_name: { titleAr: "القناة أو الحساب", descAr: "اسم القناة أو الحساب الذي نشر المحتوى", type: "نص (String)" },
  comments_count: { titleAr: "عدد التعليقات", descAr: "عدد التعليقات على الفيديو أو المنشور وقت الجمع", type: "رقم صحيح (Integer)" },
  saves_count: { titleAr: "عدد مرات الحفظ", descAr: "عدد مرات حفظ الفيديو", type: "رقم صحيح (Integer)" },
  video_duration: { titleAr: "مدة الفيديو", descAr: "مدة الفيديو كما أوردها المصدر", type: "نص (String)" },
  hashtags: { titleAr: "الوسوم", descAr: "الوسوم المذكورة في الفيديو أو المنشور", type: "نص (String)" },
  collected_date: { titleAr: "تاريخ الاستخراج", descAr: "تاريخ وتوقيت إتمام عملية السحب آلياً", type: "تاريخ (Date)" },
};

/**
 * Normalizes a single raw record into standard, sanitized research attributes.
 */
export function normalizeRecord(raw: any, index: number): Record<string, any> {
  if (!raw || typeof raw !== "object") return { id: `rec_${index + 1}` };

  const scrubbed = scrubProviderLeaks(raw);
  const out: Record<string, any> = { id: `rec_${index + 1}` };

  // Identify source ID
  const sourceId =
    scrubbed.source_id ||
    scrubbed.tweet_id ||
    scrubbed.id_str ||
    scrubbed.videoId ||
    scrubbed.video_id ||
    scrubbed.comment_id ||
    scrubbed.cid ||
    scrubbed.id;
  if (sourceId && sourceId !== out.id) {
    out.source_id = String(sourceId);
  }

  // Identify publish date / time
  const dateVal =
    scrubbed.published_at ||
    scrubbed.publishedAt ||
    scrubbed.created_at ||
    scrubbed.createdAt ||
    scrubbed.date ||
    scrubbed.time ||
    scrubbed.collectedDate;
  if (dateVal) {
    // A plain date when the source gives one in any common form; otherwise the value as it came (never a guess).
    out.published_at = toIsoDate(dateVal) ?? String(dateVal);
  }

  // Identify author / username
  const username =
    scrubbed.username ||
    scrubbed.screen_name ||
    scrubbed.uniqueId ||
    scrubbed.handle ||
    scrubbed.author_username;
  if (username) {
    const cleanUsername = String(username).replace(/^@/, "");
    out.username = `@${cleanUsername}`;
  }

  const authorName =
    scrubbed.author_name ||
    scrubbed.authorName ||
    scrubbed.nickname ||
    scrubbed.displayName ||
    scrubbed.name;
  if (authorName) {
    out.author_name = escapeFormula(String(authorName));
  }

  // Identify content text
  const textVal =
    scrubbed.text ||
    scrubbed.full_text ||
    scrubbed.comment_text ||
    scrubbed.commentText ||
    scrubbed.content ||
    scrubbed.description ||
    scrubbed.title;
  if (textVal) {
    out.text = escapeFormula(String(textVal));
  }

  // Identify metrics
  if (scrubbed.likes !== undefined || scrubbed.like_count !== undefined || scrubbed.likesCount !== undefined || scrubbed.heartCount !== undefined) {
    out.likes_count = Number(scrubbed.likes ?? scrubbed.like_count ?? scrubbed.likesCount ?? scrubbed.heartCount ?? 0);
  }
  if (scrubbed.retweets !== undefined || scrubbed.retweet_count !== undefined || scrubbed.retweetsCount !== undefined || scrubbed.sharesCount !== undefined) {
    out.retweets_count = Number(scrubbed.retweets ?? scrubbed.retweet_count ?? scrubbed.retweetsCount ?? scrubbed.sharesCount ?? 0);
  }
  if (scrubbed.replies !== undefined || scrubbed.reply_count !== undefined || scrubbed.repliesCount !== undefined || scrubbed.commentsCount !== undefined) {
    out.replies_count = Number(scrubbed.replies ?? scrubbed.reply_count ?? scrubbed.repliesCount ?? scrubbed.commentsCount ?? 0);
  }
  if (scrubbed.views !== undefined || scrubbed.view_count !== undefined || scrubbed.viewsCount !== undefined || scrubbed.playCount !== undefined) {
    out.views_count = Number(scrubbed.views ?? scrubbed.view_count ?? scrubbed.viewsCount ?? scrubbed.playCount ?? 0);
  }
  if (scrubbed.followers !== undefined || scrubbed.follower_count !== undefined || scrubbed.followerCount !== undefined) {
    out.followers_count = Number(scrubbed.followers ?? scrubbed.follower_count ?? scrubbed.followerCount ?? 0);
  }

  // Hierarchy / reply status
  if (scrubbed.is_reply !== undefined || scrubbed.isReply !== undefined) {
    out.is_reply = Boolean(scrubbed.is_reply ?? scrubbed.isReply);
  }
  if (scrubbed.parent_id || scrubbed.parentId || scrubbed.parent_comment_id) {
    out.parent_id = String(scrubbed.parent_id || scrubbed.parentId || scrubbed.parent_comment_id);
  }

  // URL
  const urlVal = scrubbed.url || scrubbed.link || scrubbed.tweet_url || scrubbed.video_url || scrubbed.profileUrl;
  if (urlVal) {
    out.url = String(urlVal);
  }

  // Company links normalization: website never social/LinkedIn, linkedin_url separate
  const hasWebsiteInput = Boolean(
    scrubbed.website !== undefined ||
    scrubbed.website_url !== undefined ||
    scrubbed.domain !== undefined ||
    scrubbed.company_website !== undefined
  );
  const hasLinkedinInput = Boolean(
    scrubbed.linkedin !== undefined ||
    scrubbed.linkedin_url !== undefined ||
    scrubbed.company_linkedin !== undefined
  );
  if (hasWebsiteInput || hasLinkedinInput || scrubbed.company_name) {
    const { website, linkedin } = resolveCompanyLinks(scrubbed);
    if (hasWebsiteInput || website) {
      out.website = website ? escapeFormula(website) : "";
    }
    if (linkedin || hasLinkedinInput) {
      out.linkedin_url = linkedin ? escapeFormula(linkedin) : "";
    }
  }

  // Preserve any remaining arbitrary columns from raw dataset that haven't been mapped
  for (const [k, v] of Object.entries(scrubbed)) {
    if (out[k] === undefined && !["source_id", "tweet_id", "video_id", "comment_id"].includes(k)) {
      if (typeof v === "string") {
        out[k] = escapeFormula(v);
      } else if (typeof v === "number" || typeof v === "boolean") {
        out[k] = v;
      } else if (v === null || v === undefined) {
        out[k] = "";
      } else {
        out[k] = escapeFormula(JSON.stringify(v));
      }
    }
  }

  return out;
}

/**
 * Deduplicates rows using stable source ID, direct URL, or text hash.
 */
export function deduplicateRecords(rows: Array<Record<string, any>>): {
  uniqueRows: Array<Record<string, any>>;
  duplicatesCount: number;
} {
  const seenKeys = new Set<string>();
  const uniqueRows: Array<Record<string, any>> = [];

  for (const row of rows) {
    const key =
      row.source_id ||
      row.website ||
      row.linkedin_url ||
      row.url ||
      (row.company_name ? `company_${String(row.company_name).toLowerCase().trim()}` : null) ||
      (row.text && row.published_at ? `${row.text}_${row.published_at}` : null) ||
      (row.text ? crypto.createHash("md5").update(String(row.text)).digest("hex") : null);

    if (key) {
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
    }
    uniqueRows.push(row);
  }

  return {
    uniqueRows,
    duplicatesCount: rows.length - uniqueRows.length,
  };
}

/**
 * Organizes relational comment data so direct replies nest immediately under
 * their parent top-level comment while preserving all records and stability.
 */
export function organizeCommentHierarchy(
  rows: Array<Record<string, any>>
): Array<Record<string, any>> {
  const hasHierarchy = rows.some((r) => r.parent_id !== undefined || r.is_reply === true);
  if (!hasHierarchy) return rows;

  const topLevel: Array<Record<string, any>> = [];
  const repliesByParent = new Map<string, Array<Record<string, any>>>();
  const orphanedReplies: Array<Record<string, any>> = [];

  for (const r of rows) {
    if (r.parent_id) {
      const pid = String(r.parent_id);
      if (!repliesByParent.has(pid)) repliesByParent.set(pid, []);
      repliesByParent.get(pid)!.push(r);
    } else if (r.is_reply) {
      orphanedReplies.push(r);
    } else {
      topLevel.push(r);
    }
  }

  const result: Array<Record<string, any>> = [];
  for (const parent of topLevel) {
    result.push(parent);
    const parentKey1 = parent.source_id ? String(parent.source_id) : "";
    const parentKey2 = parent.id ? String(parent.id) : "";
    const directReplies =
      (parentKey1 ? repliesByParent.get(parentKey1) : undefined) ||
      (parentKey2 ? repliesByParent.get(parentKey2) : undefined);
    if (directReplies && directReplies.length > 0) {
      result.push(...directReplies);
      if (parentKey1) repliesByParent.delete(parentKey1);
      if (parentKey2) repliesByParent.delete(parentKey2);
    }
  }

  for (const remaining of repliesByParent.values()) {
    result.push(...remaining);
  }
  result.push(...orphanedReplies);

  return result;
}

/**
 * Computes summary KPI metrics for the dataset.
 */
export function computeKpis(rows: Array<Record<string, any>>, duplicatesRemoved: number = 0): DatasetKpis {
  let totalViews = 0;
  let totalLikes = 0;
  let totalShares = 0;
  let totalComments = 0;
  let earliestDate: string | null = null;
  let latestDate: string | null = null;
  let totalCells = 0;
  let populatedCells = 0;

  for (const row of rows) {
    if (typeof row.views_count === "number") totalViews += row.views_count;
    if (typeof row.likes_count === "number") totalLikes += row.likes_count;
    if (typeof row.retweets_count === "number") totalShares += row.retweets_count;
    if (typeof row.replies_count === "number") totalComments += row.replies_count;

    if (row.published_at) {
      const dt = String(row.published_at);
      if (!earliestDate || dt < earliestDate) earliestDate = dt;
      if (!latestDate || dt > latestDate) latestDate = dt;
    }

    for (const val of Object.values(row)) {
      totalCells++;
      if (val !== null && val !== undefined && val !== "") populatedCells++;
    }
  }

  const completeness = totalCells > 0 ? Math.round((populatedCells / totalCells) * 100) : 100;

  return {
    totalRecords: rows.length,
    totalViews,
    totalLikes,
    totalShares,
    totalComments,
    earliestDate: earliestDate ? earliestDate.slice(0, 10) : null,
    latestDate: latestDate ? latestDate.slice(0, 10) : null,
    duplicatesRemoved,
    dataCompletenessPct: completeness,
  };
}

/**
 * Dynamically builds a codebook for all columns present in the dataset.
 */
export function generateDynamicCodebook(columns: string[], sampleRows: Array<Record<string, any>>): CodebookEntry[] {
  return columns.map((col) => {
    const known = COLUMN_METADATA_MAP[col];
    if (known) {
      return {
        field: col,
        titleAr: known.titleAr,
        descriptionAr: known.descAr,
        dataType: known.type,
      };
    }

    // Infer type from sample values
    let inferredType = "نص (String)";
    for (const r of sampleRows) {
      const v = r[col];
      if (typeof v === "number") {
        inferredType = Number.isInteger(v) ? "رقم صحيح (Integer)" : "رقم عشري (Float)";
        break;
      }
      if (typeof v === "boolean") {
        inferredType = "منطقي (Boolean)";
        break;
      }
      if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) {
        inferredType = "تاريخ ووقت (Date/Time)";
        break;
      }
    }

    return {
      field: col,
      titleAr: `حقل إضافي ${toArabicDigits(columns.slice(0, columns.indexOf(col) + 1).filter((field) => !COLUMN_METADATA_MAP[field]).length)}`,
      descriptionAr: "قيمة إضافية أعادها المصدر ولم يتوفر لها تصنيف تفصيلي.",
      dataType: inferredType,
    };
  });
}

/**
 * Unified Normalization Pipeline:
 * Validates, deduplicates, sanitizes, and enriches research datasets.
 */
export function normalizeDataset(
  rawPayload: any,
  options?: {
    platform?: string;
    title?: string;
    jobId?: string;
    targetRequested?: number | string | null;
    socialKind?: SocialRowKind | null;
  }
): NormalizedDataset {
  const meta = rawPayload?.metadata || {};
  const platform = options?.platform || meta.platform || detectPlatform(meta.template || options?.title || "");
  const title = options?.title || meta.title || `بيانات بحث ${platform}`;
  const dateStr = meta.collectedAt || new Date().toISOString();

  // 1. Extract Profile (if present)
  let cleanProfile: Record<string, any> | null = null;
  if (rawPayload?.profile && typeof rawPayload.profile === "object") {
    const p = scrubProviderLeaks(rawPayload.profile);
    cleanProfile = {
      username: p.uniqueId ? `@${String(p.uniqueId).replace(/^@/, "")}` : p.username ? `@${String(p.username).replace(/^@/, "")}` : undefined,
      display_name: p.nickname || p.displayName || p.name || "",
      bio: escapeFormula(p.signature || p.bio || p.description || ""),
      verified: Boolean(p.verified),
      followers_count: Number(p.followerCount ?? p.followers ?? p.followers_count ?? 0),
      following_count: Number(p.followingCount ?? p.following ?? p.following_count ?? 0),
      likes_count: Number(p.heartCount ?? p.likes ?? p.likes_count ?? 0),
      posts_count: Number(p.videoCount ?? p.postsCount ?? p.videos_count ?? 0),
      bio_link: p.bioLink || p.bio_link || "",
      profile_url: p.profileUrl || p.profile_url || "",
      collected_date: dateStr.slice(0, 10),
    };
  }

  // 2. Extract and Normalize Rows
  const rawRows: any[] = Array.isArray(rawPayload?.rows)
    ? rawPayload.rows
    : cleanProfile
    ? [cleanProfile]
    : [];

  const declaredSocialKind = options?.socialKind || meta.socialKind || inferSocialRowKind(meta.template, meta.platform, options?.title);
  const socialKind: SocialRowKind | null = declaredSocialKind === "comments" || declaredSocialKind === "videos" || declaredSocialKind === "posts" ? declaredSocialKind : null;
  const mappedRows = socialKind
    ? rawRows.map((r, i) => {
        // Social rows get one fixed Arabic schema whatever source answered; text is formula-escaped here.
        const social = normalizeSocialRow(socialKind, r && typeof r === "object" ? r : {});
        const out: Record<string, any> = { id: `rec_${i + 1}` };
        for (const [k, v] of Object.entries(social)) out[k] = typeof v === "string" ? escapeFormula(v) : v;
        return out;
      })
    : rawRows.map((r, i) => normalizeRecord(r, i));

  // The city of a company row, read from its address the same way the workbook does: a customer can split or sort
  // by «المدينة» because that column exists in the delivered data. A country is never a city.
  if (!socialKind) {
    for (const row of mappedRows) {
      if (row && typeof row === "object" && !row.city && (row.company_name || row.website || row.domain) && (row.location || row.address)) {
        const city = localizeCityFromAddress(String(row.address || row.location || ""), String(meta.country || ""));
        if (city !== "غير متاح") row.city = city;
      }
    }
  }

  // 3. Deduplicate and organize relational comment hierarchy
  const { uniqueRows: dedupedRows, duplicatesCount } = deduplicateRecords(mappedRows);
  const uniqueRows = organizeCommentHierarchy(dedupedRows);

  // 4. Determine Active Columns
  const columnSet = new Set<string>();
  // Preferred standard order
  const PREFERRED_ORDER = [
    "id",
    "source_id",
    "published_at",
    "username",
    "author_name",
    "display_name",
    "text",
    "comment_text",
    "bio",
    "verified",
    "followers_count",
    "likes_count",
    "retweets_count",
    "replies_count",
    "views_count",
    "is_reply",
    "parent_id",
    "url",
    "profile_url",
  ];

  for (const k of socialKind ? SOCIAL_COLUMN_ORDER[socialKind] : PREFERRED_ORDER) {
    if (uniqueRows.some((r) => r[k] !== undefined)) {
      columnSet.add(k);
    }
  }
  // Add any additional fields (social rows already carry only their fixed schema)
  for (const r of uniqueRows) {
    for (const k of Object.keys(r)) {
      columnSet.add(k);
    }
  }
  const columns = Array.from(columnSet);

  // 5. Compute KPIs & Codebook
  const kpis = computeKpis(uniqueRows, duplicatesCount);
  const codebook = generateDynamicCodebook(columns, uniqueRows.slice(0, 20));

  // 6. Determine Entity Type
  let entityType: "posts" | "comments" | "profile" | "search" | "tabular" | "companies" | "people" = "tabular";
  if (socialKind) {
    entityType = socialKind === "comments" ? "comments" : "posts";
  } else if (
    rawPayload?.entityType === "companies" ||
    rawPayload?.metadata?.entityType === "companies" ||
    meta.template?.includes("company") ||
    meta.template?.includes("companies") ||
    columns.includes("cr_number") ||
    columns.includes("domain") ||
    columns.includes("website_url") ||
    columns.includes("company_size")
  ) {
    entityType = "companies";
  } else if (
    rawPayload?.entityType === "people" ||
    rawPayload?.metadata?.entityType === "people" ||
    meta.template?.includes("people") ||
    columns.includes("contact_name") ||
    columns.includes("job_title")
  ) {
    entityType = "people";
  } else if (
    rawPayload?.entityType === "companies" ||
    rawPayload?.metadata?.entityType === "companies" ||
    meta.template?.includes("company") ||
    meta.template?.includes("companies") ||
    columns.includes("company_name")
  ) {
    entityType = "companies";
  } else if (columns.includes("comment_text") || columns.includes("parent_id")) {
    entityType = "comments";
  } else if (columns.includes("retweets_count") || columns.includes("tweet_id") || columns.includes("text")) {
    entityType = "posts";
  } else if (cleanProfile && uniqueRows.length <= 1) {
    entityType = "profile";
  }

  const methodologyText =
    meta.methodology ||
    "يعرض هذا التقرير السجلات التي أعادتها المصادر المتاحة ضمن نطاق البحث المحدد. تقيس نسبة اكتمال الحقول وجود القيم في السجلات، ولا تثبت صحتها أو شمول جميع الجهات في السوق.";

  return {
    metadata: {
      platform,
      title,
      jobId: options?.jobId || meta.jobId,
      collectedAt: dateStr,
      rowsCount: uniqueRows.length,
      methodology: methodologyText,
      entityType,
      targetRequested: options?.targetRequested !== undefined ? options.targetRequested : (meta.targetRequested !== undefined ? meta.targetRequested : null),
      reportContext: meta.reportContext && typeof meta.reportContext === "object" ? meta.reportContext : undefined,
      ...(socialKind ? { socialKind } : {}),
    },
    profile: cleanProfile,
    rows: uniqueRows,
    columns,
    codebook,
    kpis,
  };
}
