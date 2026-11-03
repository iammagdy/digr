import { describe, expect, it } from "vitest";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { chooseCard } from "../src/lib/agentMission/foundation/compilePlan";
import { COMMENT_ID_PROOFS, MAX_COMMENT_ALTERNATIVES, commentsAlternativesOf, idsProvenEqual } from "../src/lib/agentMission/foundation/alternatives";
import { TOOL_CARDS, cardMapCode, cardOf, cardsFor, type ToolCard } from "../src/lib/agentMission/foundation/toolCards";

/**
 * ROUND 16, PART 1: THE COMMENTS ALTERNATIVES OF A COMPILED STAGE, decided by code before approval (pure: no call, no model). Each case says which card is the primary and which cards are kept or left out, and WHY (the reason is a code, never shown to a customer).
 * The cases that use a card written inside this file are SYNTHETIC (named so): they prove the rule, not a provider.
 */
const NOW = Date.parse("2026-11-03T12:00:00Z");
const ask = (request: string, platform: string) => buildAsk(`${request} ${platform}`, null, NOW);
const parentsWith = (n: number, extra: Record<string, unknown> = {}): Array<Record<string, unknown>> => Array.from({ length: n }, (_, i) => ({ id: String(1000 + i), link: `https://example.test/p/${i}/`, comments: 40, ...extra }));
const primaryOf = (platform: "instagram" | "facebook" | "tiktok" | "youtube", options: { catalogOnly?: boolean; replies?: boolean } = {}): ToolCard => {
  const a = ask("هات ٣ منشورات مع التعليقات", platform === "instagram" ? "إنستجرام" : platform === "facebook" ? "فيسبوك" : platform === "tiktok" ? "تيك توك" : "يوتيوب");
  const repliesCards = options.replies ? cardsFor(platform, "comment.replies", { catalogOnly: options.catalogOnly === true }) : [];
  return chooseCard({ ...a, platform }, "comments", { catalogOnly: options.catalogOnly === true, repliesCards })!;
};

describe("the real cards today (confirmed from the code)", () => {
  it("Instagram: the primary is the cheaper page, the other verified comments card is the one alternative, kept (its ids are proven equal on stored pages)", () => {
    const primary = primaryOf("instagram");
    expect(primary.endpointId).toBe("anyapi.instagram.post.comments");
    const r = commentsAlternativesOf({ platform: "instagram", primary, parents: parentsWith(3), repliesCard: null, catalogOnly: false });
    expect(r.alternatives.map((a) => a.entry.endpoint_id)).toEqual(["scrapecreators.instagram.post.comments"]);
    const alt = r.alternatives[0];
    const card = cardOf("scrapecreators.instagram.post.comments")!;
    expect(alt.capture).toBe(false);
    expect(alt.entry).toMatchObject({ endpoint_id: card.endpointId, cursor_param: "cursor", map_file_id: "page", parent_binding: { param: "url", from: "link" }, params: {} });
    expect(alt.entry.map_code).toBe(cardMapCode(card));
    expect(alt.entry.cost_per_row_usd).toBeCloseTo(card.costUsdPerPage / card.page.observedRowsPerPage, 10);
    expect(alt.entry.parent_binding && "also" in alt.entry.parent_binding).toBe(false);
  });
  it("Instagram with replies asked: the alternative must carry what the replies card needs (the comment's id, the post's link): both comments cards give the comment id, so it stays", () => {
    const repliesCard = cardOf("anyapi.instagram.comment_replies")!;
    const r = commentsAlternativesOf({ platform: "instagram", primary: primaryOf("instagram", { replies: true }), parents: parentsWith(3), repliesCard, catalogOnly: false });
    expect(r.alternatives.map((a) => a.entry.endpoint_id)).toEqual(["scrapecreators.instagram.post.comments"]);
  });
  it("Facebook, a customer account: one verified comments card, so no alternative; the catalog_only card is left out because of its status", () => {
    const r = commentsAlternativesOf({ platform: "facebook", primary: primaryOf("facebook"), parents: parentsWith(3), repliesCard: null, catalogOnly: false });
    expect(r.alternatives).toEqual([]);
    expect(r.excluded).toEqual([{ endpointId: "anyapi.facebook.post_comments", reason: "status" }]);
  });
  it("TikTok: one verified comments card, no alternative", () => {
    const r = commentsAlternativesOf({ platform: "tiktok", primary: primaryOf("tiktok"), parents: parentsWith(3), repliesCard: null, catalogOnly: false });
    expect(r.alternatives).toEqual([]);
  });
  it("X has no comments card at all (its replies are the child stage): nothing to alternate", () => {
    expect(TOOL_CARDS.filter((c) => c.platform === "x" && c.role === "post.comments")).toEqual([]);
  });
  it("YouTube: the non-paginated card is left out, with replies asked because it carries no reply token, without them because its dates are not the primary's kind (it would deliver empty dates the file does not explain)", () => {
    const primary = primaryOf("youtube", { replies: true });
    expect(primary.endpointId).toBe("tikhub.youtube.video.comments");
    const withReplies = commentsAlternativesOf({ platform: "youtube", primary, parents: parentsWith(2, { link: "https://www.youtube.com/watch?v=x" }), repliesCard: cardOf("anyapi.youtube.comment_replies")!, catalogOnly: false });
    expect(withReplies.alternatives).toEqual([]);
    expect(withReplies.excluded).toEqual([{ endpointId: "crawl4ai.youtube.video.comments", reason: "replies_identity" }]);
    const without = commentsAlternativesOf({ platform: "youtube", primary: primaryOf("youtube"), parents: parentsWith(2), repliesCard: null, catalogOnly: false });
    expect(without.alternatives).toEqual([]);
    expect(without.excluded).toEqual([{ endpointId: "crawl4ai.youtube.video.comments", reason: "date_semantics" }]);
  });
});

