import { checkCustomerText } from "../../src/lib/agentMission/text";
import type { TregCatalog } from "../../src/lib/treg/catalog";

/**
 * THE GOLDEN AND BENCHMARK HARNESS (S1 item 0.2). It does not call any provider. It holds
 *  - the six golden prompts of docs/AUDIT-2026-11.md section 7 and the ten benchmark requests of docs/benchmarks/antigravity-10.md as DATA, each with the shape its delivery must have;
 *  - `checkShape`: compares one delivery (the counts, the sheets and the customer texts of a finished mission) with that shape and returns what is wrong (an empty list: it passes);
 *  - `sourceStatus`: whether the sellable catalog has any source for the request at all (`no_tool` when none: the plan card must then say so honestly, which is a pass for the shape check, never a silent failure);
 *  - `renderReport`: one line per request for the owner to read.
 * The live checklist is the benchmark document; the read-only SELECTs for the numbers are in scripts/golden-live-checks.sql (a proposal, never run by the code).
 */
export interface SheetData { headers: string[]; rows: Array<Record<string, string>> }
export interface Delivery {
  approvedCount: number;
  deliveredCount: number;
  /** The code-computed truthful reason in the file when fewer than approved were delivered (null: none given). */
  shortfallReasonAr: string | null;
  chargedPoints: number;
  sheets: Record<string, SheetData>;
  /** Every sentence of customer text of the mission (plan card, notebook line, notices, file text). */
  customerTexts: string[];
}
export interface HeaderNeed { label: string; re: RegExp }
export interface ShapeExpectation {
  /** The headers each named sheet must hold (matched by meaning, not by the exact title the plan chose). */
  sheets?: Record<string, HeaderNeed[]>;
  /** A comments sheet: every row must carry the parent's link (zero orphans). */
  commentsSheet?: { name: string; parentLinkHeader: string };
}

const N = (label: string, re: RegExp): HeaderNeed => ({ label, re });
const POST_COLUMNS: HeaderNeed[] = [N("الحساب", /الحساب|الكاتب|الصفحة|القناة/), N("النص", /نص|وصف|عنوان/), N("التاريخ", /تاريخ/), N("الرابط", /رابط/)];
const X_COLUMNS: HeaderNeed[] = [N("الحساب", /الحساب/), N("النص", /نص/), N("التاريخ", /تاريخ/), N("الرابط", /رابط/), N("الإعجابات", /إعجاب/), N("إعادة النشر", /إعادة|ريتويت/), N("الردود", /ردود/), N("الاقتباسات", /اقتباس/), N("المشاهدات", /مشاهد/)];

export interface GoldenPrompt { id: string; requestAr: string; expect: ShapeExpectation; note: string }
export const GOLDEN_PROMPTS: GoldenPrompt[] = [
  { id: "G1", requestAr: "عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم صناع القرار: اسم المدير، المسمى الوظيفي، الإيميل، ورقم التليفون", note: "5 companies, 2 people each", expect: { sheets: { companies: [N("اسم الشركة", /اسم الشركة/), N("الموقع", /الموقع/)] } } },
  { id: "G2", requestAr: "عايز ٥ شركات مصرية في قطاع البترول، ومعاهم صناع القرار: اسم المدير، المسمى الوظيفي، الإيميل، ورقم التليفون", note: "same shape as G1", expect: { sheets: { companies: [N("اسم الشركة", /اسم الشركة/), N("الموقع", /الموقع/)] } } },
  { id: "G3", requestAr: "هات ٥٠ تغريدة عن الذكاء الاصطناعي في مصر آخر أسبوع باللغة العربية", note: "50 posts, last 7 days, Arabic", expect: { sheets: { posts: X_COLUMNS } } },
  { id: "G4", requestAr: "هات ٥ فيديوهات تيك توك عن منتخب مصر، ومن كل فيديو ١٠ تعليقات", note: "videos + 10 comments each, parent link on every comment", expect: { sheets: { videos: POST_COLUMNS }, commentsSheet: { name: "comments", parentLinkHeader: "رابط الفيديو" } } },
  { id: "G5", requestAr: "هات آخر ٢٠ بوست من حساب @vodafoneegypt على إنستجرام", note: "20 posts of one account (12 without a session, said honestly)", expect: { sheets: { posts: POST_COLUMNS } } },
  { id: "G6", requestAr: "هات ١٥ صيدلية في مدينة نصر على جوجل ماب: الاسم والعنوان والتليفون والتقييم وعدد التقييمات والرابط", note: "15 places", expect: { sheets: { places: [N("الاسم", /اسم/), N("العنوان", /عنوان/), N("الهاتف", /هاتف|تليفون/), N("التقييم", /تقييم/), N("الرابط", /رابط/)] } } },
];

