import { loadMeasuredAvgCallUsd } from "./measured";
import { unitCost } from "./pricing";
import type { TregCatalog } from "../treg/catalog";
import { RECIPES_TABLE, recipeRowFromPlan, type RecipeRow } from "./recipes";
import type { StoredModelPlan } from "./types";

/**
 * The REVIEWED RECIPES of the services that were proven on the old path (real deliveries): X account posts, X topic posts, TikTok video comments (one video, and the comments of the
 * videos of a topic), Facebook post comments, Facebook keyword posts and their comments, companies, decision-makers. Each is the field map and the parameter template that delivered
 * real rows, with a CONSERVATIVE measure (rows per call and the share that passes the filters: never more than the live deliveries showed), and the average cost per call read from
 * provider_costs / exploration_calls where at least three real calls exist. A recipe is a measurement and a template, never a price (the price is computed from the catalog cost).
 *
 * Loaded by the admin button «تحميل الوصفات المثبتة»: it inserts the ones that are missing (never changes or deletes a saved recipe).
 *
 * The recipes table as applied REFUSES a `reviewed` row without reviewed_by, reviewed_at and at least one fixture ref (CHECK recipes_review_complete): the first version of this button inserted
 * `reviewed` rows with none of the three and all 8 were refused. A seed is now `reviewed` only when it is PROVEN: every endpoint has a real measured average cost (at least 3 real calls in
 * exploration_calls / provider_costs), it has fixture refs (recorded answers under tests/fixtures/replay), and the admin who pressed the button is its reviewer (reviewed_by, reviewed_at).
 * A seed without real measurements is inserted as `draft`, with the catalog cost marked ESTIMATED, instead of failing. A recipe is a measurement and a template, never a price.
 */
type Seed = { title: string; plan: Pick<StoredModelPlan, "steps" | "topic" | "measured"> };

const col = (field: string, headerAr: string, role?: string, transform?: string) => ({ field, headerAr, ...(role ? { role } : {}), ...(transform ? { transform } : {}) });
const xColumns = [col("text", "نص المنشور", "text"), col("authorHandle", "الحساب", "author_handle"), col("createdUtc", "تاريخ النشر", "date"), col("likes", "الإعجابات", "likes", "number"), col("url", "الرابط", "url")];
const xSearchColumns = [col("text", "نص التغريدة", "text"), col("authorUsername", "الحساب", "author_handle"), col("createdUtc", "تاريخ النشر", "date", "unix_s_to_iso"), col("likeCount", "الإعجابات", "likes", "number"), col("url", "الرابط", "url")];
const tiktokCommentColumns = [col("text", "نص التعليق", "text"), col("digg_count", "الإعجابات", "likes", "number"), col("create_time", "تاريخ التعليق", "date", "unix_s_to_iso")];
const facebookCommentColumns = [col("text", "نص التعليق", "text"), col("author.name", "الاسم", "author_name"), col("created_at", "تاريخ التعليق", "date"), col("reaction_count", "التفاعلات", "likes", "number")];

const customer = (name: string) => ({ name, source: "customer_text" as const });
const priorStep = (name: string, field: string) => ({ name, source: "prior_step" as const, fromStep: { step: 1, field } });
const step = (endpointId: string, volume: number, params: any[], columns: any[], pagination: any, filters: any[] = [], extra: Record<string, unknown> = {}) =>
  ({ endpointId, volume, params, fieldMap: { columns, pagination }, filters, facts: {} as any, ...extra });

