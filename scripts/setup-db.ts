import { Client, Databases, Storage, Permission, Role, AppwriteException } from "node-appwrite";
import * as dotenv from "dotenv";

// Load .env.local without logging its contents
dotenv.config({ path: ".env.local" });

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1";
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482";
const apiKey = process.env.APPWRITE_API_KEY;

if (!apiKey) {
  console.error("❌ ERROR: APPWRITE_API_KEY is not defined in .env.local");
  console.error("Please add APPWRITE_API_KEY=<your-secret-key> to .env.local to run setup.");
  process.exit(1);
}

const client = new Client()
  .setEndpoint(endpoint)
  .setProject(projectId)
  .setKey(apiKey);

const db = new Databases(client);
const storage = new Storage(client);

const DATABASE_ID = "digr";

async function ensureDatabase() {
  try {
    await db.get(DATABASE_ID);
    console.log(`✓ Database '${DATABASE_ID}' already exists.`);
  } catch (err: any) {
    if (err.code === 404) {
      await db.create(DATABASE_ID, "Digr");
      console.log(`✓ Database '${DATABASE_ID}' created.`);
    } else {
      throw err;
    }
  }
}

async function ensureCollection(
  id: string,
  name: string,
  permissions: string[],
  documentSecurity: boolean
) {
  try {
    const col = await db.getCollection(DATABASE_ID, id);
    console.log(`✓ Collection '${id}' exists.`);
    return col;
  } catch (err: any) {
    if (err.code === 404) {
      const col = await db.createCollection(DATABASE_ID, id, name, permissions, documentSecurity);
      console.log(`✓ Collection '${id}' created (docSecurity: ${documentSecurity}).`);
      return col;
    }
    throw err;
  }
}

