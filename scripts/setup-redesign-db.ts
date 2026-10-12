/**
 * V7 redesign database migration. Idempotent: safe to run more than once.
 *   npx tsx scripts/setup-redesign-db.ts
 *
 * - topups: senderName, senderPhone, rejectReason (+ status/created index)
 * - settings_public: ipa, maxPendingTopups
 * - notifications (owner-readable, owner may set readAt)
 * - admin_audit_log (append-only, admin-readable)
 * - provider_costs (server-only)
 */
import { Client, TablesDB } from "node-appwrite";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const client = new Client()
  .setEndpoint(process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1")
  .setProject(process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!)
  .setKey(process.env.APPWRITE_API_KEY!);

const tables = new TablesDB(client);
const DB = "digr";

async function columnKeys(tableId: string): Promise<Set<string>> {
  const t: any = await tables.getTable({ databaseId: DB, tableId });
  return new Set((t.columns || []).map((c: any) => c.key));
}

async function ensureVarchar(tableId: string, key: string, size: number, required = false) {
  if ((await columnKeys(tableId)).has(key)) return console.log(`✓ ${tableId}.${key} exists`);
  await tables.createVarcharColumn({ databaseId: DB, tableId, key, size, required });
  console.log(`+ ${tableId}.${key}`);
}

async function ensureInteger(tableId: string, key: string, required = false, def?: number) {
  if ((await columnKeys(tableId)).has(key)) return console.log(`✓ ${tableId}.${key} exists`);
  await tables.createIntegerColumn({ databaseId: DB, tableId, key, required, ...(def !== undefined ? { default: def } : {}) } as any);
  console.log(`+ ${tableId}.${key}`);
}

async function ensureIndex(tableId: string, key: string, type: "key" | "unique", columns: string[]) {
  try {
    const list: any = await tables.listIndexes({ databaseId: DB, tableId });
    if (list.indexes.some((i: any) => i.key === key)) return console.log(`✓ index ${tableId}.${key} exists`);
    await tables.createIndex({ databaseId: DB, tableId, key, type, columns } as any);
    console.log(`+ index ${tableId}.${key}`);
  } catch (e: any) {
    console.warn(`! index ${tableId}.${key}: ${e.message}`);
  }
}

async function ensureTable(tableId: string, name: string, permissions: string[], rowSecurity: boolean, columns: any[], indexes: Array<{ key: string; type: "key" | "unique"; columns: string[] }>) {
  try {
    await tables.getTable({ databaseId: DB, tableId });
    console.log(`✓ table ${tableId} exists`);
  } catch (e: any) {
    if (e.code !== 404) throw e;
    await tables.createTable({
      databaseId: DB, tableId, name, permissions, rowSecurity,
      columns: columns,
      indexes: indexes.map((i) => ({ key: i.key, type: i.type, attributes: i.columns })),
    } as any);
    console.log(`+ table ${tableId}`);
    return;
  }
  for (const i of indexes) await ensureIndex(tableId, i.key, i.type, i.columns);
}

async function main() {
  // ── topups ──────────────────────────────────────────────
  await ensureVarchar("topups", "senderName", 120);
  await ensureVarchar("topups", "senderPhone", 11);
  await ensureVarchar("topups", "rejectReason", 256);
  // receiptFileId stays optional at the column level so historical rows remain valid;
  // submit-topup enforces it for every new request.
  await ensureIndex("topups", "status_created_idx", "key", ["status", "createdAt"]);

  // ── settings_public ─────────────────────────────────────
  await ensureVarchar("settings_public", "ipa", 128);
  await ensureInteger("settings_public", "maxPendingTopups", false, 3);

  // ── notifications ───────────────────────────────────────
  await ensureTable("notifications", "Notifications", [], true, [
    { key: "userId", type: "varchar", size: 36, required: true },
    { key: "kind", type: "enum", elements: ["topup_approved", "topup_rejected", "job_done", "refund", "welcome"], required: true },
    { key: "title", type: "varchar", size: 160, required: true },
    { key: "body", type: "varchar", size: 512, required: true },
    { key: "link", type: "varchar", size: 256, required: false },
    { key: "readAt", type: "datetime", required: false },
    { key: "createdAt", type: "datetime", required: true },
  ], [
    { key: "user_read_idx", type: "key", columns: ["userId", "readAt"] },
    { key: "user_created_idx", type: "key", columns: ["userId", "createdAt"] },
  ]);

  // ── admin_audit_log: append-only (rows are created by the API key, never updated or deleted) ──
  await ensureTable("admin_audit_log", "Admin audit log", [], true, [
    { key: "actorId", type: "varchar", size: 36, required: true },
    { key: "action", type: "varchar", size: 64, required: true },
    { key: "targetType", type: "varchar", size: 32, required: false },
    { key: "targetId", type: "varchar", size: 64, required: false },
    { key: "meta", type: "varchar", size: 1024, required: false },
    { key: "ip", type: "varchar", size: 64, required: false },
    { key: "createdAt", type: "datetime", required: true },
  ], [
    { key: "created_idx", type: "key", columns: ["createdAt"] },
    { key: "action_idx", type: "key", columns: ["action"] },
  ]);

  // ── provider_costs: server-only (no client permissions) ──
  await ensureTable("provider_costs", "Provider costs", [], false, [
    { key: "jobId", type: "varchar", size: 36, required: false },
    { key: "provider", type: "enum", elements: ["treg", "llm"], required: true },
    { key: "units", type: "double", required: true },
    { key: "costEgp", type: "double", required: true },
    { key: "at", type: "datetime", required: true },
  ], [
    { key: "at_idx", type: "key", columns: ["at"] },
    { key: "job_idx", type: "key", columns: ["jobId"] },
  ]);

  console.log("\nDone. Columns become available a few seconds after creation (Appwrite processes them asynchronously).");
}

main().catch((e) => { console.error("Migration failed:", e); process.exit(1); });
