import type { CatalogEndpoint, TregCatalog } from "../treg/catalog";
import { rankedHelpers } from "./contactFinders";
import { AGENT_REPLIES_ROWS_PER_CALL_ASSUMED } from "./constants";
import { pageLimitOf } from "./pageLimit";
import type { PricedStage } from "./plan";
import { buildReplyMapCode, replyColumnKeysOf } from "./replies";
import type { StatsMap } from "./sourceRanking";

/**
 * A COMMENTS TOOL THAT HAS A CURSOR, FROM THE CATALOG, BY CODE (S2 item 4; docs/S1-LIVE-FINDINGS.md, L1). The planner sampled one comments tool (`crawl4ai.tiktok.video.comments`: a size input, no next page); the catalog has other tools of the SAME capability with a cursor input.
 * The plan prefers one of them, so a video's comments are read page after page until the promised count or the source's end. Everything used is what the tool's own catalog schema states: its `pagination` (a cursor input), its `inputs` (every required input is the video's id, the
 * video's link or a size), its `list_path` and `item_fields` (the list sits where the page mapping reads it, and its items carry an id and a text). The mapping is the code-written comment-page mapping of replies.ts (both provider shapes), keyed by the comments stage's own columns. Pure.
 */
const VIDEO_ID_INPUT = /^(item_?id|aweme_?id|video_?id|media_?id|post_?id|photo_?id|bv_?id|note_?id|object_?id)$/i;
const URL_INPUT = /^(url|post_?url|video_?url|code_or_url)$/i;
const SIZE_INPUT = /^(limit|count|page_size|pagesize|per_page|perpage|size|num|max_results|maxresults|max_items|maxitems|n)$/i;
const LINK_KEY = /^(link|url|video_url|post_url|video_link|post_link|permalink)$/i;
/** The result lists the page mapping reads (replies.ts `buildReplyMapCode`). */
const READABLE_LISTS: ReadonlySet<string> = new Set(["data.comments", "output.data.comments", "comments"]);

export interface PageableSource {
  id: string;
  usd: number;
  /** The input that takes the video, and which field of the video's row feeds it. */
  parentParam: string;
  from: "id" | "link";
  cursorParam: string;
  pageSizeParam: string | null;
  /** The rows one call gives: the tool's stated default page size, else the assumption every reply source uses. */
  rowsPerCall: number;
}

export interface PageableOptions { isAllowed: (id: string) => boolean; videoIdAvailable: boolean; urlAvailable: boolean; stats?: StatsMap; now?: number }

function classify(e: CatalogEndpoint, o: Pick<PageableOptions, "videoIdAvailable" | "urlAvailable">): Omit<PageableSource, "id" | "usd" | "rowsPerCall"> | null {
  let parent: { param: string; from: "id" | "link" } | null = null;
  let size: string | null = null;
  for (const i of e.inputs) {
    if (VIDEO_ID_INPUT.test(i.name)) { if (o.videoIdAvailable) parent = { param: i.name, from: "id" }; else if (i.required) return null; }
    else if (URL_INPUT.test(i.name)) { if (o.urlAvailable) { if (!parent) parent = { param: i.name, from: "link" }; } else if (i.required) return null; }
    else if (SIZE_INPUT.test(i.name)) size = i.name;
    else if ((e.pagination ?? []).includes(i.name)) continue; // the cursor: optional on a first page
    else if (i.required) return null;
  }
  const cursor = (e.pagination ?? []).find((p) => !SIZE_INPUT.test(p));
  if (!parent || !cursor) return null;
  // a required cursor is a token only an earlier page carries
  if (e.inputs.some((i) => i.required && i.name === cursor)) return null;
  return { parentParam: parent.param, from: parent.from, cursorParam: cursor, pageSizeParam: size };
}

/** The schema says the list is where the mapping reads it and its items carry an id and a text. */
function mappableSchema(e: CatalogEndpoint): boolean {
  if (!e.list_path || !READABLE_LISTS.has(e.list_path)) return false;
  const keys = Object.keys(e.item_fields ?? {});
  return keys.some((k) => /^(cid|id|comment_id|commentId|rpid)$/.test(k)) && keys.some((k) => /^(text|content|comment|message|comment_text)$/.test(k));
}

/** The comments tools of the same capability as `currentId` that have a cursor and that the plan can feed, cheapest first (the catalog's one ranking: price over measured success). The tool itself, routed tools and tools with no cursor are left out. */
export function pageableCommentSourcesFor(currentId: string, catalog: TregCatalog, o: PageableOptions): PageableSource[] {
  const current = catalog.byId.get(currentId);
  // only COMMENTS tools (a child stage of any other capability keeps the recipe it has)
  if (!current?.capability || !/\.comments$/.test(current.capability)) return [];
  const usable = catalog.endpoints.filter((e) => e.id !== currentId && e.platform === current.platform && e.capability === current.capability && e.kind === "direct" && !e.async && o.isAllowed(e.id) && mappableSchema(e) && classify(e, o) !== null);
  const out: PageableSource[] = [];
  for (const r of rankedHelpers(usable, catalog, o.stats ?? new Map(), o.now ?? Date.now())) {
    const e = catalog.byId.get(r.id)!;
    out.push({ id: r.id, usd: r.usd, ...classify(e, o)!, rowsPerCall: pageLimitOf(e)?.default ?? AGENT_REPLIES_ROWS_PER_CALL_ASSUMED });
  }
  return out;
}

export interface PageableAlternative {
  endpoint_id: string; params: Record<string, unknown>; cursor_param: string; map_code: string; map_file_id: string;
  parent_binding: { param: string; from: string }; cost_per_row_usd: number;
}

/**
 * THE STAGE'S NEXT TOOL THAT PAGES, ready to store: the cheapest pageable comments tool the plan can feed, called for each video through its own id or link, mapped by the code-written mapping to the stage's columns, priced by one call over the rows a call gives. Null when the stage's
 * tool already pages, has no binding, or the catalog has none the stage can feed.
 */
export function pageableCommentAlternative(stage: Pick<PricedStage, "engine" | "columns">, parent: Pick<PricedStage, "columns"> | undefined, catalog: TregCatalog, o: Pick<PageableOptions, "isAllowed" | "stats" | "now">): PageableAlternative | null {
  const engine = stage.engine;
  if (!engine || engine.cursor_param !== null || !engine.parent_binding) return null;
  const linkKey = parent?.columns.find((c) => LINK_KEY.test(c.key))?.key ?? null;
  const [first] = pageableCommentSourcesFor(engine.endpoint_id, catalog, { ...o, videoIdAvailable: engine.parent_binding.from === "id", urlAvailable: linkKey !== null });
  if (!first) return null;
  return {
    endpoint_id: first.id, params: {}, cursor_param: first.cursorParam, map_code: buildReplyMapCode(replyColumnKeysOf(stage.columns)), map_file_id: "page",
    parent_binding: { param: first.parentParam, from: first.from === "id" ? "id" : linkKey! }, cost_per_row_usd: first.usd / first.rowsPerCall,
  };
}
