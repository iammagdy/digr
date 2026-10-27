import { z } from "zod";

/** Where a parameter value came from. Every value of a step has one; a value with none is not sent. */
export const ParamSourceSchema = z.enum(["customer_text", "derived", "literal", "prior_step"]);
export type ParamSource = z.infer<typeof ParamSourceSchema>;

export const ParamSchema = z.object({
  name: z.string().min(1).max(80),
  /** The value to send. For `prior_step` it is ignored: the value comes from the listed item (see `fromStep`). */
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()])), z.record(z.string(), z.unknown())]).optional(),
  source: ParamSourceSchema,
  /** `customer_text` (the value IS what the customer wrote) and `derived` (the value is made from what the customer wrote: a translation, a code, a structured form of it): the customer's exact words this value came from (must occur in what the customer wrote). */
  quote: z.string().max(300).optional(),
  /** `prior_step`: the field of the earlier step's listed item that supplies the value (for example «id»). */
  fromStep: z.object({
    /** The earlier step (1-based) whose listed rows supply the value. */
    step: z.number().int().min(1).max(3),
    field: z.string().min(1).max(120),
    /** sample_call only: the endpoint of that earlier step, so the sample reads the right earlier sample (a plan names the step by its number). */
    endpointId: z.string().min(3).max(200).optional(),
  }).optional(),
});
export type PlanParam = z.infer<typeof ParamSchema>;

/** The closed list of transforms a field map may apply to a value. No code, no eval. */
export const TRANSFORMS = ["unix_s_to_iso", "unix_ms_to_iso", "bool", "number", "strip_at", "lower", "first", "join", "domain", "text"] as const;
export const TransformSchema = z.enum(TRANSFORMS);
export type Transform = z.infer<typeof TransformSchema>;

/** The roles a column may play; each maps to the platform's standard column key (and its standard Arabic title). Any other column is shown under its own Arabic header. */
export const ROLES = ["id", "author_handle", "author_name", "text", "date", "url", "likes", "replies", "shares", "views", "followers", "title", "is_reply", "is_repost", "language", "email", "phone", "company", "job_title", "location", "website"] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

export const ColumnSchema = z.object({
  /** The dotted path of the value inside one row of the source's list («user.screen_name», «stats.likes»). */
  field: z.string().min(1).max(160),
  headerAr: z.string().min(1).max(60),
  role: RoleSchema.optional(),
  transform: TransformSchema.optional(),
});
export type PlanColumn = z.infer<typeof ColumnSchema>;

export const FilterSchema = z.discriminatedUnion("kind", [
  /** Keep a row only when this field equals the account the customer named. */
  z.object({ kind: z.literal("author_equals"), field: z.string().min(1).max(160), value: z.string().min(1).max(120), quote: z.string().min(1).max(300) }),
  /** Drop the rows this boolean field marks (replies, reposts). */
  z.object({ kind: z.literal("exclude_true"), field: z.string().min(1).max(160) }),
  /** Drop the rows whose text starts with this mark (a repost that has no flag field starts with a fixed mark). */
  z.object({ kind: z.literal("exclude_prefix"), field: z.string().min(1).max(160), prefix: z.string().min(1).max(24) }),
  /** Keep the rows whose date is inside the window THE CUSTOMER STATED: the quote must be the customer's own words about the period. */
  z.object({ kind: z.literal("date_window"), field: z.string().min(1).max(160), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), quote: z.string().min(1).max(300), format: z.enum(["unix_s", "unix_ms", "iso"]).optional() }),
]);
export type PlanFilter = z.infer<typeof FilterSchema>;

export const PaginationSchema = z.object({
  /** How the next page is asked for: a token the source returned (sent in `param`), a page number, an offset, or «single»: one page only. (Not «none»: a stored «none» reads as a missing value to the quote scope guard.) */
  kind: z.enum(["token", "page", "offset", "single"]),
  param: z.string().max(80).optional(),
  /** Where the token sits in the answer (optional: the shape reader finds it when absent). */
  cursorPath: z.string().max(160).optional(),
  /** The parameter that sets the page size, when the endpoint has one. */
  limitParam: z.string().max(80).optional(),
});
export type PlanPagination = z.infer<typeof PaginationSchema>;

export const FieldMapSchema = z.object({
  /** Where the list of rows sits in the answer; absent = the shape reader finds it. */
  rowsPath: z.string().max(160).optional(),
  columns: z.array(ColumnSchema).min(1).max(24),
  pagination: PaginationSchema.default({ kind: "single" }),
});
export type PlanFieldMap = z.infer<typeof FieldMapSchema>;

export const StepSchema = z.object({
  endpointId: z.string().min(3).max(200),
  /** How many records this step should deliver at most (the volume the customer asked for; for a fan-out step 2, the total of delivered records). */
  volume: z.number().int().min(1).max(25000),
  /** The customer's own words that give the count (for the first step of a branch): the count is never the model's own. */
  volumeQuote: z.string().max(200).optional(),
  /** Whether this step's rows go into the customer's files. Not set: a plan of one or two steps delivers its LAST step (as before); a plan of three or four steps delivers every step. */
  deliver: z.boolean().optional(),
  /** A short Arabic name of the stage for the customer («جمع الشركات»): code makes it safe, or replaces it. */
  titleAr: z.string().max(60).optional(),
  params: z.array(ParamSchema).max(30).default([]),
  fieldMap: FieldMapSchema,
  filters: z.array(FilterSchema).max(6).default([]),
  /** For a step 2 that runs once per listed item: how many records to take from each (omitted = the code splits the volume). */
  perItem: z.number().int().min(1).max(500).optional(),
});
export type PlanStep = z.infer<typeof StepSchema>;