export const RECIPE_SEEDS: Seed[] = [
  {
    title: "منشورات حساب على إكس",
    plan: {
      steps: [step("anyapi.x.user.posts", 10, [customer("handle")], xColumns, { kind: "token", param: "cursor" }, [{ kind: "author_equals", field: "authorHandle", value: "-", quote: "-" }, { kind: "exclude_true", field: "isReply" }, { kind: "exclude_prefix", field: "text", prefix: "RT @" }])],
      measured: [{ rowsPerCall: 10, passRate: 0.8, costPerCallUsd: 0 }],
    },
  },
  {
    title: "منشورات عن موضوع على إكس",
    plan: { topic: "-", steps: [step("anyapi.x.search.posts", 10, [customer("query")], xSearchColumns, { kind: "token", param: "cursor" })], measured: [{ rowsPerCall: 10, passRate: 0.9, costPerCallUsd: 0 }] },
  },
  {
    title: "تعليقات فيديو تيك توك",
    plan: { steps: [step("tikhub.tiktok.video.comments", 30, [customer("aweme_id")], tiktokCommentColumns, { kind: "token", param: "cursor" })], measured: [{ rowsPerCall: 20, passRate: 1, costPerCallUsd: 0 }] },
  },
  {
    title: "تعليقات فيديوهات عن موضوع على تيك توك",
    plan: {
      topic: "-",
      steps: [
        step("anyapi.tiktok.search.videos", 30, [customer("query")], [col("id", "معرف المقطع", "id"), col("caption", "وصف المقطع", "title")], { kind: "token", param: "cursor" }),
        step("tikhub.tiktok.video.comments", 30, [priorStep("aweme_id", "id")], tiktokCommentColumns, { kind: "single" }, [], { perItem: 10 }),
      ],
      measured: [{ rowsPerCall: 10, passRate: 1, costPerCallUsd: 0 }, { rowsPerCall: 20, passRate: 1, costPerCallUsd: 0 }],
    },
  },
  {
    title: "تعليقات منشور على فيسبوك",
    plan: { steps: [step("scrapecreators.x.v1-facebook-post-comments", 30, [customer("url")], facebookCommentColumns, { kind: "token", param: "cursor" })], measured: [{ rowsPerCall: 10, passRate: 1, costPerCallUsd: 0 }] },
  },
  {
    title: "تعليقات منشورات عن كلمة على فيسبوك",
    plan: {
      topic: "-",
      steps: [
        step("justoneapi.x.facebook-search-post-v1", 30, [customer("keyword")], [col("url", "رابط المنشور", "url"), col("message", "نص المنشور", "text"), col("comments_count", "عدد التعليقات", "replies", "number")], { kind: "token", param: "cursor" }, [], { fieldMapRowsPath: "data.results" }),
        step("scrapecreators.x.v1-facebook-post-comments", 30, [priorStep("url", "url")], facebookCommentColumns, { kind: "token", param: "cursor" }, [], { perItem: 10 }),
      ],
      measured: [{ rowsPerCall: 3, passRate: 1, costPerCallUsd: 0 }, { rowsPerCall: 10, passRate: 1, costPerCallUsd: 0 }],
    },
  },
  {
    title: "شركات",
    plan: { topic: "-", steps: [step("icypeas.companies.search", 10, [{ name: "query", source: "derived" as const }], [col("name", "اسم الشركة", "company"), col("website", "الموقع", "website"), col("industry", "المجال", "title"), col("description", "الوصف", "text")], { kind: "single" })], measured: [{ rowsPerCall: 1, passRate: 1, costPerCallUsd: 0 }] },
  },
  {
    title: "صنّاع القرار",
    plan: { topic: "-", steps: [step("icypeas.people.search", 20, [{ name: "query", source: "derived" as const }], [col("firstname", "الاسم الأول", "author_name"), col("lastname", "اسم العائلة"), col("lastJobTitle", "المسمى الوظيفي", "job_title"), col("lastCompanyName", "الشركة", "company")], { kind: "single" })], measured: [{ rowsPerCall: 1, passRate: 1, costPerCallUsd: 0 }] },
  },
];

const asPlan = (s: Seed): StoredModelPlan => ({ v: 1, steps: s.plan.steps as any, ...(s.plan.topic ? { topic: s.plan.topic } : {}), measured: s.plan.measured });

