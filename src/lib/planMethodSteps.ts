/**
 * The methodology steps of a social plan card, as Arabic sentences. A plan read from a PAGE (a Page link or name: the plan's `channel` parameter) says the
 * posts are read from that page; a topic plan says the content is searched by the topic. Pure: no network, no provider name, no English.
 */
export interface SocialSearchStepInput {
  /** The posts or videos of the plan (the noun of the sentence). */
  isVideoPlan: boolean;
  /** The plan's trending feed (no topic). */
  trending: boolean;
  /** The topic as the card shows it (already Arabic). */
  displayIndustry: string;
  /** The requested country, as the card shows it. Empty when none was given: the sentence then leaves the place out. */
  countryAr: string;
  /** The page the posts are read from (a link or a username), or null for a topic plan. Never printed: the sentence says «الصفحة التي حددتها». */
  pageChannel: string | null;
}

export function socialSearchStepAr(input: SocialSearchStepInput): string {
  if (input.pageChannel) return `قراءة ${input.isVideoPlan ? "الفيديوهات" : "المنشورات"} مباشرة من الصفحة التي حددتها على المنصة، ضمن الفترة المطلوبة.`;
  if (input.trending) return `البحث عن ${input.displayIndustry} على المنصة المحددة${input.countryAr ? ` ضمن النطاق ${input.countryAr}` : ""}.`;
  return `البحث عن ${input.isVideoPlan ? "الفيديوهات" : "المحتوى"} المنشور حول «${input.displayIndustry}» على المنصة المحددة.`;
}

export function socialFilterStepAr(input: { pageChannel: string | null; displayIndustry: string }): string {
  if (input.pageChannel) return "فرز المنشورات حسب الفترة الزمنية المطلوبة، دون تصفية بالموضوع لأنها من صفحة محددة.";
  return `فرز النتائج حسب صلتها بموضوع «${input.displayIndustry}» والفترة الزمنية المطلوبة.`;
}

/**
 * The page a Facebook plan reads its posts from, or null. A Page link or name is the plan's `channel` (the posts plan) or the first of its `channels`
 * (the comments plan of a page). A channel of another platform is not a page and gets null.
 */
export function pageChannelOfItem(item: { capabilitySlug?: string; params?: Record<string, any> } | null | undefined): string | null {
  if (!/facebook/i.test(String(item?.capabilitySlug || ""))) return null;
  const params = item?.params || {};
  if (typeof params.channel === "string" && params.channel.trim()) return params.channel.trim();
  const first = Array.isArray(params.channels) ? params.channels[0] : undefined;
  return typeof first === "string" && first.trim() ? first.trim() : null;
}

/**
 * The identifier of a Facebook page as the card shows it: the handle («youm7») from a link («https://www.facebook.com/youm7/», «facebook.com/youm7»), or the
 * name as typed when it is already a handle («@youm7»). Never a URL scheme, a host or a path after the handle.
 */
export function pageHandleOf(channel: string): string {
  const cleaned = channel.trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^(?:www\.|m\.)/i, "")
    .replace(/^facebook\.com\//i, "")
    .replace(/^@/, "");
  const handle = cleaned.split(/[/?#]/)[0].trim();
  return handle || channel.trim();
}