export const ProposePlanSchema = z.object({
  /** One Arabic sentence about what the plan collects (shown on the plan card after code scrubs it). */
  summaryAr: z.string().min(3).max(300),
  steps: z.array(StepSchema).min(1).max(4),
  /** Only when the plan uses a dearer endpoint than a cheaper candidate of the same job that was never sampled: why (the cheaper one's rows were unsuitable). Shown in the trace, never to the customer. */
  whyNotCheapest: z.string().max(300).optional(),
  /** The customer's topic words, when the request has a topic the rows must be about («كرة السلة»): used for the relevance review. */
  topic: z.string().max(200).optional(),
});
export type ProposePlanInput = z.infer<typeof ProposePlanSchema>;

/** What the worker needs to know about an endpoint, copied from the catalog when the plan is approved, so the worker never reads the 10 MB catalog snapshot. */
export interface StepFacts {
  method: "GET" | "POST";
  scope: string;
  /** The endpoint's page-size input (its name and largest value), or null when it has none. */
  limitName: string | null;
  limitMax: number | null;
  /** Where the rows are in the answer (the sample's own reading, else the catalog's), and where the next-page token is, and the declared field types. */
  listPath: string | null;
  cursorPath: string | null;
  itemFields: Record<string, { type: string }> | null;
  /** What one call may cost for the job's budget, USD. */
  callEstimateUsd: number;
  /** What the rows of this step are about, from the catalog's platform: «company» and «person» rows are held to the country the customer named. */
  entity?: "company" | "person" | null;
  /** The answer is ONE record read as the answer itself (a profile, a company detail): the sample read it so, and the worker reads it the same way. */
  rootObjectIsRow?: boolean;
  /** Siblings of the endpoint (same capability, another provider) the worker may call when this endpoint's call fails or answers nothing. Each costs no more per call than the approved ceiling. */
  alternates?: StepAlternate[];
}

/** A sibling endpoint planned in advance: its parameters mapped from the approved step's (names only; the values are the customer's), what one call of it may cost, and how to read its answer. */
export interface StepAlternate {
  endpointId: string;
  method: "GET" | "POST";
  scope: string;
  params: PlanParam[];
  listPath: string | null;
  cursorPath: string | null;
  itemFields: Record<string, { type: string }> | null;
  limitName: string | null;
  limitMax: number | null;
  callEstimateUsd: number;
}

/** The approved plan as stored on the quote item (params._modelStep) and run by the interpreter. */
export interface StoredModelPlan {
  v: 1;
  steps: Array<PlanStep & { facts: StepFacts }>;
  topic?: string;
  /** The country the customer's own words name (canonical English and the Arabic label), when the first step's rows are companies or people: rows of another country are never delivered. */
  country?: { canonicalEnglish: string; arabicLabel: string };
  /** Rows per call and delivered share MEASURED on the sample (or the recipe), per step: what the price was built on. */
  measured: Array<{ rowsPerCall: number; passRate: number; costPerCallUsd: number }>;
  /** What the model may spend on managing this mission (USD): 5% of the reserve value, never below the floor. Set at plan time by code. */
  managerBudgetUsd?: number;
  /** Per step, whether its rows are delivered (set by code from `deliver`). Absent on a plan approved before Phase 2: the last step only. */
  delivers?: boolean[];
  /**
   * The shape of the mission as code priced it. Its presence means the plan runs on the mission engine (any number of stages up to four, rows keep their parent's id, the model
   * manages the decision points); a plan approved before Phase 2 has none and keeps running on the first interpreter, unchanged.
   */
  stages?: StoredStage[];
}

export interface StoredStage {
  /** The earlier stage (0-based) this stage runs once per row of; null for a root. */
  parent: number | null;
  deliver: boolean;
  /** The rows this stage collects at most (a stage run once per parent row never more than its parents can give). */
  effVolume: number;
  /** Rows taken from each parent's call (the first page). 0 for a root. */
  perParent: number;
  /** The stage's name for the customer (Arabic, made safe by code). */
  titleAr: string;
}

export interface ValidationIssue {
  code:
    | "unknown_endpoint" | "not_allowed" | "not_priceable" | "unknown_param" | "bad_param_type" | "bad_param_enum" | "bad_param_range" | "missing_required"
    | "no_provenance" | "quote_not_in_customer_text" | "id_like_literal" | "invented_value" | "window_not_stated" | "bad_field_path" | "bad_rows_path" | "bad_transform"
    | "bad_filter" | "bad_pagination" | "bad_step_reference" | "too_many_stages" | "no_sample_rows" | "needs_real_sample" | "zero_pass_rate" | "volume" | "sensitive_purpose" | "reader_mismatch" | "topic_not_applicable"
    | "volume_not_stated" | "volume_hold_too_high" | "branch_reference" | "fanout_short" | "cheaper_untried";
  /** For the model (English, internal): what is wrong and what to do. */
  message: string;
  stepIndex?: number;
  param?: string;
}
