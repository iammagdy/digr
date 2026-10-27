import { loadMeasuredAvgCallUsd } from "./measured";
import { RECIPES_TABLE, recipeRowFromPlan, type RecipeRow } from "./recipes";
import type { StoredModelPlan } from "./types";

/**
 * The REVIEWED RECIPES of the services that were proven on the old path (real deliveries): X account posts, X topic posts, TikTok video comments (one video, and the comments of the
 * videos of a topic), Facebook post comments, Facebook keyword posts and their comments, companies, decision-makers. Each is the field map and the parameter template that delivered
 * real rows, with a CONSERVATIVE measure (rows per call and the share that passes the filters: never more than the live deliveries showed), and the average cost per call read from
 * provider_costs / exploration_calls where at least three real calls exist. A recipe is a measurement and a template, never a price (the price is computed from the catalog cost).
 *
 * Loaded by the admin button «تحميل الوصفات المثبتة»: it inserts the ones that are missing (never changes or deletes a saved recipe), as `reviewed`.
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

export function seedRecipeRows(): Array<{ title: string; row: RecipeRow }> {
  return RECIPE_SEEDS.map((s) => {
    const row = recipeRowFromPlan(asPlan(s), { deliveredUnits: 0, jobId: "seed", snapshotSha256: null });
    return { title: s.title, row: { ...row, status: "reviewed", created_by: "seed", price_basis: { ...row.price_basis, firstJobId: null, firstJobDeliveredUnits: null, note: "seeded from a service proven on the old path: a measurement and a template, never a price; the price is computed from the catalog cost" } } };
  });
}

export interface SeedReport { inserted: number; present: number; failed: number; tableApplied: boolean; items: Array<{ title: string; slug: string; state: "inserted" | "present" | "failed" }> }

/** Inserts the reviewed recipes that are missing. Never updates or deletes. A table that is not applied yet answers `tableApplied: false`. Never throws. */
export async function seedRecipes(client: any): Promise<SeedReport> {
  const report: SeedReport = { inserted: 0, present: 0, failed: 0, tableApplied: true, items: [] };
  for (const { title, row } of seedRecipeRows()) {
    try {
      const existing = await client.from(RECIPES_TABLE).select("slug").eq("slug", row.slug).eq("version", 1).maybeSingle();
      if (existing?.error) { report.tableApplied = false; report.failed += 1; report.items.push({ title, slug: row.slug, state: "failed" }); continue; }
      if (existing?.data) { report.present += 1; report.items.push({ title, slug: row.slug, state: "present" }); continue; }
      const avg: Record<string, number> = {};
      const endpointIds: string[] = Array.isArray((row.field_map as any)?.steps) ? (row.field_map as any).steps.map((s: any) => String(s.endpointId)) : [];
      for (const id of new Set(endpointIds)) {
        const m = await loadMeasuredAvgCallUsd(client, id).catch(() => null);
        if (m) avg[id] = m;
      }
      const { error } = await client.from(RECIPES_TABLE).insert({ ...row, price_basis: { ...row.price_basis, measuredAvgCallUsd: avg } });
      if (error) { report.failed += 1; report.items.push({ title, slug: row.slug, state: "failed" }); } else { report.inserted += 1; report.items.push({ title, slug: row.slug, state: "inserted" }); }
    } catch {
      report.failed += 1;
      report.items.push({ title, slug: row.slug, state: "failed" });
    }
  }
  return report;
}
