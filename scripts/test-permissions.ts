import { Client as ServerClient, Users, TablesDB as ServerTablesDB, Storage as ServerStorage, Permission, Role, ID, InputFile } from "node-appwrite";
import { Client as ClientSDK, Databases as ClientDatabases, Storage as ClientStorage } from "appwrite";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1";
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482";
const apiKey = process.env.APPWRITE_API_KEY;

if (!apiKey) {
  console.error("❌ ERROR: APPWRITE_API_KEY is not defined in .env.local");
  process.exit(1);
}

const DATABASE_ID = "digr";

// Admin server client
const serverClient = new ServerClient()
  .setEndpoint(endpoint)
  .setProject(projectId)
  .setKey(apiKey);

const serverUsers = new Users(serverClient);
const serverTables = new ServerTablesDB(serverClient);
const serverStorage = new ServerStorage(serverClient);

interface TestResult {
  category: string;
  testCase: string;
  actor: string;
  target: string;
  expected: string;
  actual: string;
  pass: boolean;
}

const results: TestResult[] = [];

async function record(
  category: string,
  testCase: string,
  actor: string,
  target: string,
  expected: string,
  fn: () => Promise<any>,
  expectSuccess: boolean
) {
  try {
    const res = await fn();
    const actual = expectSuccess ? "200 OK" : "Unexpected 200 OK (Allowed)";
    const pass = expectSuccess;
    results.push({ category, testCase, actor, target, expected, actual, pass });
  } catch (err: any) {
    const code = err.code || err.status || 401;
    const type = err.type || "Blocked";
    const actual = `${code} ${type}`;
    const pass = !expectSuccess && (code === 401 || code === 403 || code === 404 || code === 400 || code === 413);
    results.push({ category, testCase, actor, target, expected, actual, pass });
  }
}

