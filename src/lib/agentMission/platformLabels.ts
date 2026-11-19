/**
 * THE CODE'S OWN TABLE OF SOURCE LABELS (moved out of the planner, DT-20261118-09 FIX1, so that the planner AND the customer view apply the same rule): a label of this table is shown to the customer only when the customer wrote it
 * (shownWords.ts). The table is the code's own, it is not a list of providers.
 */
/** The platforms' Arabic names for the code-written sentences (a platform not listed is «المنصة»). */
export const PLATFORM_AR: Record<string, string> = {
  x: "إكس", tiktok: "تيك توك", instagram: "إنستجرام", facebook: "فيسبوك", youtube: "يوتيوب", reddit: "ريديت", linkedin: "لينكدإن", threads: "ثريدز", telegram: "تليجرام", google: "خرائط جوجل", pinterest: "بنترست",
  tripadvisor: "تريب أدفايزر", trustpilot: "ترست بايلوت", yelp: "يلب", "app-store": "متجر آبل", "google-play": "متجر جوجل بلاي", amazon: "أمازون", web: "الويب", bing: "الويب", rumble: "رمبل", spotify: "سبوتيفاي", github: "جيت هب", imdb: "آي إم دي بي",
};

/** The labels that name a source: a text that names one the customer did not write has it replaced by «المصدر». The two generic words («الويب», «مواقع الأخبار») name no source and are left as written. */
export const OWN_SOURCE_LABELS: ReadonlyArray<string> = [...new Set([...Object.values(PLATFORM_AR), "أخبار جوجل", "بحث جوجل", "خرائط جوجل"])].filter((l) => l !== "الويب" && l !== "مواقع الأخبار").sort((a, b) => b.split(" ").length - a.split(" ").length);