/** The recorded answers each endpoint of a seed was proven on (files under tests/fixtures/replay; a test checks every one exists). */
export const SEED_FIXTURES: Record<string, Array<{ path: string; kind: "real_rows" | "catalog_example" }>> = {
  "anyapi.x.user.posts": [{ path: "tests/fixtures/replay/real-rows_anyapi.x.user.posts.json", kind: "real_rows" }, { path: "tests/fixtures/replay/catalog-example_anyapi.x.user.posts.json", kind: "catalog_example" }],
  "anyapi.x.search.posts": [{ path: "tests/fixtures/replay/catalog-example_anyapi.x.search.posts.json", kind: "catalog_example" }],
  "tikhub.tiktok.video.comments": [{ path: "tests/fixtures/replay/catalog-example_tikhub.tiktok.video.comments.json", kind: "catalog_example" }],
  "anyapi.tiktok.search.videos": [{ path: "tests/fixtures/replay/catalog-example_anyapi.tiktok.search.videos.json", kind: "catalog_example" }],
  "scrapecreators.x.v1-facebook-post-comments": [{ path: "tests/fixtures/replay/catalog-example_scrapecreators.x.v1-facebook-post-comments.json", kind: "catalog_example" }],
  "justoneapi.x.facebook-search-post-v1": [{ path: "tests/fixtures/replay/catalog-example_justoneapi.x.facebook-search-post-v1.json", kind: "catalog_example" }],
  "icypeas.companies.search": [{ path: "tests/fixtures/replay/catalog-example_icypeas.companies.search.json", kind: "catalog_example" }],
  "icypeas.people.search": [{ path: "tests/fixtures/replay/catalog-example_icypeas.people.search.json", kind: "catalog_example" }],
};

export interface SeedBasis {
  /** The admin who pressed the button: the reviewer of a proven seed. */
  adminId?: string | null;
  now?: Date;
  /** Real measured average cost per call by endpoint (null / missing: no measurement). */
  measuredAvgCallUsd?: Record<string, number | null | undefined>;
  /** The catalog cost per call by endpoint, used (and marked estimated) where there is no measurement. */
  catalogCostUsd?: Record<string, number | null | undefined>;
}

const endpointsOf = (s: Seed): string[] => [...new Set(s.plan.steps.map((st: any) => String(st.endpointId)))];

/** One seed as a table row that satisfies the recipes table as applied. `reviewed` only when every endpoint has a real measurement, fixture refs exist and a reviewer is known; else `draft` with the cost marked estimated. */
export function seedRow(s: Seed, basis: SeedBasis = {}): { title: string; row: RecipeRow; costBasis: "measured" | "estimated"; downgradedReason?: string } {
  const plan = asPlan(s);
  const base = recipeRowFromPlan(plan, { deliveredUnits: 0, jobId: "seed", snapshotSha256: null });
  const ids = endpointsOf(s);
  const measured: Record<string, number> = {};
  const estimated: Record<string, number> = {};
  const costBasis: Record<string, "measured" | "catalog_estimate" | "unknown"> = {};
  for (const id of ids) {
    const m = basis.measuredAvgCallUsd?.[id];
    const c = basis.catalogCostUsd?.[id];
    if (typeof m === "number" && m > 0) { measured[id] = m; costBasis[id] = "measured"; }
    else if (typeof c === "number" && c > 0) { estimated[id] = c; costBasis[id] = "catalog_estimate"; }
    else costBasis[id] = "unknown";
  }
  const fixtureRefs = [...new Map(ids.flatMap((id) => SEED_FIXTURES[id] ?? []).map((f) => [f.path, f])).values()];
  const allMeasured = ids.length > 0 && ids.every((id) => costBasis[id] === "measured");
  const reviewer = String(basis.adminId ?? "").trim();
  const proven = allMeasured && fixtureRefs.length > 0 && reviewer.length > 0;
  const now = (basis.now ?? new Date()).toISOString();
  const perCall = (id: string) => measured[id] ?? estimated[id] ?? 0;
  const measuredPlan = (base.price_basis.measured as Array<Record<string, unknown>>).map((m, i) => ({ ...m, costPerCallUsd: perCall(String(s.plan.steps[i]?.endpointId)) }));
  const row: RecipeRow = {
    ...base,
    status: proven ? "reviewed" : "draft",
    created_by: "seed",
    fixture_refs: fixtureRefs,
    price_basis: {
      ...base.price_basis, measured: measuredPlan, firstJobId: null, firstJobDeliveredUnits: null,
      measuredAvgCallUsd: measured, catalogCostUsd: estimated, costBasis, costEstimated: !allMeasured,
      note: allMeasured ? "seeded from a service proven on the old path: a measurement and a template, never a price; the price is computed from the catalog cost" : "seeded as a DRAFT: no real measured cost for every endpoint yet, so the catalog cost is used and marked estimated; a measurement and a template, never a price",
    },
  };
  if (proven) Object.assign(row, { reviewed_by: reviewer, reviewed_at: now });
  return { title: s.title, row, costBasis: allMeasured ? "measured" : "estimated" };
}