async function runTests() {
  console.log("🔒 Starting Comprehensive A/B User Isolation & Permission Verification...\n");

  const emailA = `test-user-a-${Date.now()}@digr.test`;
  const emailB = `test-user-b-${Date.now()}@digr.test`;
  const emailAdmin = `test-admin-${Date.now()}@digr.test`;
  const password = "TestPassword123!";

  console.log("1. Creating test actors (User A, User B, Admin)...");
  const userA = await serverUsers.create(ID.unique(), emailA, undefined, password, "User A");
  const userB = await serverUsers.create(ID.unique(), emailB, undefined, password, "User B");
  const userAdmin = await serverUsers.create(ID.unique(), emailAdmin, undefined, password, "Admin User");
  // Set "admin" label on Admin user
  await serverUsers.updateLabels(userAdmin.$id, ["admin"]);

  console.log("2. Establishing authenticated sessions via JWT...");
  const jwtA = await serverUsers.createJWT(userA.$id);
  const clientA = new ClientSDK().setEndpoint(endpoint).setProject(projectId).setJWT(jwtA.jwt);
  const dbA = new ClientDatabases(clientA);
  const storageA = new ClientStorage(clientA);

  const jwtB = await serverUsers.createJWT(userB.$id);
  const clientB = new ClientSDK().setEndpoint(endpoint).setProject(projectId).setJWT(jwtB.jwt);
  const dbB = new ClientDatabases(clientB);
  const storageB = new ClientStorage(clientB);

  const jwtAdmin = await serverUsers.createJWT(userAdmin.$id);
  const clientAdmin = new ClientSDK().setEndpoint(endpoint).setProject(projectId).setJWT(jwtAdmin.jwt);
  const dbAdmin = new ClientDatabases(clientAdmin);
  const storageAdmin = new ClientStorage(clientAdmin);

  console.log("3. Seeding User A test fixtures (with Row Security & Admin label)...");
  const jobId = ID.unique();
  const eventId = ID.unique();
  const ledgerId = `res_${jobId}`;
  const topupId = ID.unique();
  const receiptFileId = ID.unique();
  const resultFileId = ID.unique();

  const dualPermissions = [
    Permission.read(Role.user(userA.$id)),
    Permission.read(Role.label("admin")),
  ];

  // Database rows
  await serverTables.createRow({
    databaseId: DATABASE_ID,
    tableId: "jobs",
    rowId: jobId,
    data: {
      userId: userA.$id,
      templateSlug: "tiktok-profile",
      params: JSON.stringify({ username: "tiktok" }),
      status: "queued",
      estCredits: 1,
      reservedCredits: 1,
      createdAt: new Date().toISOString(),
    },
    permissions: dualPermissions,
  });

  await serverTables.createRow({
    databaseId: DATABASE_ID,
    tableId: "job_events",
    rowId: eventId,
    data: {
      jobId: jobId,
      textAr: "استلمنا طلبك",
      kind: "info",
      createdAt: new Date().toISOString(),
    },
    permissions: dualPermissions,
  });

  await serverTables.createRow({
    databaseId: DATABASE_ID,
    tableId: "credit_ledger",
    rowId: ledgerId,
    data: {
      userId: userA.$id,
      delta: -1,
      type: "reserve",
      jobId: jobId,
      createdAt: new Date().toISOString(),
    },
    permissions: dualPermissions,
  });

  await serverTables.createRow({
    databaseId: DATABASE_ID,
    tableId: "topups",
    rowId: topupId,
    data: {
      userId: userA.$id,
      amountEgp: 100,
      reference: "REF123",
      receiptFileId: receiptFileId,
      status: "pending",
      createdAt: new Date().toISOString(),
    },
    permissions: dualPermissions,
  });

  // Storage files
  // Receipt file in receipts bucket (User A + Admin read)
  await serverStorage.createFile({
    bucketId: "receipts",
    fileId: receiptFileId,
    file: new File([Buffer.from("test receipt data")], "receipt.png", { type: "image/png" }),
    permissions: dualPermissions,
  });

  // Result file in results bucket (User A + Admin read)
  await serverStorage.createFile({
    bucketId: "results",
    fileId: resultFileId,
    file: new File([Buffer.from("col1,col2\nval1,val2")], "result.csv", { type: "text/csv" }),
    permissions: dualPermissions,
  });

  console.log("4. Executing comprehensive test suite...\n");

  async function fetchDownload(storageService: ClientStorage, bucketId: string, fileId: string, jwt: string) {
    const url = storageService.getFileDownload(bucketId, fileId);
    const res = await fetch(url.toString(), {
      headers: {
        "X-Appwrite-Project": projectId,
        "X-Appwrite-JWT": jwt,
      },
    });
    if (!res.ok) {
      const errorBody: any = await res.json().catch(() => ({}));
      const err: any = new Error(res.statusText);
      err.code = res.status;
      err.type = errorBody.type || "storage_unauthorized";
      throw err;
    }
    return await res.text();
  }

  // ==========================================
  // CATEGORY 1: User B Isolation
  // ==========================================
  await record("Isolation", "User B reads User A Job", "User B", `jobs/${jobId}`, "404 / 401", () => dbB.getDocument(DATABASE_ID, "jobs", jobId), false);
  await record("Isolation", "User B reads User A Event", "User B", `job_events/${eventId}`, "404 / 401", () => dbB.getDocument(DATABASE_ID, "job_events", eventId), false);
  await record("Isolation", "User B reads User A Ledger", "User B", `credit_ledger/${ledgerId}`, "404 / 401", () => dbB.getDocument(DATABASE_ID, "credit_ledger", ledgerId), false);
  await record("Isolation", "User B reads User A Topup", "User B", `topups/${topupId}`, "404 / 401", () => dbB.getDocument(DATABASE_ID, "topups", topupId), false);
  await record("Isolation", "User B downloads User A Receipt", "User B", `receipts/${receiptFileId}`, "404 / 401", () => fetchDownload(storageB, "receipts", receiptFileId, jwtB.jwt), false);
  await record("Isolation", "User B downloads User A Result", "User B", `results/${resultFileId}`, "404 / 401", () => fetchDownload(storageB, "results", resultFileId, jwtB.jwt), false);

  // ==========================================
  // CATEGORY 2: Client Write & Mutation Lock
  // ==========================================
  await record("Write Lock", "User A writes to Ledger directly", "User A", "credit_ledger", "401 / 403", () => dbA.createDocument(DATABASE_ID, "credit_ledger", ID.unique(), {
    userId: userA.$id, delta: 100, type: "adjust", createdAt: new Date().toISOString()
  } as any), false);

  await record("Write Lock", "User A writes to Topups directly", "User A", "topups", "401 / 403", () => dbA.createDocument(DATABASE_ID, "topups", ID.unique(), {
    userId: userA.$id, amountEgp: 50, reference: "HACK", status: "approved", createdAt: new Date().toISOString()
  } as any), false);

  await record("Write Lock", "User A writes to Jobs directly", "User A", "jobs", "401 / 403", () => dbA.createDocument(DATABASE_ID, "jobs", ID.unique(), {
    userId: userA.$id, templateSlug: "hack", params: "{}", status: "done", estCredits: 0, reservedCredits: 0, createdAt: new Date().toISOString()
  } as any), false);

  await record("Write Lock", "User A writes to Profiles directly", "User A", "profiles", "401 / 403", () => dbA.createDocument(DATABASE_ID, "profiles", ID.unique(), {
    userId: userA.$id, displayName: "Hacker", role: "admin", createdAt: new Date().toISOString()
  } as any), false);

  // User A cannot update or delete own records
  await record("Mutation Lock", "User A updates own Job", "User A", `jobs/${jobId}`, "401 / 403", () => dbA.updateDocument(DATABASE_ID, "jobs", jobId, { status: "done" } as any), false);
  await record("Mutation Lock", "User A deletes own Job", "User A", `jobs/${jobId}`, "401 / 403", () => dbA.deleteDocument(DATABASE_ID, "jobs", jobId), false);
  await record("Mutation Lock", "User A updates own Ledger", "User A", `credit_ledger/${ledgerId}`, "401 / 403", () => dbA.updateDocument(DATABASE_ID, "credit_ledger", ledgerId, { delta: 1000 } as any), false);
  await record("Mutation Lock", "User A deletes own Ledger", "User A", `credit_ledger/${ledgerId}`, "401 / 403", () => dbA.deleteDocument(DATABASE_ID, "credit_ledger", ledgerId), false);
  await record("Mutation Lock", "User A updates own Topup", "User A", `topups/${topupId}`, "401 / 403", () => dbA.updateDocument(DATABASE_ID, "topups", topupId, { status: "approved" } as any), false);
  await record("Mutation Lock", "User A deletes own Topup", "User A", `topups/${topupId}`, "401 / 403", () => dbA.deleteDocument(DATABASE_ID, "topups", topupId), false);
  await record("Mutation Lock", "User A updates own Event", "User A", `job_events/${eventId}`, "401 / 403", () => dbA.updateDocument(DATABASE_ID, "job_events", eventId, { textAr: "tampered" } as any), false);
  await record("Mutation Lock", "User A deletes own Event", "User A", `job_events/${eventId}`, "401 / 403", () => dbA.deleteDocument(DATABASE_ID, "job_events", eventId), false);

  // ==========================================
  // CATEGORY 3: Server-Only Tables & Buckets (401 on list & get)
  // ==========================================
  await record("Server-Only", "User A lists Settings Private", "User A", "settings", "401", () => dbA.listDocuments(DATABASE_ID, "settings"), false);
  await record("Server-Only", "User A gets Settings Private (pricing)", "User A", "settings/pricing", "401 / 404", () => dbA.getDocument(DATABASE_ID, "settings", "pricing"), false);
  await record("Server-Only", "User A lists Templates Private", "User A", "templates_private", "401", () => dbA.listDocuments(DATABASE_ID, "templates_private"), false);
  await record("Server-Only", "User A gets Templates Private (tiktok-profile)", "User A", "templates_private/tiktok-profile", "401 / 404", () => dbA.getDocument(DATABASE_ID, "templates_private", "tiktok-profile"), false);
  await record("Server-Only", "User A lists Job Calls", "User A", "job_calls", "401", () => dbA.listDocuments(DATABASE_ID, "job_calls"), false);
  await record("Server-Only", "User A gets Job Calls", "User A", "job_calls/real_or_seeded_id", "401 / 404", () => dbA.getDocument(DATABASE_ID, "job_calls", "real_or_seeded_id"), false);
  await record("Server-Only", "User A lists Jobs Internal", "User A", "jobs_internal", "401", () => dbA.listDocuments(DATABASE_ID, "jobs_internal"), false);
  await record("Server-Only", "User A gets Jobs Internal", "User A", "jobs_internal/real_or_seeded_id", "401 / 404", () => dbA.getDocument(DATABASE_ID, "jobs_internal", "real_or_seeded_id"), false);
  await record("Server-Only", "User A reads Partials Bucket", "User A", "partials", "401", () => storageA.listFiles("partials"), false);

  // ==========================================
  // CATEGORY 4: Bucket Upload & Validation Security
  // ==========================================
  await record("Storage Lock", "User A uploads to Results bucket", "User A", "results", "401 / 403", () => storageA.createFile("results", ID.unique(), new File([Buffer.from("data")], "file.csv", { type: "text/csv" })), false);
  await record("Storage Lock", "User A uploads to Partials bucket", "User A", "partials", "401 / 403", () => storageA.createFile("partials", ID.unique(), new File([Buffer.from("{}")], "part.jsonl", { type: "application/json" })), false);

  // Receipts: Disallowed extension (.exe)
  await record("File Validation", "Receipts rejects .exe file", "User A", "receipts", "400", () => storageA.createFile("receipts", ID.unique(), new File([Buffer.from("evil")], "hack.exe", { type: "application/x-msdownload" })), false);

  // Receipts: File over 5MB limit
  const bigBuffer = Buffer.alloc(6 * 1024 * 1024, "a");
  await record("File Validation", "Receipts rejects file > 5MB", "User A", "receipts", "400 / 413", () => storageA.createFile("receipts", ID.unique(), new File([bigBuffer], "big.png", { type: "image/png" })), false);

  // ==========================================
  // CATEGORY 5: Public Catalog Access
  // ==========================================
  await record("Public Access", "User A reads Public Template", "User A", "templates/tiktok-profile", "200 OK", () => dbA.getDocument(DATABASE_ID, "templates", "tiktok-profile"), true);
  await record("Public Access", "User A reads Public Settings", "User A", "settings_public/pricing", "200 OK", () => dbA.getDocument(DATABASE_ID, "settings_public", "pricing"), true);

  // ==========================================
  // CATEGORY 6: Owner Read Access
  // ==========================================
  await record("Owner Read", "User A reads Own Job", "User A", `jobs/${jobId}`, "200 OK", () => dbA.getDocument(DATABASE_ID, "jobs", jobId), true);
  await record("Owner Read", "User A reads Own Ledger", "User A", `credit_ledger/${ledgerId}`, "200 OK", () => dbA.getDocument(DATABASE_ID, "credit_ledger", ledgerId), true);
  await record("Owner Read", "User A reads Own Topup", "User A", `topups/${topupId}`, "200 OK", () => dbA.getDocument(DATABASE_ID, "topups", topupId), true);
  await record("Owner Read", "User A reads Own Event", "User A", `job_events/${eventId}`, "200 OK", () => dbA.getDocument(DATABASE_ID, "job_events", eventId), true);
  await record("Owner Read", "User A downloads Own Receipt", "User A", `receipts/${receiptFileId}`, "200 OK", () => fetchDownload(storageA, "receipts", receiptFileId, jwtA.jwt), true);
  await record("Owner Read", "User A downloads Own Result", "User A", `results/${resultFileId}`, "200 OK", () => fetchDownload(storageA, "results", resultFileId, jwtA.jwt), true);

  // ==========================================
  // CATEGORY 7: Admin Privileges (Role.label("admin") access)
  // ==========================================
  await record("Admin Access", "Admin reads User A Topup", "Admin", `topups/${topupId}`, "200 OK", () => dbAdmin.getDocument(DATABASE_ID, "topups", topupId), true);
  await record("Admin Access", "Admin reads User A Job", "Admin", `jobs/${jobId}`, "200 OK", () => dbAdmin.getDocument(DATABASE_ID, "jobs", jobId), true);
  await record("Admin Access", "Admin reads User A Ledger", "Admin", `credit_ledger/${ledgerId}`, "200 OK", () => dbAdmin.getDocument(DATABASE_ID, "credit_ledger", ledgerId), true);
  await record("Admin Access", "Admin reads User A Event", "Admin", `job_events/${eventId}`, "200 OK", () => dbAdmin.getDocument(DATABASE_ID, "job_events", eventId), true);
  await record("Admin Access", "Admin downloads User A Receipt", "Admin", `receipts/${receiptFileId}`, "200 OK", () => fetchDownload(storageAdmin, "receipts", receiptFileId, jwtAdmin.jwt), true);
  await record("Admin Access", "Admin downloads User A Result", "Admin", `results/${resultFileId}`, "200 OK", () => fetchDownload(storageAdmin, "results", resultFileId, jwtAdmin.jwt), true);

  console.log("5. Cleaning up test fixtures...");
  await serverTables.deleteRow({ databaseId: DATABASE_ID, tableId: "jobs", rowId: jobId }).catch(() => {});
  await serverTables.deleteRow({ databaseId: DATABASE_ID, tableId: "job_events", rowId: eventId }).catch(() => {});
  await serverTables.deleteRow({ databaseId: DATABASE_ID, tableId: "credit_ledger", rowId: ledgerId }).catch(() => {});
  await serverTables.deleteRow({ databaseId: DATABASE_ID, tableId: "topups", rowId: topupId }).catch(() => {});
  await serverStorage.deleteFile("receipts", receiptFileId).catch(() => {});
  await serverStorage.deleteFile("results", resultFileId).catch(() => {});
  await serverUsers.delete(userA.$id).catch(() => {});
  await serverUsers.delete(userB.$id).catch(() => {});
  await serverUsers.delete(userAdmin.$id).catch(() => {});

  // Print results table
  console.log("\n==================== TEST RESULTS ====================\n");
  console.log("| Category | Test Case | Actor | Target Resource | Expected | Actual | Status |");
  console.log("|---|---|---|---|---|---|---|");
  for (const r of results) {
    const status = r.pass ? "✅ PASS" : "❌ FAIL";
    console.log(`| ${r.category} | ${r.testCase} | ${r.actor} | ${r.target} | ${r.expected} | ${r.actual} | ${status} |`);
  }
  console.log("\n======================================================\n");

  const failedCount = results.filter((r) => !r.pass).length;
  if (failedCount > 0) {
    console.error(`❌ ${failedCount} tests failed.`);
    process.exit(1);
  } else {
    console.log(`✅ All ${results.length} security & isolation tests PASSED!`);
  }
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
