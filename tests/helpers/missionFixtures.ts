import { loadTregCatalog } from "../../src/lib/treg/catalog";
import { digestFromCatalogExample } from "../../src/lib/modelPlanner/digest";
import { ProposePlanSchema } from "../../src/lib/modelPlanner/types";
import { validatePlan, type StepSample, type ValidateContext } from "../../src/lib/modelPlanner/validate";
import type { StoredModelPlan } from "../../src/lib/modelPlanner/types";

/**
 * The four missions of the owner as VALIDATED plans, built from the catalog's own example shapes (FIXTURES: the shapes are the catalog's, the rows are not a live answer). The panel, the
 * status and the workbook tests read the stages and the field maps of these plans, so what they check is what the planner really stores.
 */
const catalog = loadTregCatalog();
const business = { isAdmin: false, verifiedBusiness: true };
const TODAY = new Date("2026-10-27T12:00:00Z");
const col = (field: string, headerAr: string, role?: string, transform?: string) => ({ field, headerAr, ...(role ? { role } : {}), ...(transform ? { transform } : {}) });

export const exampleSample = (endpointId: string): StepSample => {
  const e = catalog.byId.get(endpointId)!;
  const d = digestFromCatalogExample(e as any)!;
  return { endpointId, rows: d.reading.rows as any, digest: d.digest, costUsd: 0 };
};
const ctx = (customerText: string, samples: string[] = []): ValidateContext => ({ customerText, access: business, catalog, samples: new Map(samples.map((id) => [id, exampleSample(id)])), today: TODAY });

export const M4_TEXT = "أبغى ٥٠ شركة كهروميكانيكية في مصر وفيها الموظفين وإيميل وموبايل كل موظف";
const m4 = () => ProposePlanSchema.parse({
  summaryAr: "جمع الشركات ثم موظفيها ثم بريد وجوال كل موظف",
  steps: [
    { endpointId: "icypeas.companies.search", titleAr: "جمع الشركات", volume: 50, params: [{ name: "query", value: { industry: { include: ["Electrical"] }, location: { include: ["Egypt"] } }, source: "derived", quote: "شركة كهروميكانيكية في مصر" }], fieldMap: { columns: [col("name", "اسم الشركة", "company"), col("website", "الموقع", "website"), col("url", "رابط الشركة", "url"), col("lid", "المعرف", "id")], pagination: { kind: "single" } } },
    { endpointId: "blitzapi.people.employee-finder", titleAr: "جمع الموظفين داخل كل شركة", volume: 150, perItem: 3, params: [{ name: "company_linkedin_url", source: "prior_step", fromStep: { step: 1, field: "url" } }], fieldMap: { columns: [col("full_name", "الاسم", "author_name"), col("headline", "المسمى", "job_title"), col("linkedin_url", "رابط الملف", "id"), col("first_name", "الاسم الأول"), col("last_name", "اسم العائلة")], pagination: { kind: "single" } } },
    { endpointId: "icypeas.people.email.find", titleAr: "البريد المهني", volume: 150, perItem: 1, params: [{ name: "firstname", source: "prior_step", fromStep: { step: 2, field: "first_name" } }, { name: "lastname", source: "prior_step", fromStep: { step: 2, field: "last_name" } }, { name: "domainOrCompany", source: "prior_step", fromStep: { step: 1, field: "website" } }], fieldMap: { columns: [col("item.status", "حالة البريد")], pagination: { kind: "single" } } },
    { endpointId: "tomba.people.phone.find", titleAr: "الموبايل", volume: 150, perItem: 1, params: [{ name: "linkedin", source: "prior_step", fromStep: { step: 2, field: "linkedin_url" } }], fieldMap: { columns: [col("e164_format", "الجوال", "phone")], pagination: { kind: "single" } } },
  ],
});

