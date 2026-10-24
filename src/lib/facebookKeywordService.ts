/**
 * What is specific to the Facebook keyword service (`social-facebook-keyword-comments`): its identity, how its customer files speak of the thing a
 * comment sits under (a POST, never a video), and the size of its first chunk. Pure and free of server code, so the file builders, the live preview
 * and the worker all read the same words. Other services (TikTok, YouTube, the Facebook page services) keep their own words untouched.
 */
export const FACEBOOK_KEYWORD_SLUG = "social-facebook-keyword-comments";

export const isFacebookKeywordService = (identifier: unknown): boolean => String(identifier ?? "") === FACEBOOK_KEYWORD_SLUG;

/** Column titles of this service's customer files: the post, not the video. */
export const POST_COLUMN_TITLES_AR: Record<string, { titleAr: string; descAr: string }> = {
  video_title: { titleAr: "عنوان المنشور", descAr: "نص المنشور الذي كُتب عليه التعليق" },
  video_published_at: { titleAr: "تاريخ نشر المنشور", descAr: "تاريخ نشر المنشور الذي كُتب عليه التعليق، كما أوردها المصدر (قد يكون تقريبياً)" },
  video_url: { titleAr: "رابط المنشور", descAr: "رابط المنشور الذي كُتب عليه التعليق" },
};

/** The number that ties a comment to its row in the posts sheet. */
export const POST_NUMBER_KEY = "post_number";
export const POST_NUMBER_TITLE_AR = "رقم المنشور";
export const POST_NUMBER_DESC_AR = "رقم المنشور في ورقة «المنشورات» الذي كُتب عليه التعليق";
export const POSTS_SHEET_NAME_AR = "المنشورات";
export const POST_COMMENTS_DELIVERED_TITLE_AR = "عدد التعليقات المسلَّمة";

/** The columns that describe the post: in the comments sheet they are replaced by the post number (the posts sheet holds them once). */
export const POST_DETAIL_KEYS = ["video_title", "video_published_at", "video_url"] as const;

/** Customer files of this service never carry the platform's own comment id (an internal base64 identifier). */
export const INTERNAL_ID_KEYS = ["source_id"] as const;

/** The first chunk of a paged job reads one post's comments at most, so the customer sees accepted rows while the rest is still running. */
export const PAGED_FIRST_CHUNK_ROWS = 5;
