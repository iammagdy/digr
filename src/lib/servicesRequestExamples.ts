/**
 * THE CATALOG BY PLATFORM, in the customer's words: for each platform the customer knows, a few sentences that start «تقدر تطلب…» and say what they can ask for, and the example form that starts such a
 * request (the start page opens it from `?template=<id>`). No service name, no technical word, no provider, no status and no price: those stay in the full list below the page's main block.
 * The examples are the kinds of request the start page's forms build, so a line here always leads to a form that can send it.
 */
export interface PlatformRequestGroup {
  id: string;
  nameAr: string;
  /** The sentences, each one starting «تقدر تطلب». */
  examplesAr: readonly string[];
  /** The id of the start page's form that opens the first kind of request (see templateForms.ts). */
  templateId: string;
}

export const PLATFORM_REQUEST_GROUPS: readonly PlatformRequestGroup[] = [
  {
    id: "facebook",
    nameAr: "فيسبوك",
    examplesAr: ["تقدر تطلب تعليقات منشور أو فيديو بعينه.", "تقدر تطلب أحدث المنشورات العامة لصفحة.", "تقدر تطلب منشورات وفيديوهات عن موضوع معين في دولة تختارها."],
    templateId: "facebook_topic",
  },
  {
    id: "tiktok",
    nameAr: "تيك توك",
    examplesAr: ["تقدر تطلب تعليقات فيديو بعينه.", "تقدر تطلب أعلى فيديوهات عدة حسابات مع تعليقاتها.", "تقدر تطلب أحدث منشورات حساب عام."],
    templateId: "top_videos_comments",
  },
  {
    id: "youtube",
    nameAr: "يوتيوب",
    examplesAr: ["تقدر تطلب تعليقات فيديو بعينه.", "تقدر تطلب أعلى فيديوهات عدة قنوات مع تعليقاتها.", "تقدر تطلب أحدث فيديوهات قناة."],
    templateId: "video_comments",
  },
  {
    id: "x",
    nameAr: "إكس",
    examplesAr: ["تقدر تطلب تغريدات عن موضوع أو حدث في فترة تحددها.", "تقدر تطلب أحدث تغريدات حساب عام."],
    templateId: "topic_tweets",
  },
  {
    id: "companies",
    nameAr: "الشركات وصناع القرار",
    examplesAr: ["تقدر تطلب قائمة شركات في نشاط ودولة تختارهما.", "تقدر تطلب صناع القرار في كل شركة مع البريد المهني والهاتف عند توفرهما."],
    templateId: "companies",
  },
];

/** The address that opens a platform's example form on the start page. */
export const startRequestHref = (templateId: string): string => `/dashboard/chat?template=${encodeURIComponent(templateId)}`;
