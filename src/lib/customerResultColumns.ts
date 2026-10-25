import { POST_COLUMN_TITLES_AR } from "./facebookKeywordService";
import { COMPANY_SCREEN_ORDER } from "./companyColumns";
/** Arabic labels for source-native result fields that can reach the live results table. */
const RESULT_COLUMN_LABELS: Record<string, string> = {
  id: "معرّف السجل",
  source_id: "معرّف المصدر",
  author_name: "اسم الناشر",
  authorName: "اسم الناشر",
  author_username: "اسم المستخدم",
  authorUsername: "اسم المستخدم",
  username: "اسم المستخدم",
  authorVerified: "حالة توثيق الحساب",
  verified: "حالة توثيق الحساب",
  authorFollowers: "عدد المتابعين",
  followers_count: "عدد المتابعين",
  authorId: "معرّف الحساب",
  authorImage: "صورة الحساب",
  text: "نص المحتوى",
  comment_text: "نص التعليق",
  video_caption: "وصف الفيديو",
  video_title: "عنوان الفيديو",
  channel_name: "اسم القناة أو الحساب",
  video_url: "رابط الفيديو",
  video_published_at: "تاريخ نشر الفيديو",
  post_number: "رقم المنشور",
  comment_language: "لغة التعليق",
  url: "الرابط المباشر",
  published_at: "تاريخ النشر",
  createdUtc: "تاريخ النشر",
  created_at: "تاريخ النشر",
  is_reply: "هل هو رد؟",
  isReply: "هل هو رد؟",
  inReplyToId: "معرّف المنشور الأصلي",
  conversationId: "معرّف المحادثة",
  lang: "لغة المحتوى",
  language: "لغة المحتوى",
  likes: "عدد الإعجابات",
  likes_count: "عدد الإعجابات",
  likeCount: "عدد الإعجابات",
  bookmarkCount: "عدد مرات الحفظ",
  retweetCount: "عدد مرات إعادة النشر",
  retweet_count: "عدد مرات إعادة النشر",
  quoteCount: "عدد الاقتباسات",
  replyCount: "عدد الردود",
  replies_count: "عدد الردود",
  comments_count: "عدد التعليقات",
  viewCount: "عدد المشاهدات",
  views_count: "عدد المشاهدات",
  shares_count: "عدد المشاركات",
  saves_count: "عدد مرات الحفظ",
  media: "الوسائط المرفقة",
  video_duration: "مدة الفيديو",
  company_name: "اسم الشركة أو المؤسسة",
  industry: "النشاط أو التخصص",
  website: "الموقع الإلكتروني",
  linkedin_url: "رابط لينكد إن",
  location: "الموقع الجغرافي",
  description: "الوصف التعريفي",
  work_email: "البريد الإلكتروني المهني",
  phone: "رقم الهاتف التجاري",
  work_email_presence_status: "توفر البريد المهني",
  phone_presence_status: "توفر الهاتف التجاري",
  job_title_presence_status: "توفر المسمى الوظيفي",
  work_email_verification_status: "حالة التحقق من البريد",
  phone_verification_status: "حالة التحقق من الهاتف",
  founded_year: "سنة التأسيس",
  headcount: "حجم العمالة",
  contact_name: "اسم جهة الاتصال",
  contact_name_presence_status: "توفر اسم جهة الاتصال",
  job_title: "المسمى الوظيفي",
  city: "المدينة",
  tweet_id: "معرّف المنشور",
  video_id: "معرّف المقطع",
  comment_id: "معرّف التعليق",
  parent_id: "معرّف التعليق الأصلي",
  display_name: "الاسم المعروض",
  bio: "النبذة التعريفية",
  author_verified: "حساب موثّق",
  followers: "عدد المتابعين",
  following: "الحسابات المتابَعة",
  following_count: "الحسابات المتابَعة",
  retweets_count: "عدد مرات إعادة النشر",
  quotes_count: "عدد الاقتباسات",
  views: "عدد المشاهدات",
  videos_count: "عدد مقاطع الفيديو",
  profile_url: "رابط الملف الشخصي",
  bio_link: "الرابط الخارجي بالملف",
  pinned: "تعليق مثبّت",
  hearted_by_creator: "أعجب به صاحب المحتوى",
  hashtags: "الوسوم",
  collected_date: "تاريخ الاستخراج",
  // The page of the company's own website a contact was read from (multi-provider contact data).
  source_page: "صفحة المصدر على موقع الشركة",
};

/** Shown for a field with no known Arabic title: the customer never sees a technical field name. */
export const UNKNOWN_COLUMN_LABEL_AR = "بيانات إضافية";

