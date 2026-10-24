/** One post of the report, as the collector keeps it (internal ids stay in `pageId`/`key` and never reach a customer file). */
export interface ReportPost {
  /** The identity used for de-duplication: the post's link without its query string, or its id. */
  key: string;
  url: string;
  text: string;
  /** The publisher's display name as the source gave it (content, shown to the customer). */
  publisher: string;
  /** Normalised publisher name: what the per-publisher cap and the concentration table count. */
  publisherKey: string;
  /** Where the post came from: a vetted Page of the registry, or the keyword supplement. */
  source: "page" | "search";
  /** The registry Page it was read from (internal only). */
  pageId?: string;
  publishedAtMs: number | null;
  reactions: number;
  comments: number;
  shares: number;
  contentType: "text" | "video";
  axis?: string;
  axisBy?: "rules" | "model" | "budget" | "ambiguous";
  /** Comments delivered for this post (after hygiene). */
  commentsDelivered?: number;
}

export interface ReportComment {
  postKey: string;
  commentId?: string;
  author: string;
  text: string;
  publishedAtMs: number | null;
  reactions: number;
  replies: number;
  /** Reaction breakdown when the source gave one (like, love, haha, wow, sad, angry). */
  breakdown?: Partial<Record<"like" | "love" | "care" | "haha" | "wow" | "sad" | "angry", number>>;
}

/** What the window filter did, for the report's covered-period lines and the shortfall sentence. */
export interface WindowStats {
  from: string;
  to: string;
  seen: number;
  kept: number;
  outside: number;
  undated: number;
  /** Per registry Page (internal id): how many posts it returned, kept and dropped. */
  perPage: Record<string, { seen: number; kept: number; outside: number; undated: number }>;
  oldestKeptMs: number | null;
  newestKeptMs: number | null;
}
