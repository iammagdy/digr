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
      await tables.create({ databaseId: DATABASE_ID, name: "Digr" });
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
    await storage.getBucket(id);
    console.log(`✓ Bucket '${id}' already exists.`);
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
  console.log("🚀 Setting up Digr database & storage via TablesDB in Appwrite Cloud...\n");
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
    ],
    [
      { key: "jobId_idx", type: "unique", attributes: ["jobId"] },
    ]
  );

  // Storage Buckets
  console.log("\n📦 Setting up Storage Buckets...");
  await ensureBucket("results", "Results", [], true, ["xlsx", "csv"], 52428800);
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

  console.log("\n✅ Database & Storage setup completed successfully!");
}

setup().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
