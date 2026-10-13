import { Client, TablesDB, Storage, Permission, Role } from "node-appwrite";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1";
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482";
const apiKey = process.env.APPWRITE_API_KEY;

if (!apiKey) {
  console.error("❌ ERROR: APPWRITE_API_KEY is not defined in .env.local");
  process.exit(1);
}

const client = new Client()
  .setEndpoint(endpoint)
  .setProject(projectId)
  .setKey(apiKey);

const tables = new TablesDB(client);
const storage = new Storage(client);

const DATABASE_ID = "digr";

async function ensureDatabase() {
  try {
    await tables.get(DATABASE_ID);
    console.log(`✓ Database '${DATABASE_ID}' already exists.`);
  } catch (err: any) {
    if (err.code === 404) {
      await tables.create({ databaseId: DATABASE_ID, name: "Diger" });
      console.log(`✓ Database '${DATABASE_ID}' created.`);
    } else {
      throw err;
    }
  }
}

async function ensureTable(
  tableId: string,
  name: string,
  permissions: string[],
  rowSecurity: boolean,
  columns: any[],
  indexes: any[]
) {
  try {
    const existing = await tables.getTable({ databaseId: DATABASE_ID, tableId });
    console.log(`✓ Table '${tableId}' already exists.`);

    // Ensure all requested indexes exist
    try {
      const existingIndexes = await tables.listIndexes({ databaseId: DATABASE_ID, tableId });
      const indexKeys = new Set(existingIndexes.indexes.map((idx: any) => idx.key));
      for (const idx of indexes) {
        if (!indexKeys.has(idx.key)) {
          await tables.createIndex({
            databaseId: DATABASE_ID,
            tableId,
            key: idx.key,
            type: idx.type,
            columns: idx.attributes,
          });
          console.log(`  + Created missing index '${idx.key}' on table '${tableId}'.`);
        }
      }
    } catch (idxErr: any) {
      console.warn(`  ! Note on checking indexes for ${tableId}:`, idxErr.message);
    }

    return existing;
  } catch (err: any) {
    if (err.code === 404) {
      const created = await tables.createTable({
        databaseId: DATABASE_ID,
        tableId,
        name,
        permissions,
        rowSecurity,
        columns,
        indexes,
      });
      console.log(`✓ Table '${tableId}' created (rowSecurity: ${rowSecurity}).`);
      return created;
    }
    throw err;
  }
}

async function ensureBucket(
  id: string,
  name: string,
  permissions: string[],
  fileSecurity: boolean,
  exts: string[],
  maxSize: number
) {
  try {
    const existing = await storage.getBucket(id);
    console.log(`✓ Bucket '${id}' already exists.`);
    await storage.updateBucket({
      bucketId: id,
      name,
      permissions,
      fileSecurity,
      enabled: true,
      maximumFileSize: maxSize,
      allowedFileExtensions: exts,
    });
    return existing;
  } catch (err: any) {
    if (err.code === 404) {
      await storage.createBucket(
        id,
        name,
        permissions,
        fileSecurity,
        true, // enabled
        maxSize,
        exts
      );
      console.log(`✓ Bucket '${id}' created.`);
    } else {
      throw err;
    }
  }
}

async function ensureRow(tableId: string, rowId: string, data: any) {
  try {
    await tables.getRow({ databaseId: DATABASE_ID, tableId, rowId });
  } catch (err: any) {
    if (err.code === 404) {
      await tables.createRow({
        databaseId: DATABASE_ID,
        tableId,
        rowId,
        data,
      });
      console.log(`  + Seeded row '${rowId}' in '${tableId}'`);
    } else {
      throw err;
    }
  }
}

