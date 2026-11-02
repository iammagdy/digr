import type { CatalogEndpoint, TregCatalog } from "../../src/lib/treg/catalog";

/** The five social platforms and the four request types of the consolidation (docs/S1-LIVE-FINDINGS.md, «Consolidation»). */
export const SOCIAL_PLATFORMS = ["tiktok", "instagram", "facebook", "youtube", "x"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
export const REQUEST_TYPES = ["search", "account", "comments", "replies"] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];
export const REQUEST_TYPE_AR: Record<RequestType, string> = { search: "بحث منشورات", account: "منشورات حساب", comments: "تعليقات", replies: "ردود" };

/** The catalog capability each request type reads on each platform (null: the catalog has none; the matrix says so from the catalog). */
export const CAPABILITY: Record<SocialPlatform, Record<RequestType, string | null>> = {
  tiktok: { search: "tiktok.search.videos", account: "tiktok.user.videos", comments: "tiktok.video.comments", replies: "tiktok.comment.replies" },
  instagram: { search: "instagram.search.reels", account: "instagram.user.posts", comments: "instagram.post.comments", replies: "instagram.comment.replies" },
  facebook: { search: "facebook.search.posts", account: "facebook.user.posts", comments: "facebook.post.comments", replies: "facebook.comment.replies" },
  youtube: { search: "youtube.search.videos", account: "youtube.channel.videos", comments: "youtube.video.comments", replies: "youtube.comment.replies" },
  x: { search: "x.search.posts", account: "x.user.posts", comments: "x.post.comments", replies: null },
};

/** The direct, synchronous endpoints of the platform's capability for a request type. */
export function capabilitiesOf(catalog: TregCatalog, platform: SocialPlatform, type: RequestType): CatalogEndpoint[] {
  const capability = CAPABILITY[platform][type];
  if (!capability) return [];
  return catalog.endpoints.filter((e) => e.platform === platform && e.capability === capability && e.kind === "direct" && !e.async);
}
