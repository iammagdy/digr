import { POST_COLUMN_TITLES_AR } from "./facebookKeywordService";
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