/** What a catalog must hold for the request to have any source at all: a platform, a capability, or both (any endpoint that matches counts). */
export interface SourceNeed { platform?: string; capability?: RegExp }
export interface Benchmark { id: number; requestAr: string; minSize: string; needs: SourceNeed[]; expect: ShapeExpectation }
export const BENCHMARKS: Benchmark[] = [
  { id: 1, requestAr: "هات منشورات صفحة العربية على فيسبوك عن [الموضوع] آخر ٣ شهور، ومع كل منشور كل التعليقات وكل الردود", minSize: "2 posts", needs: [{ platform: "facebook" }], expect: { sheets: { posts: POST_COLUMNS }, commentsSheet: { name: "comments", parentLinkHeader: "رابط المنشور" } } },
  { id: 2, requestAr: "هات فيديوهات نهائي كأس السوبر المصري بين الأهلي والزمالك من القنوات الرسمية للقنوات الناقلة، ومع كل فيديو كل التعليقات وكل الردود", minSize: "2 videos", needs: [{ platform: "youtube" }], expect: { sheets: { videos: POST_COLUMNS }, commentsSheet: { name: "comments", parentLinkHeader: "رابط الفيديو" } } },
  { id: 3, requestAr: "هات فيديوهات تيك توك بالعربي عن الذكاء الاصطناعي، من مصر أو المنطقة العربية، ومع كل فيديو كل التعليقات وكل الردود", minSize: "2 videos", needs: [{ platform: "tiktok" }], expect: { sheets: { videos: POST_COLUMNS }, commentsSheet: { name: "comments", parentLinkHeader: "رابط الفيديو" } } },
  { id: 4, requestAr: "هات منشورات حساب @alhadath على إنستجرام، ومع كل منشور كل التعليقات وكل الردود", minSize: "2 posts", needs: [{ platform: "instagram" }], expect: { sheets: { posts: POST_COLUMNS }, commentsSheet: { name: "comments", parentLinkHeader: "رابط المنشور" } } },
  { id: 5, requestAr: "هات ٢٠ تغريدة فيها «العاصمة الإدارية» بالعربي في أكتوبر ٢٠٢٦، مع الردود", minSize: "20 posts", needs: [{ platform: "x" }], expect: { sheets: { posts: X_COLUMNS } } },
  { id: 6, requestAr: "هات ٢ من الأشخاص في مصر اللي بينشروا عن الطاقة المتجددة، مع بيانات ملفهم الشخصي وآخر منشوراتهم", minSize: "2 people", needs: [{ capability: /^linkedin\.search\.(posts|people)$/ }], expect: { sheets: { people: [N("الاسم", /اسم/), N("الرابط", /رابط/)] } } },
  { id: 7, requestAr: "هات ١٠ مستشفيات في الإسكندرية، مصر: الاسم والعنوان والتليفون والموقع الإلكتروني والتقييم", minSize: "10 places", needs: [{ capability: /^google\.serp\.maps$/ }], expect: { sheets: { places: [N("الاسم", /اسم/), N("العنوان", /عنوان/), N("الهاتف", /هاتف|تليفون/), N("الموقع", /موقع/), N("التقييم", /تقييم/)] } } },
  { id: 8, requestAr: "عايز ٢ شركات مبيعات عقارية و٢ شركات مقاولات في مصر. لكل شركة: الاسم والنشاط والموقع الإلكتروني والإيميل العام ورقم المقر الرئيسي، ومعاها ٢ من صناع القرار: الاسم والمسمى الوظيفي والإيميل والموبايل وحالة التوثيق", minSize: "4 companies, 8 people", needs: [{ platform: "companies" }, { platform: "people" }], expect: { sheets: { companies: [N("اسم الشركة", /اسم الشركة/), N("النشاط", /نشاط/), N("الموقع", /الموقع/)] } } },
  { id: 9, requestAr: "شركة مصرية بتعمل تدوير للكابلات عايزة ٢ شركات في مصر غالبًا عندها كابلات خردة للبيع (المقر الرئيسي والإيميل العام وصانع قرار بإيميله وموبايله)، و٢ منافسين لها في مصر", minSize: "4 companies", needs: [{ platform: "companies" }], expect: { sheets: { companies: [N("اسم الشركة", /اسم الشركة/)] } } },
  { id: 10, requestAr: "عايز أبحاث منشورة وأخبار عن استخدام الذكاء الاصطناعي في الكشف المبكر عن اعتلال الشبكية السكري، مع الروابط وملخص قصير للمنهجية", minSize: "5 papers and 3 news", needs: [{ platform: "research" }, { capability: /^google\.serp\.news$/ }], expect: {} },
];

