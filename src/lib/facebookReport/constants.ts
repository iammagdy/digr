import { FACEBOOK_JOB_CEILINGS } from "../facebookCeilings";

/**
 * Facebook topic report: every number the collector, the files and the plan read, in ONE place. Nothing here is a price (the price is the one
 * `RECORD_COSTS` entry of the capability in recordPricing.ts) and nothing here changes a cap or a ceiling that exists elsewhere: the post and comment
 * ceilings are `FACEBOOK_JOB_CEILINGS` (300 posts, 1,500 comments) and the per-job cap is `JOB_MAX_POINTS_CAP` (25,000 points).
 */
export const FACEBOOK_REPORT_SLUG = "facebook-topic-report";

export const isFacebookTopicReport = (identifier: unknown): boolean => String(identifier ?? "") === FACEBOOK_REPORT_SLUG;

/** The ceilings the report shares with the other Facebook services (one constant each, in facebookCeilings.ts). */
export const REPORT_MAX_POSTS = FACEBOOK_JOB_CEILINGS.posts;
export const REPORT_MAX_COMMENTS = FACEBOOK_JOB_CEILINGS.comments;

/** No single publisher may supply more than this share of the delivered posts (owner rule: 20%). Configurable here and nowhere else. */
export const PER_PUBLISHER_MAX_SHARE = 0.2;

/** Pages of posts read from one Page in each round before the next Page has its turn (round-robin: a Page is never read to exhaustion). */
export const POST_PAGES_PER_PAGE_PER_ROUND = 2;
/** Most post pages one Page is read in all (a Page that keeps answering inside the window is stopped by its cap long before this). */
export const MAX_POST_PAGES_PER_PAGE = 40;
/** Most browse calls one job makes in all, validation calls included: bounds what browsing can cost whatever the Pages do. */
export const MAX_BROWSE_CALLS_PER_JOB = 160;

/** Keyword search is only a small supplement: a few calls, a cost ceiling, and a cap on the share of delivered posts it may supply. */
export const SEARCH_SUPPLEMENT_MAX_CALLS = 4;
export const SEARCH_SUPPLEMENT_MAX_SHARE = 0.15;
/** The most the supplement may spend, USD: its calls at the dearest catalog price of a search call (see facebookTopicSources). */
export const SEARCH_SUPPLEMENT_MAX_COST_USD = 0.27;
/** At most this many search calls in ONE chunk, so a chunk's provider cost stays bounded (see REPORT_CHUNK_COST_ESTIMATE_USD). */
export const SEARCH_CALLS_PER_CHUNK = 2;
/**
 * What the worker reserves for one chunk of this job against the daily provider limit and the per-job ceiling: a chunk makes at most 14 calls, of which at most 2 are search calls at
 * the dearest observed price (0.03 USD each) and the rest are Page or comment calls at 0.002 (0.06 + 12 x 0.002 = 0.084), rounded up. ASSUMED upper bound; the real chunk usually costs 0.02 to 0.03.
 */
export const REPORT_CHUNK_COST_ESTIMATE_USD = 0.1;
/** The search is asked for this many posts a call (the source's own limit is 20; the date-restricted calls of the reference returned 2 to 6). */
export const SEARCH_POSTS_PER_CALL = 20;

/** Comment pages read from one post: a high-engagement post up to 3 pages, any other 1 (the source returns up to 10 top-level comments a page). */
export const COMMENT_PAGES_HIGH_ENGAGEMENT = 3;
export const COMMENT_PAGES_LOW_ENGAGEMENT = 1;
/** A post is high-engagement when it is in the top share of the kept posts by engagement (reactions + comments + shares), or has this many comments. */
export const HIGH_ENGAGEMENT_TOP_SHARE = 0.2;
export const HIGH_ENGAGEMENT_MIN_COMMENTS = 30;
/** A post that gave no comment on its first page is not read further. */
export const COMMENTS_PER_PAGE = 10;
/** Posts in a row whose comment calls delivered nothing before comment reading stops (the existing stall guard's idea: a source that returns nothing is not paid again and again). */
export const COMMENT_STALL_POSTS = 36;
/** Pages of one post in a row that repeat comments already taken: the post is left. */
export const COMMENT_REPEAT_PAGES = 2;

/** Judgment: ONE model call per this many posts, only for posts the rules cannot place, inside a budget of this share of the job's revenue. */
export const AXIS_MODEL_BATCH_POSTS = 50;
export const AXIS_MODEL_BUDGET_SHARE = 0.2;
/** A post whose best axis scores below this, or whose best two axes are closer than the margin, is ambiguous (goes to the model if the budget allows, else «general»). */
export const AXIS_MIN_SCORE = 2;
export const AXIS_MIN_MARGIN = 1;
/** The text of a post sent to the model is cut to this many characters (the cost of a call is its input). */
export const AXIS_MODEL_TEXT_CHARS = 220;

/** Longest post text kept in the saved data (the Excel cell limit is 32,767; the post text is shown whole up to this). */
export const POST_TEXT_KEEP_CHARS = 4000;
export const COMMENT_TEXT_KEEP_CHARS = 2000;