/** The rows the button would insert for a basis (no basis: no measurement, so every seed is a draft). */
export function seedRecipeRows(basis: SeedBasis = {}): Array<{ title: string; row: RecipeRow; costBasis: "measured" | "estimated" }> {
  return RECIPE_SEEDS.map((s) => seedRow(s, basis));
}

export interface SeedItem {
  title: string;
  slug: string;
  state: "inserted" | "present" | "failed";
  /** What was inserted (a proven seed is reviewed, the rest are drafts). */
  status?: "reviewed" | "draft";
  costBasis?: "measured" | "estimated";
  /** Why it failed, in Arabic (the admin sees it next to the name). */
  reasonAr?: string;
  /** The database's own error text and code, for the admin. */
  error?: string;
  /** Arabic: something worth knowing about a seed that was inserted (it went in as a draft because …). */
  noteAr?: string;
}
export interface SeedReport { inserted: number; present: number; failed: number; tableApplied: boolean; items: SeedItem[] }

/** The reason a database error gives for a refused recipe, in Arabic. Unknown errors say so and carry the database's own text. */
export function recipeInsertErrorAr(error: { code?: string; message?: string } | null | undefined): string {
  const message = String(error?.message ?? "");
  const code = String(error?.code ?? "");
  const named = /(?:constraint|index) "([^"]+)"/.exec(message)?.[1] ?? "";
  const known: Record<string, string> = {
    recipes_review_complete: "الوصفة المراجَعة تحتاج اسم المراجع وتاريخ المراجعة ومرجع تجربة واحدًا على الأقل، ولم يكتمل أحدها",
    recipes_slug_check: "اسم الوصفة (slug) لا يطابق الصيغة المسموحة: أحرف صغيرة وأرقام وشرطات، من حرفين إلى ٦٣",
    recipes_version_check: "رقم النسخة يجب أن يكون ١ فأكثر",
    recipes_status_check: "حالة الوصفة يجب أن تكون draft أو reviewed أو retired",
    recipes_params_template_check: "قالب المعاملات يجب أن يكون كائن JSON",
    recipes_field_map_check: "خريطة الحقول يجب أن تكون كائن JSON",
    recipes_price_basis_check: "أساس السعر يجب أن يكون كائن JSON",
    recipes_fixture_refs_check: "مراجع التجارب يجب أن تكون مصفوفة JSON",
    recipes_catalog_snapshot_sha256_check: "بصمة الكتالوج يجب أن تكون فارغة أو ٦٤ حرفًا سداسيًا",
    recipes_endpoint_id_check: "معرّف الخدمة يجب أن يكون بين ٣ و٢٠٠ حرف",
    recipes_slug_version_key: "توجد وصفة بالاسم والنسخة نفسيهما",
    recipes_one_reviewed_per_slug: "يوجد بالفعل إصدار مراجَع نافذ لهذه الوصفة؛ أنشئ إصدارًا جديدًا بعد إيقاف القديم",
    recipes_pkey: "معرّف الصف مكرر",
  };
  if (known[named]) return known[named];
  if (/recipes_guard|immutable|never deleted|stays retired/i.test(message)) return "حارس الجدول منع التعديل: الوصفة المراجَعة لا تتغير، أنشئ إصدارًا جديدًا";
  if (code === "42501" || /permission denied/i.test(message)) return "قاعدة البيانات رفضت الصلاحية على جدول الوصفات";
  if (code === "42P01" || /does not exist/i.test(message)) return "جدول الوصفات غير موجود في قاعدة البيانات";
  if (code === "23502") return "حقل إلزامي فارغ في الوصفة";
  return `رفضت قاعدة البيانات الوصفة لسبب غير معروف${message ? ` (${message.slice(0, 120)})` : ""}`;
}