const endpointMatches = (need: SourceNeed, catalog: TregCatalog): boolean => catalog.endpoints.some((e) => (need.platform === undefined || e.platform === need.platform) && (need.capability === undefined || need.capability.test(e.capability ?? "")));
/** `ok` when the catalog has a source for every need of the request, else `no_tool` (the plan card must say so before approval). */
export function sourceStatus(b: Benchmark, catalog: TregCatalog): "ok" | "no_tool" {
  return b.needs.every((n) => endpointMatches(n, catalog)) ? "ok" : "no_tool";
}

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
/** What is wrong with a delivery (an empty list passes). */
export function checkShape(d: Delivery, expect: ShapeExpectation): string[] {
  const out: string[] = [];
  // 1. delivered = approved, or the truthful reason is in the file
  if (d.deliveredCount !== d.approvedCount && !(d.deliveredCount < d.approvedCount && d.shortfallReasonAr)) out.push(`delivered ${d.deliveredCount} of ${d.approvedCount} with no truthful reason`);
  // the sheets and their required columns
  for (const [name, needs] of Object.entries(expect.sheets ?? {})) {
    const sheet = d.sheets[name];
    if (!sheet) { out.push(`sheet «${name}» is missing`); continue; }
    for (const need of needs) if (!sheet.headers.some((h) => need.re.test(h))) out.push(`sheet «${name}» has no column for «${need.label}»`);
  }
  // 2. every comment has its parent's link (zero orphans)
  if (expect.commentsSheet) {
    const sheet = d.sheets[expect.commentsSheet.name];
    if (!sheet) out.push(`comments sheet «${expect.commentsSheet.name}» is missing`);
    else { const orphans = sheet.rows.filter((r) => !String(r[expect.commentsSheet!.parentLinkHeader] ?? "").trim()).length; if (orphans > 0) out.push(`${orphans} orphan comment(s) without a parent link`); }
  }
  // 4 and 5. customer text: no provider names, ids, dollars, Latin words, emoji (the same check every new string goes through)
  for (const t of d.customerTexts) {
    const c = checkCustomerText(t);
    if (c.issues.length > 0) out.push(`customer text refused: ${c.issues.join("; ")}`);
    if (EMOJI.test(t)) out.push("customer text has an emoji");
  }
  return out;
}

/** One line per golden prompt and per benchmark request: its status against the catalog and the size it must reach. */
export function renderReport(catalog: TregCatalog): string {
  const lines = ["Golden prompts:", ...GOLDEN_PROMPTS.map((g) => `  ${g.id} ${g.note}`), "Benchmark requests (source status against the catalog):", ...BENCHMARKS.map((b) => `  #${b.id} ${sourceStatus(b, catalog)} (minimum: ${b.minSize})`)];
  return lines.join("\n");
}