export const M1_TEXT = "هات ١٠ أخبار عن منتخب مصر في كأس العالم ٢٠٢٦ و١٠ فيديوهات من قناة @FIFA الرسمية عن مصر ومعاها تعليقات كل فيديو";
const m1 = () => ProposePlanSchema.parse({
  summaryAr: "أخبار المنتخب وفيديوهات القناة الرسمية وتعليقاتها",
  steps: [
    { endpointId: "anyapi.google.serp.news", titleAr: "جمع الأخبار", volume: 10, params: [{ name: "query", value: "منتخب مصر في كأس العالم ٢٠٢٦", source: "customer_text", quote: "منتخب مصر في كأس العالم ٢٠٢٦" }], fieldMap: { columns: [col("title", "العنوان", "title"), col("url", "الرابط", "url")], pagination: { kind: "single" } } },
    { endpointId: "crawl4ai.youtube.channel.videos", titleAr: "فيديوهات القناة الرسمية", volume: 10, params: [{ name: "channel", value: "@FIFA", source: "customer_text", quote: "@FIFA" }], fieldMap: { columns: [col("video_id", "المعرف", "id"), col("title", "العنوان", "title"), col("url", "الرابط", "url")], pagination: { kind: "single" } } },
    { endpointId: "tikhub.youtube.video.comments", titleAr: "تعليقات كل فيديو", volume: 100, perItem: 10, params: [{ name: "video_id", source: "prior_step", fromStep: { step: 2, field: "video_id" } }], fieldMap: { columns: [col("content", "التعليق", "text"), col("like_count", "الإعجابات", "likes", "number")], pagination: { kind: "single" } } },
  ],
});

export const M2_TEXT = "هات ٣٠ فيديو تيك توك عن الزواج والطلاق في مصر آخر ٣ شهور ومعاها لينكاتها وتعليقاتها";
const m2 = () => ProposePlanSchema.parse({
  summaryAr: "فيديوهات عن الزواج والطلاق وتعليقاتها", topic: "الزواج والطلاق في مصر",
  steps: [
    { endpointId: "anyapi.tiktok.search.videos", titleAr: "جمع الفيديوهات", volume: 30, deliver: true, params: [{ name: "query", value: "الزواج والطلاق في مصر", source: "customer_text", quote: "الزواج والطلاق في مصر" }], fieldMap: { columns: [col("id", "المعرف", "id"), col("caption", "الوصف", "title")], pagination: { kind: "token", param: "cursor" } } },
    { endpointId: "tikhub.tiktok.video.comments", titleAr: "تعليقات كل فيديو", volume: 300, perItem: 10, deliver: true, params: [{ name: "aweme_id", source: "prior_step", fromStep: { step: 1, field: "id" } }], fieldMap: { columns: [col("text", "نص التعليق", "text")], pagination: { kind: "single" } } },
  ],
});

export const M3_TEXT = "هات ٥٠ بوست على X عن محمد صلاح بعد انتقاله إلى تركيا من ١ يوليو ٢٠٢٦ إلى ٢٧ أكتوبر ٢٠٢٦";
const m3 = () => ProposePlanSchema.parse({
  summaryAr: "منشورات عن محمد صلاح", topic: "محمد صلاح",
  steps: [{ endpointId: "anyapi.x.search.posts", volume: 50, params: [{ name: "query", value: "محمد صلاح", source: "customer_text", quote: "محمد صلاح" }], fieldMap: { columns: [col("text", "نص التغريدة", "text"), col("createdUtc", "تاريخ النشر", "date", "unix_s_to_iso")], pagination: { kind: "token", param: "cursor" } }, filters: [{ kind: "date_window", field: "createdUtc", from: "2026-07-01", to: "2026-10-27", quote: "من ١ يوليو ٢٠٢٦ إلى ٢٧ أكتوبر ٢٠٢٦", format: "unix_s" }] }],
});

const SAMPLES: Record<string, string[]> = {
  M1: ["anyapi.google.serp.news", "crawl4ai.youtube.channel.videos", "tikhub.youtube.video.comments"],
  M2: ["anyapi.tiktok.search.videos", "tikhub.tiktok.video.comments"],
  M3: ["anyapi.x.search.posts"],
  M4: [],
};

/** The stored plan of a mission fixture ("M1" to "M4"), exactly as the validator stores it. Throws when the fixture does not validate (a test of its own). */
export function storedMissionPlan(name: "M1" | "M2" | "M3" | "M4"): StoredModelPlan {
  const plan = { M1: m1, M2: m2, M3: m3, M4: m4 }[name]();
  const text = { M1: M1_TEXT, M2: M2_TEXT, M3: M3_TEXT, M4: M4_TEXT }[name];
  let samples = ctx(text, SAMPLES[name]);
  if (name === "M3") {
    const s = exampleSample("anyapi.x.search.posts");
    samples = { ...samples, samples: new Map([["anyapi.x.search.posts", { ...s, rows: s.rows.map((r: any) => ({ ...r, createdUtc: String(Math.floor(Date.parse("2026-08-15T00:00:00Z") / 1000)) })) }]]) };
  }
  const result = validatePlan(plan, samples);
  if (!result.ok) throw new Error(`fixture ${name} does not validate: ${result.issues.map((i) => `${i.code}: ${i.message}`).join(" | ")}`);
  return result.plan.stored;
}