async function setup() {
  console.log("🚀 Setting up Diger database & storage via TablesDB in Appwrite Cloud...\n");
  await ensureDatabase();

  // Tier 1: Public Tables (Read: Users, rowSecurity: false)
  console.log("\n[1/3] Setting up Public Tables...");

  await ensureTable(
    "templates",
    "Templates",
    [Permission.read(Role.users())],
    false,
    [
      { key: "slug", type: "varchar", size: 64, required: true },
      { key: "nameAr", type: "varchar", size: 128, required: true },
      { key: "nameEn", type: "varchar", size: 128, required: true },
      { key: "descriptionAr", type: "varchar", size: 512, required: false },
      { key: "paramsSchema", type: "text", required: true },
      { key: "priceCreditsPerUnit", type: "integer", required: true },
      { key: "maxRows", type: "integer", required: true },
      { key: "enabled", type: "boolean", required: true },
    ],
    [
      { key: "slug_idx", type: "unique", attributes: ["slug"] },
    ]
  );

  await ensureTable(
    "settings_public",
    "Settings Public",
    [Permission.read(Role.users())],
    false,
    [
      { key: "key", type: "varchar", size: 64, required: true },
      { key: "creditValueEgp", type: "double", required: true },
      { key: "updatedAt", type: "datetime", required: true },
    ],
    [
      { key: "key_idx", type: "unique", attributes: ["key"] },
    ]
  );

  // Tier 2: Private User-Owned Tables (Permissions: empty, rowSecurity: true)
  console.log("\n[2/3] Setting up Private User-Owned Tables (rowSecurity: true)...");

  await ensureTable(
    "profiles",
    "Profiles",
    [],
    true,
    [
      { key: "userId", type: "varchar", size: 36, required: true },
      { key: "displayName", type: "varchar", size: 128, required: true },
      { key: "role", type: "enum", elements: ["user", "admin"], required: false, default: "user" },
      { key: "createdAt", type: "datetime", required: true },
    ],
    [
      { key: "userId_idx", type: "unique", attributes: ["userId"] },
    ]
  );

  await ensureTable(
    "credit_ledger",
    "Credit Ledger",
    [],
    true,
    [
      { key: "userId", type: "varchar", size: 36, required: true },
      { key: "delta", type: "integer", required: true },
      { key: "type", type: "enum", elements: ["topup", "reserve", "release", "charge", "promo", "adjust"], required: true },
      { key: "jobId", type: "varchar", size: 36, required: false },
      { key: "topupId", type: "varchar", size: 36, required: false },
      { key: "note", type: "varchar", size: 512, required: false },
      { key: "createdAt", type: "datetime", required: true },
    ],
    [
      { key: "userId_idx", type: "key", attributes: ["userId"] },
      { key: "user_type_idx", type: "key", attributes: ["userId", "type"] },
      { key: "jobId_idx", type: "key", attributes: ["jobId"] },
    ]
  );

  await ensureTable(
    "topups",
    "Topups",
    [],
    true,
    [
      { key: "userId", type: "varchar", size: 36, required: true },
      { key: "amountEgp", type: "double", required: true },
      { key: "confirmedAmountEgp", type: "double", required: false },
      { key: "credits", type: "integer", required: false },
      { key: "reference", type: "varchar", size: 128, required: true },
      { key: "receiptFileId", type: "varchar", size: 36, required: false },
      { key: "status", type: "enum", elements: ["pending", "approved", "rejected"], required: false, default: "pending" },
      { key: "reviewedBy", type: "varchar", size: 36, required: false },
      { key: "reviewedAt", type: "datetime", required: false },
      { key: "createdAt", type: "datetime", required: true },
    ],
    [
      { key: "userId_idx", type: "key", attributes: ["userId"] },
      { key: "status_idx", type: "key", attributes: ["status"] },
      { key: "reference_idx", type: "unique", attributes: ["reference"] },
      { key: "receiptFileId_idx", type: "unique", attributes: ["receiptFileId"] },
    ]
  );

  await ensureTable(
    "jobs",
    "Jobs",
    [],
    true,
    [
      { key: "userId", type: "varchar", size: 36, required: true },
      { key: "templateSlug", type: "varchar", size: 64, required: true },
      { key: "params", type: "text", required: true },
      { key: "status", type: "enum", elements: ["queued", "running", "done", "failed", "cancelled"], required: false, default: "queued" },
      { key: "estCredits", type: "integer", required: true },
      { key: "reservedCredits", type: "integer", required: true },
      { key: "chargedCredits", type: "integer", required: false },
      { key: "rowsCollected", type: "integer", required: false },
      { key: "resultFileId", type: "varchar", size: 36, required: false },
      { key: "errorAr", type: "varchar", size: 512, required: false },
      { key: "createdAt", type: "datetime", required: true },
      { key: "finishedAt", type: "datetime", required: false },
    ],
    [
      { key: "userId_idx", type: "key", attributes: ["userId"] },
      { key: "status_idx", type: "key", attributes: ["status"] },
      { key: "user_status_idx", type: "key", attributes: ["userId", "status"] },
    ]
  );

  await ensureTable(
    "job_events",
    "Job Events",
    [],
    true,
    [
      { key: "jobId", type: "varchar", size: 36, required: true },
      { key: "textAr", type: "varchar", size: 512, required: true },
      { key: "count", type: "integer", required: false },
      { key: "kind", type: "enum", elements: ["info", "progress", "warning", "error"], required: true },
      { key: "createdAt", type: "datetime", required: true },
    ],
    [
      { key: "jobId_idx", type: "key", attributes: ["jobId"] },
      { key: "job_created_idx", type: "key", attributes: ["jobId", "createdAt"] },
    ]
  );

  await ensureTable(
    "conversations",
    "Conversations",
    [],
    true,
    [
      { key: "userId", type: "varchar", size: 36, required: true },
      { key: "title", type: "varchar", size: 256, required: true },
      { key: "status", type: "enum", elements: ["active", "archived"], required: false, default: "active" },
      { key: "totalTokens", type: "integer", required: false, default: 0 },
      { key: "costUsd", type: "double", required: false, default: 0.0 },
      { key: "createdAt", type: "datetime", required: true },
      { key: "updatedAt", type: "datetime", required: true },
    ],
    [
      { key: "userId_idx", type: "key", attributes: ["userId"] },
      { key: "status_idx", type: "key", attributes: ["status"] },
    ]
  );

  await ensureTable(
    "messages",
    "Messages",
    [],
    true,
    [
      { key: "conversationId", type: "varchar", size: 36, required: true },
      { key: "userId", type: "varchar", size: 36, required: true },
      { key: "role", type: "enum", elements: ["user", "assistant", "system"], required: true },
      { key: "content", type: "text", required: true },
      { key: "status", type: "enum", elements: ["thinking", "ready", "failed"], required: false, default: "ready" },
      { key: "planQuoteId", type: "varchar", size: 36, required: false },
      { key: "createdAt", type: "datetime", required: true },
    ],
    [
      { key: "conversation_idx", type: "key", attributes: ["conversationId"] },
      { key: "user_idx", type: "key", attributes: ["userId"] },
    ]
  );

  await ensureTable(
    "plans_quotes",
    "Plans Quotes",
    [],
    true,
    [
      { key: "conversationId", type: "varchar", size: 36, required: true },
      { key: "userId", type: "varchar", size: 36, required: true },
      { key: "jobId", type: "varchar", size: 36, required: false },
      { key: "status", type: "enum", elements: ["proposed", "accepted", "rejected", "expired"], required: true },
      { key: "summaryAr", type: "varchar", size: 512, required: true },
      { key: "itemsJson", type: "text", required: true },
      { key: "targetVolumeMax", type: "integer", required: true },
      { key: "unitPricePoints", type: "double", required: true },
      { key: "quotedPoints", type: "integer", required: true },
      { key: "reservedPoints", type: "integer", required: false },
      { key: "chargedPoints", type: "integer", required: false },
      { key: "settingsVersion", type: "varchar", size: 64, required: true },
      { key: "expiresAt", type: "datetime", required: true },
      { key: "createdAt", type: "datetime", required: true },
    ],
    [
      { key: "conversation_idx", type: "key", attributes: ["conversationId"] },
      { key: "user_idx", type: "key", attributes: ["userId"] },
      { key: "status_idx", type: "key", attributes: ["status"] },
    ]
  );

  await ensureTable(
    "artifact_versions",
    "Artifact Versions",
    [],
    true,
    [
      { key: "conversationId", type: "varchar", size: 36, required: true },
      { key: "userId", type: "varchar", size: 36, required: true },
      { key: "jobId", type: "varchar", size: 36, required: true },
      { key: "versionNum", type: "integer", required: true },
      { key: "parentVersionId", type: "varchar", size: 36, required: false },
      { key: "operationJson", type: "text", required: true },
      { key: "rowCount", type: "integer", required: true },
      { key: "fileIdXlsx", type: "varchar", size: 36, required: false },
      { key: "fileIdPdf", type: "varchar", size: 36, required: false },
      { key: "fileIdCsv", type: "varchar", size: 36, required: false },
      { key: "isOriginal", type: "boolean", required: true },
      { key: "createdAt", type: "datetime", required: true },
    ],
    [
      { key: "conversation_idx", type: "key", attributes: ["conversationId"] },
      { key: "job_idx", type: "key", attributes: ["jobId"] },
    ]
  );

  await ensureTable(
    "notes",
    "Notes",
    [],
    true,
    [
      { key: "conversationId", type: "varchar", size: 36, required: true },
      { key: "userId", type: "varchar", size: 36, required: true },
      { key: "contentMarkdown", type: "text", required: true },
      { key: "updatedAt", type: "datetime", required: true },
    ],
    [
      { key: "conversation_idx", type: "unique", attributes: ["conversationId"] },
      { key: "user_idx", type: "key", attributes: ["userId"] },
    ]
  );

  await ensureTable(
    "capability_requests",
    "Capability Requests",
    [],
    true,
    [
      { key: "userId", type: "varchar", size: 36, required: true },
      { key: "queryAr", type: "varchar", size: 512, required: true },
      { key: "platform", type: "varchar", size: 64, required: true },
      { key: "createdAt", type: "datetime", required: true },
    ],
    [
      { key: "user_idx", type: "key", attributes: ["userId"] },
    ]
  );

  // Tier 3: Server-Only Tables (Permissions: empty, rowSecurity: false)
  console.log("\n[3/3] Setting up Server-Only Tables...");

  await ensureTable(
    "templates_private",
    "Templates Private",
    [],
    false,
    [
      { key: "slug", type: "varchar", size: 64, required: true },
      { key: "tregEndpointId", type: "varchar", size: 128, required: true },
      { key: "tregMethod", type: "enum", elements: ["GET", "POST"], required: true },
      { key: "pricingUnit", type: "varchar", size: 64, required: true },
      { key: "estimatedCostUsd", type: "double", required: true },
      { key: "maxCostUsd", type: "double", required: true },
    ],
    [
      { key: "slug_idx", type: "unique", attributes: ["slug"] },
    ]
  );

  await ensureTable(
    "settings",
    "Settings Private",
    [],
    false,
    [
      { key: "key", type: "varchar", size: 64, required: true },
      { key: "usdToEgp", type: "double", required: true },
      { key: "markup", type: "double", required: true },
      { key: "minMarginThreshold", type: "double", required: true },
      { key: "updatedAt", type: "datetime", required: true },
    ],
    [
      { key: "key_idx", type: "unique", attributes: ["key"] },
    ]
  );

  await ensureTable(
    "job_calls",
    "Job Calls",
    [],
    false,
    [
      { key: "jobId", type: "varchar", size: 36, required: true },
      { key: "tregCallId", type: "varchar", size: 128, required: true },
      { key: "endpointId", type: "varchar", size: 128, required: true },
      { key: "idemKey", type: "varchar", size: 128, required: true },
      { key: "httpStatus", type: "integer", required: true },
      { key: "costMicro", type: "integer", required: true },
      { key: "cacheHit", type: "boolean", required: true },
      { key: "fetchedAt", type: "varchar", size: 64, required: false },
      { key: "createdAt", type: "datetime", required: true },
    ],
    [
      { key: "jobId_idx", type: "key", attributes: ["jobId"] },
    ]
  );

  await ensureTable(
    "jobs_internal",
    "Jobs Internal",
    [],
    false,
    [
      { key: "jobId", type: "varchar", size: 36, required: true },
      { key: "actualCostMicro", type: "integer", required: true },
      { key: "revenueCredits", type: "integer", required: true },
      { key: "marginEgp", type: "double", required: true },
      { key: "dataSource", type: "varchar", size: 16, required: false, default: "live" },
    ],
    [
      { key: "jobId_idx", type: "unique", attributes: ["jobId"] },
    ]
  );

  await ensureTable(
    "capability_registry",
    "Capability Registry",
    [],
    false,
    [
      { key: "slug", type: "varchar", size: 64, required: true },
      { key: "category", type: "enum", elements: ["x", "youtube", "tiktok", "web"], required: true },
      { key: "nameAr", type: "varchar", size: 128, required: true },
      { key: "nameEn", type: "varchar", size: 128, required: true },
      { key: "descriptionAr", type: "varchar", size: 512, required: true },
      { key: "paramsSchema", type: "text", required: true },
      { key: "tregEndpointId", type: "varchar", size: 128, required: true },
      { key: "tregMethod", type: "enum", elements: ["GET", "POST"], required: true },
      { key: "pricingUnit", type: "enum", elements: ["call", "item", "page"], required: true },
      { key: "unitCostUsd", type: "double", required: true },
      { key: "maxRows", type: "integer", required: true },
      { key: "paginationType", type: "enum", elements: ["cursor", "offset", "none"], required: true },
      { key: "enabled", type: "boolean", required: true },
    ],
    [
      { key: "slug_idx", type: "unique", attributes: ["slug"] },
      { key: "category_idx", type: "key", attributes: ["category"] },
    ]
  );

  await ensureTable(
    "llm_usage",
    "LLM Usage",
    [],
    false,
    [
      { key: "conversationId", type: "varchar", size: 36, required: true },
      { key: "userId", type: "varchar", size: 36, required: true },
      { key: "model", type: "varchar", size: 64, required: true },
      { key: "inputTokens", type: "integer", required: true },
      { key: "outputTokens", type: "integer", required: true },
      { key: "costUsd", type: "double", required: true },
      { key: "turnCount", type: "integer", required: false, default: 1 },
      { key: "createdAt", type: "datetime", required: true },
    ],
    [
      { key: "conversation_idx", type: "key", attributes: ["conversationId"] },
      { key: "user_idx", type: "key", attributes: ["userId"] },
    ]
  );

  // Storage Buckets
  console.log("\n📦 Setting up Storage Buckets...");
  await ensureBucket("results", "Results", [], true, ["xlsx", "pdf", "csv"], 52428800);
  await ensureBucket(
    "receipts",
    "Receipts",
    [Permission.create(Role.users())],
    true,
    ["png", "jpg", "jpeg", "pdf"],
    5242880
  );
  await ensureBucket("partials", "Partials", [], false, ["jsonl"], 104857600);

  // Seeds
  console.log("\n🌱 Seeding initial configurations & Template 0...");
  const now = new Date().toISOString();

  await ensureRow("settings_public", "pricing", {
    key: "pricing",
    creditValueEgp: 0.1,
    updatedAt: now,
  });

  await ensureRow("settings", "pricing", {
    key: "pricing",
    usdToEgp: 50.0,
    markup: 1.3,
    minMarginThreshold: 0.2,
    updatedAt: now,
  });

  await ensureRow("templates", "tiktok-profile", {
    slug: "tiktok-profile",
    nameAr: "ملف تيك توك الشخصي",
    nameEn: "TikTok Public Profile",
    descriptionAr: "استرجاع بيانات الملف الشخصي لحساب تيك توك عام باستخدام اسم المستخدم",
    paramsSchema: JSON.stringify({
      type: "object",
      properties: {
        username: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          pattern: "^[a-zA-Z0-9._]+$",
          description: "اسم المستخدم بدون @",
        },
      },
      required: ["username"],
    }),
    priceCreditsPerUnit: 1,
    maxRows: 1,
    enabled: true,
  });

  await ensureRow("templates_private", "tiktok-profile", {
    slug: "tiktok-profile",
    tregEndpointId: "tikhub.tiktok.user.profile",
    tregMethod: "GET",
    pricingUnit: "call",
    estimatedCostUsd: 0.001,
    maxCostUsd: 0.01,
  });

  console.log("\n🌱 Seeding Capability Registry (12 capabilities)...");
  const capabilitiesSeed = [
    {
      slug: "tiktok-profile",
      category: "tiktok",
      nameAr: "استخراج ملف تيك توك الشخصي",
      nameEn: "TikTok User Profile",
      descriptionAr: "استخراج الإحصائيات الشاملة والنبذة التعريفية وحالة التوثيق لحساب تيك توك عام",
      paramsSchema: JSON.stringify({
        type: "object",
        properties: { username: { type: "string", description: "اسم المستخدم بدون @" } },
        required: ["username"]
      }),
      tregEndpointId: "tikhub.tiktok.user.profile",
      tregMethod: "GET",
      pricingUnit: "call",
      unitCostUsd: 0.0012,
      maxRows: 1,
      paginationType: "none",
      enabled: true
    },
    {
      slug: "tiktok-user-videos",
      category: "tiktok",
      nameAr: "مقاطع فيديو مستخدم تيك توك",
      nameEn: "TikTok User Recent Videos",
      descriptionAr: "استخراج أحدث مقاطع الفيديو المنشورة في حساب تيك توك عام مع إحصائيات المشاهدة والتفاعل",
      paramsSchema: JSON.stringify({
        type: "object",
        properties: { username: { type: "string" }, count: { type: "integer", maximum: 200 } },
        required: ["username"]
      }),
      tregEndpointId: "tikhub.tiktok.user.posts",
      tregMethod: "GET",
      pricingUnit: "item",
      unitCostUsd: 0.0003,
      maxRows: 200,
      paginationType: "cursor",
      enabled: false
    },
    {
      slug: "tiktok-keyword-videos",
      category: "tiktok",
      nameAr: "البحث في مقاطع تيك توك بكلمة مفتاحية",
      nameEn: "TikTok Keyword Video Search",
      descriptionAr: "البحث عن مقاطع تيك توك العامة المرتبطة بكلمة مفتاحية أو وسم",
      paramsSchema: JSON.stringify({
        type: "object",
        properties: { keyword: { type: "string" }, count: { type: "integer", maximum: 300 } },
        required: ["keyword"]
      }),
      tregEndpointId: "tikhub.tiktok.search.video",
      tregMethod: "GET",
      pricingUnit: "item",
      unitCostUsd: 0.00035,
      maxRows: 300,
      paginationType: "cursor",
      enabled: false
    },
    {
      slug: "x-user-tweets",
      category: "x",
      nameAr: "تغريدات حساب محدد على X",
      nameEn: "X User Recent Tweets",
      descriptionAr: "استخراج أحدث المنشورات والتغريدات العامة لحساب على منصة X",
      paramsSchema: JSON.stringify({
        type: "object",
        properties: { username: { type: "string" }, count: { type: "integer", maximum: 500 } },
        required: ["username"]
      }),
      tregEndpointId: "twitter.user.tweets",
      tregMethod: "GET",
      pricingUnit: "item",
      unitCostUsd: 0.00007,
      maxRows: 500,
      paginationType: "cursor",
      enabled: false
    },
    {
      slug: "x-keyword-search",
      category: "x",
      nameAr: "البحث في تغريدات X بكلمة مفتاحية",
      nameEn: "X Keyword Tweet Search",
      descriptionAr: "البحث في التغريدات العامة على منصة X بكلمة مفتاحية أو هاشتاج مع التفاعل والتواريخ",
      paramsSchema: JSON.stringify({
        type: "object",
        properties: { query: { type: "string" }, count: { type: "integer", maximum: 500 } },
        required: ["query"]
      }),
      tregEndpointId: "twitter.search.tweets",
      tregMethod: "GET",
      pricingUnit: "item",
      unitCostUsd: 0.00007,
      maxRows: 500,
      paginationType: "cursor",
      enabled: false
    },
    {
      slug: "x-user-profile",
      category: "x",
      nameAr: "بيانات ملف شخصي على منصة X",
      nameEn: "X User Profile",
      descriptionAr: "استخراج بيانات الحساب الرسمي والمعرف والمتابعين والنبذة لحساب على X",
      paramsSchema: JSON.stringify({
        type: "object",
        properties: { username: { type: "string" } },
        required: ["username"]
      }),
      tregEndpointId: "twitter.user.profile",
      tregMethod: "GET",
      pricingUnit: "call",
      unitCostUsd: 0.001,
      maxRows: 1,
      paginationType: "none",
      enabled: false
    },
    {
      slug: "youtube-channel-info",
      category: "youtube",
      nameAr: "بيانات وإحصائيات قناة يوتيوب",
      nameEn: "YouTube Channel Info",
      descriptionAr: "استخراج إحصائيات قناة يوتيوب العامة والمشتركين وإجمالي المشاهدات",
      paramsSchema: JSON.stringify({
        type: "object",
        properties: { channelIdOrHandle: { type: "string" } },
        required: ["channelIdOrHandle"]
      }),
      tregEndpointId: "youtube.channel.details",
      tregMethod: "GET",
      pricingUnit: "call",
      unitCostUsd: 0.001,
      maxRows: 1,
      paginationType: "none",
      enabled: false
    },
    {
      slug: "youtube-channel-videos",
      category: "youtube",
      nameAr: "أحدث مقاطع قناة يوتيوب",
      nameEn: "YouTube Channel Videos",
      descriptionAr: "استخراج قائمة مقاطع الفيديو المنشورة في قناة يوتيوب مع عناوينها ومشاهداتها",
      paramsSchema: JSON.stringify({
        type: "object",
        properties: { channelIdOrHandle: { type: "string" }, count: { type: "integer", maximum: 200 } },
        required: ["channelIdOrHandle"]
      }),
      tregEndpointId: "youtube.channel.videos",
      tregMethod: "GET",
      pricingUnit: "item",
      unitCostUsd: 0.0002,
      maxRows: 200,
      paginationType: "cursor",
      enabled: false
    },
    {
      slug: "youtube-search",
      category: "youtube",
      nameAr: "البحث في يوتيوب بكلمة مفتاحية",
      nameEn: "YouTube Search Videos",
      descriptionAr: "البحث عن مقاطع فيديو على يوتيوب بالكلمات الدلالية",
      paramsSchema: JSON.stringify({
        type: "object",
        properties: { query: { type: "string" }, count: { type: "integer", maximum: 300 } },
        required: ["query"]
      }),
      tregEndpointId: "youtube.search",
      tregMethod: "GET",
      pricingUnit: "item",
      unitCostUsd: 0.0002,
      maxRows: 300,
      paginationType: "cursor",
      enabled: false
    },
    {
      slug: "youtube-video-comments",
      category: "youtube",
      nameAr: "تعليقات مقطع يوتيوب",
      nameEn: "YouTube Video Comments",
      descriptionAr: "استخراج تعليقات الجمهور على مقطع يوتيوب محدد",
      paramsSchema: JSON.stringify({
        type: "object",
        properties: { videoId: { type: "string" }, count: { type: "integer", maximum: 500 } },
        required: ["videoId"]
      }),
      tregEndpointId: "youtube.video.comments",
      tregMethod: "GET",
      pricingUnit: "item",
      unitCostUsd: 0.00015,
      maxRows: 500,
      paginationType: "cursor",
      enabled: false
    },
    {
      slug: "web-search",
      category: "web",
      nameAr: "البحث العام في الويب",
      nameEn: "Web Search Engine",
      descriptionAr: "البحث العام في مواقع الإنترنت واستخراج عناوين الصفحات وروابطها وملخصاتها",
      paramsSchema: JSON.stringify({
        type: "object",
        properties: { query: { type: "string" }, count: { type: "integer", maximum: 100 } },
        required: ["query"]
      }),
      tregEndpointId: "serp.google.search",
      tregMethod: "GET",
      pricingUnit: "page",
      unitCostUsd: 0.002,
      maxRows: 100,
      paginationType: "cursor",
      enabled: false
    },
    {
      slug: "web-extract-article",
      category: "web",
      nameAr: "استخراج المحتوى الكامل لصفحة ويب",
      nameEn: "Web Article Extractor",
      descriptionAr: "استخراج نص المقال والمؤلف وتاريخ النشر والصور من رابط ويب عام",
      paramsSchema: JSON.stringify({
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"]
      }),
      tregEndpointId: "web.article.extract",
      tregMethod: "GET",
      pricingUnit: "item",
      unitCostUsd: 0.002,
      maxRows: 10,
      paginationType: "none",
      enabled: false
    },
  ];

  for (const cap of capabilitiesSeed) {
    await ensureRow("capability_registry", cap.slug, cap);
  }

  console.log("\n✅ Database & Storage setup completed successfully!");
}

setup().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
