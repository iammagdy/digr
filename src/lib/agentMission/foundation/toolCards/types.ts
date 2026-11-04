import type { SocialPlatform } from "../../redesignFlagTypes";

/**
 * F2, A TOOL CARD (docs/FOUNDATION-PLAN.md section 3.1): what one endpoint really does, written as DATA and verified on stored real pages (`verify.ts`). The role is the card's
 * own, independent of the catalog's capability. The compiler reads only cards: which inputs carry which condition of the Ask, where the list and the next page are, which field
 * of an item is its id, its text, its date, its author, its counter. The mapping code of a stage is generated from the card (`mapCode.ts`), never written by a model.
 */
export type CardRole =
  | "videos.search" | "tweets.search" | "video.comments" | "comment.replies" | "tweet.replies"
  // PR 3: Facebook (a keyword search with dates, a page listing), Instagram (an account listing), YouTube (a channel search, a search inside a channel, a counter card) and their comments
  | "posts.search" | "posts.page" | "posts.account" | "post.comments" | "channels.search" | "videos.channel" | "videos.counter";
export type CardStatus = "verified" | "catalog_only" | "broken";

/** A path inside a page or an item: the keys to follow. */
export type FieldPath = ReadonlyArray<string>;

export interface CardInputs {
  /** The input that takes the topic (the customer's own words). `operators`: the query of a search that takes `since:` / `until:` / `lang:` operators. */
  query?: { field: string; operators?: boolean; quoted?: boolean; /** The named page's name joins the keyword (a keyword search that has no input for the page). */ withSource?: true; /** The source cannot be asked with no words (a keyword search): the card is not eligible for a request with no topic. */ required?: true };
  /** The inputs that take the period as two Cairo calendar days (YYYY-MM-DD, inclusive): the start and the end day. */
  period?: { from: string; to: string };
  /** The input that takes the named source (an account's handle, a page's link, a channel's id): a card with it is eligible only when the Ask's source can be written there. */
  source?: { param: string; kind: "handle" | "page_url" | "channel_id" };
  /** A counter card (YouTube's detail): the input that takes up to `max` ids of the pool's rows at once. */
  ids?: { param: string; max: number };
  /** The input that places the request in a country (a REQUEST to the source, never a proof: the rows' own country decides the choice). */
  country?: { field: string };
  /** The input of the order, and its value for the owner's two orders. */
  order?: { field: string; most_commented?: string | number; newest?: string | number };
  /** The page size input and the value the card asks for. */
  pageSize?: { field: string; value: number };
  /** The paging input (the engine adds it for the next pages), or null: one page. */
  cursor: string | null;
  /** A child tool: the input that takes a field of the parent row, and the other identity inputs sent beside it. */
  parent?: { param: string; from: string; also?: Array<{ param: string; from: string; grand?: true }> };
  /** Inputs the card sends on EVERY call of its stage, as they are (data, never from the customer's words): the X replies card asks for a source that can return a next page. The catalog entry must declare each of them, or the gateway drops it. */
  fixed?: Readonly<Record<string, unknown>>;
}

export interface ToolCard {
  endpointId: string;
  platform: SocialPlatform;
  role: CardRole;
  status: CardStatus;
  inputs: CardInputs;
  /** Where the items are in a page, and the path inside each item where its fields start (TikHub wraps each video in `aweme_info`). */
  page: { list: FieldPath; item?: FieldPath; cursor: FieldPath | null; observedRowsPerPage: number };
  /**
   * The mapping: `fields` for a parent card (each row key from a path of the item; `posted_at` is converted to an ISO instant, `link` loses its query string, `country` is
   * written in Arabic), or `replies` for a comments or replies card: the code-built mapping of `replies.ts` (`buildReplyMapCode`), which reads every provider's comment shape.
   */
  mapping:
    | { kind: "fields"; fields: Readonly<Record<string, FieldPath>>; /** A key whose link is built from a field of the item (Instagram: the post link from its short code). */ linkTemplate?: { template: string; field: FieldPath }; /** Keys the source writes as numeric strings (YouTube's statistics): written as numbers, null when absent. */ numeric?: ReadonlyArray<string> }
    | { kind: "replies"; /** ROUND 20: the field of the comment item that holds its reaction count as a NUMBER when the shared mapping does not read it (the alternative Facebook comments card writes it `reactions`): a post-pass over the same page fills the likes column from it, by the comment's id. Absent: the mapping code is what it was, byte for byte. */ likesFrom?: string; /** The source dates a comment only by a RELATIVE TEXT in the language asked («3 days ago»): the mapping keeps the text as the source wrote it, and the engine reads it against the moment of the read (an approximate day, marked), or leaves the date empty and counts it when it cannot (round 13). */ relativeDates?: true; /** The comment row's own tokens the replies tool needs (Facebook's `feedback_id` and `expansion_token`; YouTube's reply token): kept on the row under `key`. */ tokens?: ReadonlyArray<{ key: string }> };
  /** The item's own counter of its children: which row key holds it and what it counts (TikTok's video counter counts the comments AND their replies). Null: no counter. */
  counter: { key: string; counts: "comments_and_replies" | "comments" | "replies" } | null;
  /** The catalog's price of one successful page (USD). */
  costUsdPerPage: number;
  /** The stored real pages the card was verified on: mission id and call ids (tests/fixtures/live). */
  verifiedOn: ReadonlyArray<{ mission: string; calls: ReadonlyArray<string> }>;
  /** What the card cannot carry, said once (the compiler turns it into a choice among read rows or a line on the card). */
  cannot?: ReadonlyArray<"country" | "language" | "period" | "topic" | "order">;
}