export function customerResultColumnLabel(key: string, postUnit = false): string {
  // The Facebook keyword service speaks of posts: its comment tables say «المنشور» where other services say «الفيديو».
  if (postUnit && POST_COLUMN_TITLES_AR[key]) return POST_COLUMN_TITLES_AR[key].titleAr;
  const known = RESULT_COLUMN_LABELS[key];
  if (known) return known;
  // A title already in Arabic stays; anything with Latin letters or underscores is a technical name.
  return /[A-Za-z_]/.test(key) ? UNKNOWN_COLUMN_LABEL_AR : key;
}

/**
 * Identifiers and links of a social record belong in the delivered file, not in the on-screen preview: the preview shows
 * what the customer reads (the text, the author, the date, the counts). A company's website is its own content and stays.
 */
const PREVIEW_HIDDEN_SOCIAL_COLUMNS = new Set([
  "id", "source_id", "tweet_id", "video_id", "comment_id", "parent_id",
  "url", "video_url", "profile_url", "bio_link",
]);

/**
 * A Facebook table always carries the link to its post: the posts table hides the plain link column like every other social table, so
 * the link column of the data (the post's own address) is added back when none is shown. Other platforms keep their columns.
 */
export function ensurePostLinkColumn(shown: string[], available: readonly string[], platform: string | undefined | null): string[] {
  if (String(platform || "").toLowerCase() !== "facebook") return shown;
  if (shown.includes("url") || shown.includes("video_url")) return shown;
  const link = (["url", "video_url"] as const).find((key) => available.includes(key));
  return link ? [...shown, link] : shown;
}

export function previewColumns(columns: string[], isCompanyDataset: boolean): string[] {
  if (isCompanyDataset) return columns.filter((key) => key !== "id" && key !== "source_id");
  // A comment is read with the video it sits under: the video's title and link stay in the preview of a comments table.
  const isComments = columns.includes("comment_text");
  return columns.filter((key) => !PREVIEW_HIDDEN_SOCIAL_COLUMNS.has(key) || (isComments && key === "video_url"));
}

/** The columns that say whether a field was found (present or not, verified or not): useful to audit, never the first thing a customer reads. */
export function isAvailabilityColumn(key: string): boolean {
  return /(?:_presence_status|_verification_status)$/.test(key);
}

/** What a reader looks at first, in order. A column not listed keeps its place after these, and the availability columns come last of all. */
const USEFUL_FIRST = [
  // the company columns follow the ONE shared company list (workbook and screen), a person's name and title come first
  "contact_name", "job_title", ...COMPANY_SCREEN_ORDER.filter((key) => !/_verification_status$/.test(key)), "location",
  "comment_text", "text", "video_title", "video_caption", "author_name", "authorName", "username", "published_at", "video_published_at", "created_at", "createdUtc",
  "likes", "likes_count", "replies_count", "views_count", "followers", "followers_count", "description",
];

/** Useful columns first, availability columns last; the order inside each group is the data's own (stable). */
export function orderPreviewColumns(columns: readonly string[]): string[] {
  const rank = (key: string) => (isAvailabilityColumn(key) ? 2000 : USEFUL_FIRST.indexOf(key) >= 0 ? USEFUL_FIRST.indexOf(key) : 1000);
  return columns.map((key, index) => ({ key, index })).sort((a, b) => rank(a.key) - rank(b.key) || a.index - b.index).map((entry) => entry.key);
}

const isEmptyCell = (value: unknown) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");

/**
 * The columns with a value in at least one row, and the columns that are empty in EVERY row (hidden by default: an empty availability column is noise).
 * An empty column is reported, never dropped silently, so the screen can say which promised field came back empty.
 */
export function splitEmptyColumns(records: ReadonlyArray<Record<string, unknown>>, columns: readonly string[]): { shown: string[]; empty: string[] } {
  const shown: string[] = [];
  const empty: string[] = [];
  for (const key of columns) (records.some((record) => !isEmptyCell(record[key])) ? shown : empty).push(key);
  return { shown, empty };
}

/** The promised contact fields that came back empty in EVERY delivered row (a field the plan promised and the source never returned), as Arabic titles. */
export function emptyPromisedFieldTitles(records: ReadonlyArray<Record<string, unknown>>, promised: readonly string[]): string[] {
  if (records.length === 0) return [];
  const titles: Record<string, string> = { work_email: "البريد المهني", phone: "الهاتف التجاري" };
  return promised.filter((key) => titles[key] && records.every((record) => isEmptyCell(record[key]))).map((key) => titles[key]);
}
