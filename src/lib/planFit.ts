import { reserveForUnits } from "./recordPricing";
import { getSocialCapability } from "./socialSources";
import { countAr, countKindOfSlug, planCountPartsAr } from "./planCounts";
import { toArabicDigits } from "./arabicDigits";
import { pointsAr } from "./pointsFormat";

/**
 * A request for posts AND their comments (two services, the comments reach from the posts) is bigger than one job can hold more often than
 * any other. It is fitted here, by code, to ONE consistent size: the comments per post the customer asked for are kept, the number of posts
 * is the most that fits the Facebook ceilings and the reserve under the per-job cap. The same function writes the sentence that says the
 * request was reduced and why; the model writes no number.
 */
export interface FitItem {
  capabilitySlug?: string;
  endpointId?: string;
  targetVolumeMax: number;
  unitPricePoints: number;
}

export type FitRole = "posts" | "comments";

/** Which side of a Facebook posts + comments pair a service is, from its own id; null for every other service. */
export function pairRoleOf(item: Pick<FitItem, "capabilitySlug" | "endpointId">): FitRole | null {
  const id = `${item.capabilitySlug || ""} ${item.endpointId || ""}`.toLowerCase();
  if (!/facebook/.test(id)) return null;
  if (/comment/.test(id)) return "comments";
  return /post|search/.test(id) ? "posts" : null;
}

/** The service's own ceilings for one job: 60 page posts, 500 comments (read from the capability table, which the owner's scale settings may raise for comments). */
export function facebookCeilings(): { posts: number; comments: number } {
  return {
    posts: getSocialCapability("social-facebook-posts")?.maxRows ?? 60,
    comments: getSocialCapability("social-facebook-comments")?.maxRows ?? 500,
  };
}

export type FitReason = "cap" | "ceiling";

export interface PairFit {
  /** Volumes in the order of the input items. */
  volumes: number[];
  /** What each item asked for, in the same order. */
  asked: number[];
  reduced: boolean;
  reason: FitReason | null;
  /** Comments per post kept from the request. */
  perPost: number;
}

/**
 * Null unless the items are exactly one Facebook posts service and one Facebook comments service. `original` is what the customer's plan asked for,
 * item by item (the items' own volumes may already have been lowered by the live capacity check): the comments per post are read from it, and the
 * sentence says what was asked, never an already reduced number.
 */
export function fitPostsAndComments(items: ReadonlyArray<FitItem>, capPoints: number, buffer: number, original?: ReadonlyArray<number>): PairFit | null {
  if (items.length !== 2) return null;
  const roles = items.map(pairRoleOf);
  const postsAt = roles.indexOf("posts");
  const commentsAt = roles.indexOf("comments");
  if (postsAt < 0 || commentsAt < 0) return null;
  const posts = items[postsAt];
  const comments = items[commentsAt];
  if (!(posts.unitPricePoints > 0) || !(comments.unitPricePoints > 0)) return null;

  const asks = original && original.length === 2 ? original : items.map((item) => item.targetVolumeMax);
  const askedPosts = Math.max(1, Math.floor(asks[postsAt]));
  const askedComments = Math.max(1, Math.floor(asks[commentsAt]));
  // what the plan holds now (the capacity check may have lowered it): the most posts this fit may keep
  const heldPosts = Math.max(1, Math.floor(posts.targetVolumeMax));
  const perPost = Math.max(1, askedComments / askedPosts);
  const ceiling = facebookCeilings();
  const commentsFor = (p: number) => Math.min(ceiling.comments, Math.max(1, Math.round(p * perPost)));
  const reserveOf = (p: number) => reserveForUnits(p, posts.unitPricePoints, buffer) + reserveForUnits(commentsFor(p), comments.unitPricePoints, buffer);

  const afterCeiling = Math.min(heldPosts, ceiling.posts, Math.max(1, Math.floor(ceiling.comments / perPost)));
  let finalPosts = afterCeiling;
  while (finalPosts > 1 && reserveOf(finalPosts) > capPoints) finalPosts -= 1;
  const finalComments = commentsFor(finalPosts);

  const reducedByCap = finalPosts < afterCeiling;
  const reducedByCeiling = afterCeiling < heldPosts || commentsFor(afterCeiling) < askedComments;
  const reduced = finalPosts !== askedPosts || finalComments !== askedComments;
  const volumes = [0, 0];
  volumes[postsAt] = finalPosts;
  volumes[commentsAt] = finalComments;
  const asked = [0, 0];
  asked[postsAt] = askedPosts;
  asked[commentsAt] = askedComments;
  return { volumes, asked, reduced, reason: !reduced ? null : reducedByCap ? "cap" : reducedByCeiling ? "ceiling" : "cap", perPost: Math.max(1, Math.round(finalComments / finalPosts)) };
}

export interface FitNoticeInput {
  items: ReadonlyArray<{ capabilitySlug?: string; endpointId?: string; targetVolumeMax: number }>;
  asked: ReadonlyArray<number>;
  reason: FitReason;
  pointsCap: number;
  perPost: number;
}

/**
 * «طلبت … وتم تقليل الطلب إلى …»: the one sentence that says the request was reduced to fit, with both sizes and the reason. Numbers come from
 * the quote; the sentence is the same on the card, in the chat text and in the quote record.
 */
export function fitNoticeAr(input: FitNoticeInput): string {
  const askedItems = input.items.map((item, i) => ({ ...item, targetVolumeMax: input.asked[i] }));
  const askedText = planCountPartsAr(askedItems);
  const fittedText = planCountPartsAr(input.items);
  const reasonText = input.reason === "ceiling"
    ? "حدّ الخدمة في الطلب الواحد"
    : `حدّ الطلب الواحد (حجز لا يتجاوز ${pointsAr(input.pointsCap, toArabicDigits)})`;
  const perPostText = input.perPost > 1 ? ` (حتى ${countAr(input.perPost, "comments")} لكل منشور)` : "";
  return `طلبت ${askedText}، وتم تقليل الطلب إلى ${fittedText}${perPostText} ليناسب ${reasonText}، وليس رصيدك. يمكنك طلب الباقي في طلب منفصل.`;
}

export { countKindOfSlug };