describe("decision 2: a catalog_only comments card is an alternative on a TEST account only, and only for a comments stage", () => {
  it("Facebook, a test account, comments only: the second card is kept and marked as a capture; the customer's account gets none", () => {
    const primary = primaryOf("facebook", { catalogOnly: true });
    expect(primary.endpointId).toBe("scrapecreators.x.v1-facebook-post-comments");
    const test = commentsAlternativesOf({ platform: "facebook", primary, parents: parentsWith(3), repliesCard: null, catalogOnly: true });
    expect(test.alternatives.map((a) => [a.entry.endpoint_id, a.capture])).toEqual([["anyapi.facebook.post_comments", true]]);
    const customer = commentsAlternativesOf({ platform: "facebook", primary, parents: parentsWith(3), repliesCard: null, catalogOnly: false });
    expect(customer.alternatives).toEqual([]);
  });
  it("Facebook, a test account, replies planned: the second card carries neither feedback_id nor expansion_token, so it is left out", () => {
    const primary = primaryOf("facebook", { catalogOnly: true, replies: true });
    const r = commentsAlternativesOf({ platform: "facebook", primary, parents: parentsWith(3), repliesCard: cardOf("anyapi.facebook.comment_replies")!, catalogOnly: true });
    expect(r.alternatives).toEqual([]);
    expect(r.excluded).toEqual([{ endpointId: "anyapi.facebook.post_comments", reason: "replies_identity" }]);
  });
});