async function waitAttributeReady(collectionId: string, key: string) {
  for (let i = 0; i < 30; i++) {
    try {
      const attr: any = await db.getAttribute(DATABASE_ID, collectionId, key);
      if (attr.status === "available") return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function ensureStringAttr(colId: string, key: string, size: number, req: boolean, def?: string) {
  try {
    await db.getAttribute(DATABASE_ID, colId, key);
  } catch (err: any) {
    if (err.code === 404) {
      await db.createStringAttribute(DATABASE_ID, colId, key, size, req, def);
      await waitAttributeReady(colId, key);
    }
  }
}

async function ensureIntegerAttr(colId: string, key: string, req: boolean, min?: number, max?: number, def?: number) {
  try {
    await db.getAttribute(DATABASE_ID, colId, key);
  } catch (err: any) {
    if (err.code === 404) {
      await db.createIntegerAttribute(DATABASE_ID, colId, key, req, min, max, def);
      await waitAttributeReady(colId, key);
    }
  }
}

async function ensureFloatAttr(colId: string, key: string, req: boolean, min?: number, max?: number, def?: number) {
  try {
    await db.getAttribute(DATABASE_ID, colId, key);
  } catch (err: any) {
    if (err.code === 404) {
      await db.createFloatAttribute(DATABASE_ID, colId, key, req, min, max, def);
      await waitAttributeReady(colId, key);
    }
  }
}

async function ensureBooleanAttr(colId: string, key: string, req: boolean, def?: boolean) {
  try {
    await db.getAttribute(DATABASE_ID, colId, key);
  } catch (err: any) {
    if (err.code === 404) {
      await db.createBooleanAttribute(DATABASE_ID, colId, key, req, def);
      await waitAttributeReady(colId, key);
    }
  }
}

async function ensureDatetimeAttr(colId: string, key: string, req: boolean, def?: string) {
  try {
    await db.getAttribute(DATABASE_ID, colId, key);
  } catch (err: any) {
    if (err.code === 404) {
      await db.createDatetimeAttribute(DATABASE_ID, colId, key, req, def);
      await waitAttributeReady(colId, key);
    }
  }
}

async function ensureEnumAttr(colId: string, key: string, elements: string[], req: boolean, def?: string) {
  try {
    await db.getAttribute(DATABASE_ID, colId, key);
  } catch (err: any) {
    if (err.code === 404) {
      await db.createEnumAttribute(DATABASE_ID, colId, key, elements, req, def);
      await waitAttributeReady(colId, key);
    }
  }
}

async function ensureIndex(colId: string, key: string, type: any, attributes: string[]) {
  try {
    await db.getIndex(DATABASE_ID, colId, key);
  } catch (err: any) {
    if (err.code === 404) {
      await db.createIndex(DATABASE_ID, colId, key, type, attributes);
      console.log(`  + Index '${key}' created on ${colId}`);
    }
  }
}

async function ensureBucket(id: string, name: string, permissions: string[], fileSecurity: boolean, exts: string[], maxSize: number) {
  try {
    await storage.getBucket(id);
    console.log(`✓ Bucket '${id}' exists.`);
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

async function setup() {
  console.log("🚀 Setting up Digr database & storage in Appwrite Cloud...");
  await ensureDatabase();

  // Tier 1: Public collections
  console.log("\n[1/3] Setting up Public collections...");
  await ensureCollection("templates", "Templates", [Permission.read(Role.users())], false);
  await ensureStringAttr("templates", "slug", 64, true);
  await ensureStringAttr("templates", "nameAr", 128, true);
  await ensureStringAttr("templates", "nameEn", 128, true);
  await ensureStringAttr("templates", "descriptionAr", 512, false);
  await ensureStringAttr("templates", "paramsSchema", 4096, true);
  await ensureIntegerAttr("templates", "priceCreditsPerUnit", true);
  await ensureIntegerAttr("templates", "maxRows", true);
  await ensureBooleanAttr("templates", "enabled", true);
  await ensureIndex("templates", "slug_idx", "unique", ["slug"]);

  await ensureCollection("settings_public", "Settings Public", [Permission.read(Role.users())], false);
  await ensureStringAttr("settings_public", "key", 64, true);
  await ensureFloatAttr("settings_public", "creditValueEgp", true);
  await ensureDatetimeAttr("settings_public", "updatedAt", true);
  await ensureIndex("settings_public", "key_idx", "unique", ["key"]);

  // Tier 2: Private user-owned collections (Doc Security ON, empty collection perms)
  console.log("\n[2/3] Setting up Private User-Owned collections (Doc Security ON)...");
  await ensureCollection("profiles", "Profiles", [], true);
  await ensureStringAttr("profiles", "userId", 36, true);
  await ensureStringAttr("profiles", "displayName", 128, true);
  await ensureEnumAttr("profiles", "role", ["user", "admin"], true, "user");
  await ensureDatetimeAttr("profiles", "createdAt", true);
  await ensureIndex("profiles", "userId_idx", "unique", ["userId"]);

  await ensureCollection("credit_ledger", "Credit Ledger", [], true);
  await ensureStringAttr("credit_ledger", "userId", 36, true);
  await ensureIntegerAttr("credit_ledger", "delta", true);
  await ensureEnumAttr("credit_ledger", "type", ["topup", "reserve", "release", "charge", "promo", "adjust"], true);
  await ensureStringAttr("credit_ledger", "jobId", 36, false);
  await ensureStringAttr("credit_ledger", "topupId", 36, false);
  await ensureStringAttr("credit_ledger", "note", 512, false);
  await ensureDatetimeAttr("credit_ledger", "createdAt", true);
  await ensureIndex("credit_ledger", "userId_idx", "key", ["userId"]);
  await ensureIndex("credit_ledger", "user_type_idx", "key", ["userId", "type"]);
  await ensureIndex("credit_ledger", "jobId_idx", "key", ["jobId"]);

  await ensureCollection("topups", "Topups", [], true);
  await ensureStringAttr("topups", "userId", 36, true);
  await ensureFloatAttr("topups", "amountEgp", true);
  await ensureIntegerAttr("topups", "credits", false);
  await ensureStringAttr("topups", "reference", 128, true);
  await ensureStringAttr("topups", "receiptFileId", 36, false);
  await ensureEnumAttr("topups", "status", ["pending", "approved", "rejected"], true, "pending");
  await ensureStringAttr("topups", "reviewedBy", 36, false);
  await ensureDatetimeAttr("topups", "reviewedAt", false);
  await ensureDatetimeAttr("topups", "createdAt", true);
  await ensureIndex("topups", "userId_idx", "key", ["userId"]);
  await ensureIndex("topups", "status_idx", "key", ["status"]);

  await ensureCollection("jobs", "Jobs", [], true);
  await ensureStringAttr("jobs", "userId", 36, true);
  await ensureStringAttr("jobs", "templateSlug", 64, true);
  await ensureStringAttr("jobs", "params", 4096, true);
  await ensureEnumAttr("jobs", "status", ["queued", "running", "done", "failed", "cancelled"], true, "queued");
  await ensureIntegerAttr("jobs", "estCredits", true);
  await ensureIntegerAttr("jobs", "reservedCredits", true);
  await ensureIntegerAttr("jobs", "chargedCredits", false);
  await ensureIntegerAttr("jobs", "rowsCollected", false);
  await ensureStringAttr("jobs", "resultFileId", 36, false);
  await ensureStringAttr("jobs", "errorAr", 512, false);
  await ensureDatetimeAttr("jobs", "createdAt", true);
  await ensureDatetimeAttr("jobs", "finishedAt", false);
  await ensureIndex("jobs", "userId_idx", "key", ["userId"]);
  await ensureIndex("jobs", "status_idx", "key", ["status"]);
  await ensureIndex("jobs", "user_status_idx", "key", ["userId", "status"]);

  await ensureCollection("job_events", "Job Events", [], true);
  await ensureStringAttr("job_events", "jobId", 36, true);
  await ensureStringAttr("job_events", "textAr", 512, true);
  await ensureIntegerAttr("job_events", "count", false);
  await ensureEnumAttr("job_events", "kind", ["info", "progress", "warning", "error"], true);
  await ensureDatetimeAttr("job_events", "createdAt", true);
  await ensureIndex("job_events", "jobId_idx", "key", ["jobId"]);
  await ensureIndex("job_events", "job_created_idx", "key", ["jobId", "createdAt"]);

  // Tier 3: Server-only collections (Doc Security OFF, empty collection perms)
  console.log("\n[3/3] Setting up Server-Only collections...");
  await ensureCollection("templates_private", "Templates Private", [], false);
  await ensureStringAttr("templates_private", "slug", 64, true);
  await ensureStringAttr("templates_private", "tregEndpointId", 128, true);
  await ensureEnumAttr("templates_private", "tregMethod", ["GET", "POST"], true);
  await ensureStringAttr("templates_private", "pricingUnit", 64, true);
  await ensureFloatAttr("templates_private", "estimatedCostUsd", true);
  await ensureFloatAttr("templates_private", "maxCostUsd", true);
  await ensureIndex("templates_private", "slug_idx", "unique", ["slug"]);

  await ensureCollection("settings", "Settings Private", [], false);
  await ensureStringAttr("settings", "key", 64, true);
  await ensureFloatAttr("settings", "usdToEgp", true);
  await ensureFloatAttr("settings", "markup", true);
  await ensureFloatAttr("settings", "minMarginThreshold", true);
  await ensureDatetimeAttr("settings", "updatedAt", true);
  await ensureIndex("settings", "key_idx", "unique", ["key"]);

  await ensureCollection("job_calls", "Job Calls", [], false);
  await ensureStringAttr("job_calls", "jobId", 36, true);
  await ensureStringAttr("job_calls", "tregCallId", 128, true);
  await ensureStringAttr("job_calls", "endpointId", 128, true);
  await ensureStringAttr("job_calls", "idemKey", 128, true);
  await ensureIntegerAttr("job_calls", "httpStatus", true);
  await ensureIntegerAttr("job_calls", "costMicro", true);
  await ensureBooleanAttr("job_calls", "cacheHit", true);
  await ensureStringAttr("job_calls", "fetchedAt", 64, false);
  await ensureDatetimeAttr("job_calls", "createdAt", true);
  await ensureIndex("job_calls", "jobId_idx", "key", ["jobId"]);

  await ensureCollection("jobs_internal", "Jobs Internal", [], false);
  await ensureStringAttr("jobs_internal", "jobId", 36, true);
  await ensureIntegerAttr("jobs_internal", "actualCostMicro", true);
  await ensureIntegerAttr("jobs_internal", "revenueCredits", true);
  await ensureFloatAttr("jobs_internal", "marginEgp", true);
  await ensureIndex("jobs_internal", "jobId_idx", "unique", ["jobId"]);

  // Storage Buckets
  console.log("\n📦 Setting up Storage Buckets...");
  await ensureBucket("results", "Results", [], true, ["xlsx", "csv"], 52428800);
  await ensureBucket("receipts", "Receipts", [Permission.create(Role.users())], true, ["png", "jpg", "jpeg", "pdf"], 5242880);
  await ensureBucket("partials", "Partials", [], false, ["jsonl"], 104857600);

  // Seed default data
  console.log("\n🌱 Seeding initial configurations & Template 0...");
  const now = new Date().toISOString();

  // Settings
  try {
    await db.getDocument(DATABASE_ID, "settings_public", "pricing");
  } catch {
    await db.createDocument(DATABASE_ID, "settings_public", "pricing", {
      key: "pricing",
      creditValueEgp: 0.1,
      updatedAt: now,
    });
    console.log("  + Seeded settings_public (pricing)");
  }

  try {
    await db.getDocument(DATABASE_ID, "settings", "pricing");
  } catch {
    await db.createDocument(DATABASE_ID, "settings", "pricing", {
      key: "pricing",
      usdToEgp: 50.0,
      markup: 1.3,
      minMarginThreshold: 0.2,
      updatedAt: now,
    });
    console.log("  + Seeded settings (pricing)");
  }

  // Template 0: TikTok profile
  try {
    await db.getDocument(DATABASE_ID, "templates", "tiktok-profile");
  } catch {
    await db.createDocument(DATABASE_ID, "templates", "tiktok-profile", {
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
            description: "اسم المستخدم بدون @"
          }
        },
        required: ["username"]
      }),
      priceCreditsPerUnit: 1,
      maxRows: 1,
      enabled: true
    });
    console.log("  + Seeded template: tiktok-profile");
  }

  try {
    await db.getDocument(DATABASE_ID, "templates_private", "tiktok-profile");
  } catch {
    await db.createDocument(DATABASE_ID, "templates_private", "tiktok-profile", {
      slug: "tiktok-profile",
      tregEndpointId: "tikhub.tiktok.user.profile",
      tregMethod: "GET",
      pricingUnit: "call",
      estimatedCostUsd: 0.001,
      maxCostUsd: 0.01
    });
    console.log("  + Seeded templates_private: tiktok-profile");
  }

  console.log("\n✅ Database setup complete!");
}

setup().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
