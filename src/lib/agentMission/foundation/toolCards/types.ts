import type { SocialPlatform } from "../../redesignFlagTypes";

/**
 * F2, A TOOL CARD (docs/FOUNDATION-PLAN.md section 3.1): what one endpoint really does, written as DATA and verified on stored real pages (`verify.ts`). The role is the card's
 * own, independent of the catalog's capability. The compiler reads only cards: which inputs carry which condition of the Ask, where the list and the next page are, which field
 * of an item is its id, its text, its date, its author, its counter. The mapping code of a stage is generated from the card (`mapCode.ts`), never written by a model.
 */
export type CardRole = "videos.search" | "tweets.search" | "video.comments" | "comment.replies";
export type CardStatus = "verified" | "catalog_only" | "broken";

/** A path inside a page or an item: the keys to follow. */
export type FieldPath = ReadonlyArray<string>;

export interface CardInputs {
  /** The input that takes the topic (the customer's own words). `operators`: the query of a search that takes `since:` / `until:` / `lang:` operators. */
  query?: { field: string; operators?: boolean; quoted?: boolean };
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
  mapping: { kind: "fields"; fields: Readonly<Record<string, FieldPath>> } | { kind: "replies" };
  /** The item's own counter of its children: which row key holds it and what it counts (TikTok's video counter counts the comments AND their replies). Null: no counter. */
  counter: { key: string; counts: "comments_and_replies" | "comments" | "replies" } | null;
  /** The catalog's price of one successful page (USD). */
  costUsdPerPage: number;
  /** The stored real pages the card was verified on: mission id and call ids (tests/fixtures/live). */
  verifiedOn: ReadonlyArray<{ mission: string; calls: ReadonlyArray<string> }>;
  /** What the card cannot carry, said once (the compiler turns it into a choice among read rows or a line on the card). */
  cannot?: ReadonlyArray<"country" | "language" | "period" | "topic" | "order">;
}