describe("SYNTHETIC cards: every compatibility rule fails closed, before approval", () => {
  const base = cardOf("anyapi.instagram.post.comments")!;
  const synthetic = (endpointId: string, patch: Partial<ToolCard> = {}): ToolCard => ({ ...base, endpointId, verifiedOn: [{ mission: "msn_synthetic", calls: ["call_0001"] }], ...patch });
  const proofs = (...ids: string[]) => ids.map((b) => ({ a: base.endpointId, b, mission: { a: "msn_synthetic", b: "msn_synthetic" }, calls: { a: ["call_0001"], b: ["call_0002"] } }));
  const run = (cards: ToolCard[], options: { parents?: Array<Record<string, unknown>>; repliesCard?: ToolCard | null; idProofs?: ReturnType<typeof proofs> } = {}) =>
    commentsAlternativesOf({ platform: "instagram", primary: base, parents: options.parents ?? parentsWith(3), repliesCard: options.repliesCard ?? null, catalogOnly: false, cards: [base, ...cards], idProofs: options.idProofs ?? proofs(...cards.map((c) => c.endpointId)) });

  it("kept when it meets every rule", () => {
    expect(run([synthetic("syn.a.comments")]).alternatives.map((a) => a.entry.endpoint_id)).toEqual(["syn.a.comments"]);
  });
  it("the same endpoint as the primary is never an alternative", () => {
    expect(run([synthetic(base.endpointId)]).alternatives).toEqual([]);
  });
  it("a card with no stored evidence is left out (a customer never gets an unproven tool)", () => {
    const r = run([synthetic("syn.noevidence", { verifiedOn: [] })]);
    expect(r.alternatives).toEqual([]);
    expect(r.excluded).toEqual([{ endpointId: "syn.noevidence", reason: "no_evidence" }]);
  });
  it("a broken card or a catalog_only card on a customer account is left out", () => {
    expect(run([synthetic("syn.broken", { status: "broken" })]).excluded).toEqual([{ endpointId: "syn.broken", reason: "status" }]);
    expect(run([synthetic("syn.catalog", { status: "catalog_only", verifiedOn: [] })]).excluded).toEqual([{ endpointId: "syn.catalog", reason: "status" }]);
  });
  it("its input must bind to a value present on EVERY pinned parent: one parent without the link excludes it", () => {
    const parents = [...parentsWith(2), { id: "9", comments: 3 }];
    expect(run([synthetic("syn.a.comments")], { parents }).excluded).toEqual([{ endpointId: "syn.a.comments", reason: "parent_value_missing" }]);
  });
  it("a card with no parent input, or one that needs more than one identity (parent_binding.also, a grandparent), is left out: the engine forwards neither", () => {
    expect(run([synthetic("syn.noparent", { inputs: { cursor: "cursor" } })]).excluded).toEqual([{ endpointId: "syn.noparent", reason: "no_parent_input" }]);
    expect(run([synthetic("syn.also", { inputs: { cursor: "cursor", parent: { param: "url", from: "link", also: [{ param: "id", from: "id" }] } } })]).excluded).toEqual([{ endpointId: "syn.also", reason: "needs_also" }]);
    expect(run([synthetic("syn.grand", { inputs: { cursor: "cursor", parent: { param: "url", from: "link", also: [{ param: "u", from: "link", grand: true }] } } })]).excluded).toEqual([{ endpointId: "syn.grand", reason: "needs_also" }]);
  });
  it("a card whose mapping is not the comments mapping is left out (its rows would not have the stage's columns)", () => {
    const fields = { kind: "fields", fields: { id: ["id"] } } as ToolCard["mapping"];
    expect(run([synthetic("syn.fields", { mapping: fields })]).excluded).toEqual([{ endpointId: "syn.fields", reason: "mapping" }]);
  });
  it("its ids must be PROVEN equal to the primary's on stored pages: with no proof it is left out (never merged by text, author or time)", () => {
    const r = run([synthetic("syn.unproven")], { idProofs: [] });
    expect(r.alternatives).toEqual([]);
    expect(r.excluded).toEqual([{ endpointId: "syn.unproven", reason: "ids_unproven" }]);
  });
  it("when a replies stage is planned the alternative must carry every identity the replies card needs", () => {
    const repliesNeedingToken = synthetic("syn.replies", { role: "comment.replies", inputs: { cursor: "cursor", parent: { param: "t", from: "reply_token" } } });
    expect(run([synthetic("syn.a.comments")], { repliesCard: repliesNeedingToken }).excluded).toEqual([{ endpointId: "syn.a.comments", reason: "replies_identity" }]);
    const withToken = synthetic("syn.tok", { mapping: { kind: "replies", tokens: [{ key: "reply_token" }] } });
    const primaryWithToken = { ...base, mapping: { kind: "replies", tokens: [{ key: "reply_token" }] } } as ToolCard;
    const r = commentsAlternativesOf({ platform: "instagram", primary: primaryWithToken, parents: parentsWith(2), repliesCard: repliesNeedingToken, catalogOnly: false, cards: [primaryWithToken, withToken], idProofs: proofs("syn.tok") });
    expect(r.alternatives.map((a) => a.entry.endpoint_id)).toEqual(["syn.tok"]);
  });
  it("at most two alternatives, ordered: compatible first, fewer conditions it cannot carry, a page cursor before none, the cheaper row, then the endpoint id", () => {
    const cards = [
      synthetic("syn.e", { costUsdPerPage: 0.01 }),
      synthetic("syn.d", { costUsdPerPage: 0.001 }),
      synthetic("syn.c", { inputs: { cursor: null, parent: { param: "url", from: "link" } }, costUsdPerPage: 0.0001 }),
      synthetic("syn.b", { costUsdPerPage: 0.001 }),
      synthetic("syn.a", { cannot: ["country"], costUsdPerPage: 0.0001 }),
    ];
    const r = run(cards);
    expect(MAX_COMMENT_ALTERNATIVES).toBe(2);
    expect(r.alternatives.map((a) => a.entry.endpoint_id)).toEqual(["syn.b", "syn.d"]);
  });
  it("a different platform or role never qualifies: the candidates come from cardsFor(platform, the comments role)", () => {
    expect(run([synthetic("syn.tiktok", { platform: "tiktok" })]).alternatives).toEqual([]);
    expect(run([synthetic("syn.role", { role: "video.comments" })]).alternatives).toEqual([]);
  });
});

describe("the id proofs are data, with the stored pages they were taken from", () => {
  it("Instagram's two comments cards and YouTube's two are proven equal; nothing else is", () => {
    expect(COMMENT_ID_PROOFS.map((p) => [p.a, p.b]).sort()).toEqual([
      ["anyapi.instagram.post.comments", "scrapecreators.instagram.post.comments"],
      ["crawl4ai.youtube.video.comments", "tikhub.youtube.video.comments"],
    ]);
    expect(idsProvenEqual("scrapecreators.instagram.post.comments", "anyapi.instagram.post.comments")).toBe(true);
    expect(idsProvenEqual("anyapi.facebook.post_comments", "scrapecreators.x.v1-facebook-post-comments")).toBe(false);
  });
});
