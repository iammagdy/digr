import { Client, TablesDB, Query } from "node-appwrite";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1";
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482";
const apiKey = process.env.APPWRITE_API_KEY!;

const client = new Client()
  .setEndpoint(endpoint)
  .setProject(projectId)
  .setKey(apiKey);

const tables = new TablesDB(client);

// 12 Capabilities with precise documentation sources, verification status, and schemas
export const CAPABILITIES_CATALOG = [
  {
    slug: "tiktok-profile",
    category: "tiktok",
    nameAr: "استخراج ملف تيك توك الشخصي",
    nameEn: "TikTok User Profile",
    descriptionAr: "استخراج الإحصائيات الشاملة والنبذة التعريفية وحالة التوثيق لحساب تيك توك عام",
    tregEndpointId: "tikhub.tiktok.user.profile",
    endpointSource: "https://treg.to/integrate.md & TikHub Provider API",
    verified: true, // VERIFIED live with real call: exactly 1,000 µUSD (0.001 USD) in job_calls
    priceStatus: "verified",
    costBasis: "1000 µUSD verified in job_calls (runs 6ac9f2fc002af491a0a0 & 6ac9f51d0027f0a7951a)",
    enabled: true,
    params: ["username"],
    paramsSchema: JSON.stringify({
      type: "object",
      properties: { username: { type: "string", description: "اسم المستخدم بدون @" } },
      required: ["username"]
    }),
    pricingUnit: "call",
    unitCostUsd: 0.001, // Verified real cost: 1000 micro-USD (0.001 USD)
    maxRows: 1,
    paginationType: "none",
  },
  {
    slug: "tiktok-user-videos",
    category: "tiktok",
    nameAr: "مقاطع فيديو مستخدم تيك توك",
    nameEn: "TikTok User Recent Videos",
    descriptionAr: "استخراج أحدث مقاطع الفيديو المنشورة في حساب تيك توك عام مع إحصائيات المشاهدة والتفاعل",
    tregEndpointId: "tikhub.tiktok.user.posts",
    endpointSource: "https://treg.to (TikHub TikTok posts catalog)",
    verified: false,
    enabled: false,
    params: ["username", "count"],
    paramsSchema: JSON.stringify({
      type: "object",
      properties: { username: { type: "string" }, count: { type: "integer", maximum: 200 } },
      required: ["username"]
    }),
    pricingUnit: "item",
    unitCostUsd: 0.0003,
    maxRows: 200,
    paginationType: "cursor",
  },
  {
    slug: "tiktok-keyword-videos",
    category: "tiktok",
    nameAr: "البحث في مقاطع تيك توك بكلمة مفتاحية",
    nameEn: "TikTok Keyword Video Search",
    descriptionAr: "البحث عن مقاطع تيك توك العامة المرتبطة بكلمة مفتاحية أو وسم",
    tregEndpointId: "tikhub.tiktok.search.video",
    endpointSource: "https://treg.to (TikHub TikTok search catalog)",
    verified: false,
    enabled: false,
    params: ["keyword", "count"],
    paramsSchema: JSON.stringify({
      type: "object",
      properties: { keyword: { type: "string" }, count: { type: "integer", maximum: 300 } },
      required: ["keyword"]
    }),
    pricingUnit: "item",
    unitCostUsd: 0.00035,
    maxRows: 300,
    paginationType: "cursor",
  },
  {
    slug: "x-user-tweets",
    category: "x",
    nameAr: "تغريدات حساب محدد على X",
    nameEn: "X User Recent Tweets",
    descriptionAr: "استخراج أحدث المنشورات والتغريدات العامة لحساب على منصة X",
    tregEndpointId: "twitter.user.tweets",
    endpointSource: "https://treg.to (Twitter/X user tweets endpoint)",
    verified: false,
    enabled: false,
    params: ["username", "count"],
    paramsSchema: JSON.stringify({
      type: "object",
      properties: { username: { type: "string" }, count: { type: "integer", maximum: 500 } },
      required: ["username"]
    }),
    pricingUnit: "item",
    unitCostUsd: 0.00007,
    maxRows: 500,
    paginationType: "cursor",
  },
  {
    slug: "x-keyword-search",
    category: "x",
    nameAr: "البحث في تغريدات X بكلمة مفتاحية",
    nameEn: "X Keyword Tweet Search",
    descriptionAr: "البحث في التغريدات العامة على منصة X بكلمة مفتاحية أو هاشتاج مع التفاعل والتواريخ",
    tregEndpointId: "twitter.search.tweets",
    endpointSource: "https://treg.to (Twitter/X search tweets endpoint)",
    verified: false,
    enabled: false,
    params: ["query", "count"],
    paramsSchema: JSON.stringify({
      type: "object",
      properties: { query: { type: "string" }, count: { type: "integer", maximum: 500 } },
      required: ["query"]
    }),
    pricingUnit: "item",
    unitCostUsd: 0.00007,
    maxRows: 500,
    paginationType: "cursor",
  },
  {
    slug: "x-user-profile",
    category: "x",
    nameAr: "بيانات ملف شخصي على منصة X",
    nameEn: "X User Profile",
    descriptionAr: "استخراج بيانات الحساب الرسمي والمعرف والمتابعين والنبذة لحساب على X",
    tregEndpointId: "twitter.user.profile",
    endpointSource: "https://treg.to (Twitter/X user profile endpoint)",
    verified: false,
    enabled: false,
    params: ["username"],
    paramsSchema: JSON.stringify({
      type: "object",
      properties: { username: { type: "string" } },
      required: ["username"]
    }),
    pricingUnit: "call",
    unitCostUsd: 0.001,
    maxRows: 1,
    paginationType: "none",
  },
  {
    slug: "youtube-channel-info",
    category: "youtube",
    nameAr: "بيانات وإحصائيات قناة يوتيوب",
    nameEn: "YouTube Channel Info",
    descriptionAr: "استخراج إحصائيات قناة يوتيوب العامة والمشتركين وإجمالي المشاهدات",
    tregEndpointId: "youtube.channel.details",
    endpointSource: "https://treg.to (YouTube Data API channel details)",
    verified: false,
    enabled: false,
    params: ["channelIdOrHandle"],
    paramsSchema: JSON.stringify({
      type: "object",
      properties: { channelIdOrHandle: { type: "string" } },
      required: ["channelIdOrHandle"]
    }),
    pricingUnit: "call",
    unitCostUsd: 0.001,
    maxRows: 1,
    paginationType: "none",
  },
  {
    slug: "youtube-channel-videos",
    category: "youtube",
    nameAr: "أحدث مقاطع قناة يوتيوب",
    nameEn: "YouTube Channel Videos",
    descriptionAr: "استخراج قائمة مقاطع الفيديو المنشورة في قناة يوتيوب مع عناوينها ومشاهداتها",
    tregEndpointId: "youtube.channel.videos",
    endpointSource: "https://treg.to (YouTube Data API channel videos)",
    verified: false,
    enabled: false,
    params: ["channelIdOrHandle", "count"],
    paramsSchema: JSON.stringify({
      type: "object",
      properties: { channelIdOrHandle: { type: "string" }, count: { type: "integer", maximum: 200 } },
      required: ["channelIdOrHandle"]
    }),
    pricingUnit: "item",
    unitCostUsd: 0.0002,
    maxRows: 200,
    paginationType: "cursor",
  },
  {
    slug: "youtube-search",
    category: "youtube",
    nameAr: "البحث في يوتيوب بكلمة مفتاحية",
    nameEn: "YouTube Search Videos",
    descriptionAr: "البحث عن مقاطع فيديو على يوتيوب بالكلمات الدلالية",
    tregEndpointId: "youtube.search",
    endpointSource: "https://treg.to (YouTube Data API search)",
    verified: false,
    enabled: false,
    params: ["query", "count"],
    paramsSchema: JSON.stringify({
      type: "object",
      properties: { query: { type: "string" }, count: { type: "integer", maximum: 300 } },
      required: ["query"]
    }),
    pricingUnit: "item",
    unitCostUsd: 0.0002,
    maxRows: 300,
    paginationType: "cursor",
  },
  {
    slug: "youtube-video-comments",
    category: "youtube",
    nameAr: "تعليقات مقطع يوتيوب",
    nameEn: "YouTube Video Comments",
    descriptionAr: "استخراج تعليقات الجمهور على مقطع يوتيوب محدد",
    tregEndpointId: "youtube.video.comments",
    endpointSource: "https://treg.to (YouTube Data API video comments)",
    verified: false,
    enabled: false,
    params: ["videoId", "count"],
    paramsSchema: JSON.stringify({
      type: "object",
      properties: { videoId: { type: "string" }, count: { type: "integer", maximum: 500 } },
      required: ["videoId"]
    }),
    pricingUnit: "item",
    unitCostUsd: 0.00015,
    maxRows: 500,
    paginationType: "cursor",
  },
  {
    slug: "web-search",
    category: "web",
    nameAr: "البحث العام في الويب",
    nameEn: "Web Search Engine",
    descriptionAr: "البحث العام في مواقع الإنترنت واستخراج عناوين الصفحات وروابطها وملخصاتها",
    tregEndpointId: "serp.google.search",
    endpointSource: "https://treg.to (SERP Google Search endpoint)",
    verified: false,
    enabled: false,
    params: ["query", "count"],
    paramsSchema: JSON.stringify({
      type: "object",
      properties: { query: { type: "string" }, count: { type: "integer", maximum: 100 } },
      required: ["query"]
    }),
    pricingUnit: "page",
    unitCostUsd: 0.002,
    maxRows: 100,
    paginationType: "cursor",
  },
  {
    slug: "web-extract-article",
    category: "web",
    nameAr: "استخراج المحتوى الكامل لصفحة ويب",
    nameEn: "Web Article Extractor",
    descriptionAr: "استخراج نص المقال والمؤلف وتاريخ النشر والصور من رابط ويب عام",
    tregEndpointId: "web.article.extract",
    endpointSource: "https://treg.to (Web Article Content Extractor)",
    verified: false,
    enabled: false,
    params: ["url"],
    paramsSchema: JSON.stringify({
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"]
    }),
    pricingUnit: "item",
    unitCostUsd: 0.002,
    maxRows: 10,
    paginationType: "none",
  },
];

async function main() {
  console.log("⚙️ Updating capability_registry in Appwrite DB to ensure honesty (only verified enabled)...");

  for (const cap of CAPABILITIES_CATALOG) {
    try {
      await tables.updateRow({
        databaseId: "digr",
        tableId: "capability_registry",
        rowId: cap.slug,
        data: {
          enabled: cap.enabled, // Only tiktok-profile is true!
          unitCostUsd: cap.unitCostUsd,
        },
      });
      console.log(`  ✓ ${cap.slug}: enabled=${cap.enabled}, unitCostUsd=${cap.unitCostUsd} (verified=${cap.verified})`);
    } catch (err: any) {
      console.error(`  ✗ Error updating ${cap.slug}:`, err.message);
    }
  }

  // Verify DB state
  const res = await tables.listRows({
    databaseId: "digr",
    tableId: "capability_registry",
  });

  console.log(`\nVerification Summary: Total rows in DB = ${res.total}`);
  const enabledRows = res.rows.filter((r: any) => r.enabled);
  console.log(`Currently Enabled Capabilities (${enabledRows.length}):`, enabledRows.map((r: any) => r.slug).join(", "));
}

main().catch(console.error);