const rawOf = (error: { code?: string; message?: string } | null | undefined): string => `${error?.code ? `${error.code}: ` : ""}${String(error?.message ?? "").slice(0, 300)}`;

/**
 * Inserts the recipes that are missing. Never updates or deletes. A table that is not applied yet answers `tableApplied: false`. Never throws. A proven seed goes in `reviewed` (the admin is the
 * reviewer); one without real measurements goes in as a `draft` with the catalog cost marked estimated. If the table still refuses the reviewed row, the seed is inserted as a draft instead
 * and says so; a seed that cannot go in at all is reported with its name and the database's own reason.
 */
export async function seedRecipes(client: any, opts: { adminId?: string | null; catalog?: TregCatalog | null; now?: Date } = {}): Promise<SeedReport> {
  const report: SeedReport = { inserted: 0, present: 0, failed: 0, tableApplied: true, items: [] };
  const fail = (title: string, slug: string, error: { code?: string; message?: string } | null | undefined) => { report.failed += 1; report.items.push({ title, slug, state: "failed", reasonAr: recipeInsertErrorAr(error), error: rawOf(error) }); };
  for (const seed of RECIPE_SEEDS) {
    const title = seed.title;
    let slug = "";
    try {
      slug = seedRow(seed).row.slug;
      const existing = await client.from(RECIPES_TABLE).select("slug").eq("slug", slug).eq("version", 1).maybeSingle();
      if (existing?.error) { report.tableApplied = false; report.failed += 1; report.items.push({ title, slug, state: "failed", reasonAr: recipeInsertErrorAr(existing.error), error: rawOf(existing.error) }); continue; }
      if (existing?.data) { report.present += 1; report.items.push({ title, slug, state: "present" }); continue; }
      const measuredAvgCallUsd: Record<string, number | null> = {};
      const catalogCostUsd: Record<string, number | null> = {};
      for (const id of endpointsOf(seed)) {
        measuredAvgCallUsd[id] = await loadMeasuredAvgCallUsd(client, id).catch(() => null);
        const e = opts.catalog?.byId.get(id);
        catalogCostUsd[id] = e && opts.catalog ? unitCost(e, opts.catalog)?.usd ?? null : null;
      }
      const built = seedRow(seed, { adminId: opts.adminId, now: opts.now, measuredAvgCallUsd, catalogCostUsd });
      let { error } = await client.from(RECIPES_TABLE).insert(built.row);
      let row = built.row;
      let noteAr: string | undefined;
      if (error && built.row.status === "reviewed") {
        // the table refused the review: keep the seed as a draft rather than lose it
        row = { ...built.row, status: "draft", reviewed_by: null, reviewed_at: null } as typeof built.row;
        const retry = await client.from(RECIPES_TABLE).insert(row);
        if (!retry.error) { noteAr = `رفض الجدول المراجعة (${recipeInsertErrorAr(error)}) فأُضيفت مسودة`; error = null; } else error = retry.error;
      }
      if (error) { fail(title, slug, error); continue; }
      report.inserted += 1;
      report.items.push({ title, slug, state: "inserted", status: row.status as "reviewed" | "draft", costBasis: built.costBasis, ...(row.status === "draft" && !noteAr ? { noteAr: "أُضيفت مسودة: لا قياس حقيقي لتكلفة كل خدمة فيها بعد، فاستُخدمت تكلفة الكتالوج ووُسمت تقديرية" } : {}), ...(noteAr ? { noteAr } : {}) });
    } catch (err) {
      fail(title, slug, { message: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}
