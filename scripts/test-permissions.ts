import { Client as ServerClient, Users, Databases as ServerDatabases, Storage as ServerStorage, Permission, Role, ID } from "node-appwrite";
import { Client as ClientSDK, Account, Databases as ClientDatabases, Storage as ClientStorage } from "appwrite";
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

// Admin client
const serverClient = new ServerClient()
  .setEndpoint(endpoint)
  .setProject(projectId)
  .setKey(apiKey);

const serverUsers = new Users(serverClient);
const serverDb = new ServerDatabases(serverClient);
const serverStorage = new ServerStorage(serverClient);

interface TestResult {
  testCase: string;
  actor: string;
  target: string;
  expected: string;
  actual: string;
  pass: boolean;
}

const results: TestResult[] = [];

async function record(testCase: string, actor: string, target: string, expected: string, fn: () => Promise<any>, expectSuccess: boolean) {
  try {
    const res = await fn();
    const actual = expectSuccess ? "200 OK" : "Unexpected 200 OK (Allowed)";
    const pass = expectSuccess;
    results.push({ testCase, actor, target, expected, actual, pass });
  } catch (err: any) {
    const code = err.code || err.status || 401;
    const actual = `${code} ${err.type || "Blocked"}`;
    const pass = !expectSuccess && (code === 401 || code === 403 || code === 404);
    results.push({ testCase, actor, target, expected, actual, pass });
  }
}

async function runTests() {
  console.log("🔒 Starting A/B User Isolation & Permission Verification...\n");

  const emailA = `test-user-a-${Date.now()}@digr.test`;
  const emailB = `test-user-b-${Date.now()}@digr.test`;
  const password = "TestPassword123!";

  console.log("1. Creating test users...");
  const userA = await serverUsers.create(ID.unique(), emailA, undefined, password, "User A");
  const userB = await serverUsers.create(ID.unique(), emailB, undefined, password, "User B");

  // Create client sessions
  console.log("2. Establishing user sessions...");
  const clientA = new ClientSDK().setEndpoint(endpoint).setProject(projectId);
  const accountA = new Account(clientA);
  await accountA.createEmailPasswordSession(emailA, password);
  const dbA = new ClientDatabases(clientA);
  const storageA = new ClientStorage(clientA);

  const clientB = new ClientSDK().setEndpoint(endpoint).setProject(projectId);
  const accountB = new Account(clientB);
  await accountB.createEmailPasswordSession(emailB, password);
  const dbB = new ClientDatabases(clientB);
  const storageB = new ClientStorage(clientB);

  console.log("3. Seeding User A test documents (with Document Security)...");
  const jobId = ID.unique();
  const eventId = ID.unique();
  const ledgerId = `res_${jobId}`;
  const topupId = ID.unique();

  // Create User A docs with userA read permission
  await serverDb.createDocument(DATABASE_ID, "jobs", jobId, {
    userId: userA.$id,
    templateSlug: "tiktok-profile",
    params: JSON.stringify({ username: "tiktok" }),
    status: "queued",
    estCredits: 1,
    reservedCredits: 1,
    createdAt: new Date().toISOString()
  }, [Permission.read(Role.user(userA.$id))]);

  await serverDb.createDocument(DATABASE_ID, "job_events", eventId, {
    jobId: jobId,
    textAr: "استلمنا طلبك",
    kind: "info",
    createdAt: new Date().toISOString()
  }, [Permission.read(Role.user(userA.$id))]);

  await serverDb.createDocument(DATABASE_ID, "credit_ledger", ledgerId, {
    userId: userA.$id,
    delta: -1,
    type: "reserve",
    jobId: jobId,
    createdAt: new Date().toISOString()
  }, [Permission.read(Role.user(userA.$id))]);

  await serverDb.createDocument(DATABASE_ID, "topups", topupId, {
    userId: userA.$id,
    amountEgp: 100,
    reference: "REF123",
    status: "pending",
    createdAt: new Date().toISOString()
  }, [Permission.read(Role.user(userA.$id))]);

  console.log("4. Executing isolation & security test suite...\n");

  // Isolation: User B cannot read User A's private documents
  await record("User B reads User A Job", "User B", `jobs/${jobId}`, "404 / 401", () => dbB.getDocument(DATABASE_ID, "jobs", jobId), false);
  await record("User B reads User A Event", "User B", `job_events/${eventId}`, "404 / 401", () => dbB.getDocument(DATABASE_ID, "job_events", eventId), false);
  await record("User B reads User A Ledger", "User B", `credit_ledger/${ledgerId}`, "404 / 401", () => dbB.getDocument(DATABASE_ID, "credit_ledger", ledgerId), false);
  await record("User B reads User A Topup", "User B", `topups/${topupId}`, "404 / 401", () => dbB.getDocument(DATABASE_ID, "topups", topupId), false);

  // Client Write Lock: User A cannot directly write to restricted collections
  await record("User A writes to Ledger", "User A", "credit_ledger", "401 / 403", () => dbA.createDocument(DATABASE_ID, "credit_ledger", ID.unique(), {
    userId: userA.$id, delta: 100, type: "adjust", createdAt: new Date().toISOString()
  }), false);

  await record("User A writes to Topups directly", "User A", "topups", "401 / 403", () => dbA.createDocument(DATABASE_ID, "topups", ID.unique(), {
    userId: userA.$id, amountEgp: 50, reference: "HACK", status: "approved", createdAt: new Date().toISOString()
  }), false);

  await record("User A writes to Jobs directly", "User A", "jobs", "401 / 403", () => dbA.createDocument(DATABASE_ID, "jobs", ID.unique(), {
    userId: userA.$id, templateSlug: "hack", params: "{}", status: "done", estCredits: 0, reservedCredits: 0, createdAt: new Date().toISOString()
  }), false);

  await record("User A writes to Profiles directly", "User A", "profiles", "401 / 403", () => dbA.createDocument(DATABASE_ID, "profiles", ID.unique(), {
    userId: userA.$id, displayName: "Hacker", role: "admin", createdAt: new Date().toISOString()
  }), false);

  // Server-only Collections: Client cannot read server-only collections
  await record("User A reads Server Settings", "User A", "settings", "401 / 403", () => dbA.getDocument(DATABASE_ID, "settings", "pricing"), false);
  await record("User A reads Templates Private", "User A", "templates_private", "401 / 403", () => dbA.getDocument(DATABASE_ID, "templates_private", "tiktok-profile"), false);
  await record("User A lists Job Calls", "User A", "job_calls", "401 / 403", () => dbA.listDocuments(DATABASE_ID, "job_calls"), false);
  await record("User A lists Jobs Internal", "User A", "jobs_internal", "401 / 403", () => dbA.listDocuments(DATABASE_ID, "jobs_internal"), false);
  await record("User A reads Partials Bucket", "User A", "partials", "401 / 403", () => storageA.listFiles("partials"), false);

  // Public Collections: User A can read public collections
  await record("User A reads Public Templates", "User A", "templates", "200 OK", () => dbA.getDocument(DATABASE_ID, "templates", "tiktok-profile"), true);
  await record("User A reads Public Settings", "User A", "settings_public", "200 OK", () => dbA.getDocument(DATABASE_ID, "settings_public", "pricing"), true);

  // User A can read their own documents
  await record("User A reads Own Job", "User A", `jobs/${jobId}`, "200 OK", () => dbA.getDocument(DATABASE_ID, "jobs", jobId), true);
  await record("User A reads Own Ledger", "User A", `credit_ledger/${ledgerId}`, "200 OK", () => dbA.getDocument(DATABASE_ID, "credit_ledger", ledgerId), true);
  await record("User A reads Own Topup", "User A", `topups/${topupId}`, "200 OK", () => dbA.getDocument(DATABASE_ID, "topups", topupId), true);

  console.log("5. Cleaning up test fixtures...");
  await serverDb.deleteDocument(DATABASE_ID, "jobs", jobId).catch(() => {});
  await serverDb.deleteDocument(DATABASE_ID, "job_events", eventId).catch(() => {});
  await serverDb.deleteDocument(DATABASE_ID, "credit_ledger", ledgerId).catch(() => {});
  await serverDb.deleteDocument(DATABASE_ID, "topups", topupId).catch(() => {});
  await serverUsers.delete(userA.$id).catch(() => {});
  await serverUsers.delete(userB.$id).catch(() => {});

  // Print results table
  console.log("\n==================== TEST RESULTS ====================\n");
  console.log("| Test Case | Actor | Target Resource | Expected | Actual | Status |");
  console.log("|---|---|---|---|---|---|");
  for (const r of results) {
    const status = r.pass ? "✅ PASS" : "❌ FAIL";
    console.log(`| ${r.testCase} | ${r.actor} | ${r.target} | ${r.expected} | ${r.actual} | ${status} |`);
  }
  console.log("\n======================================================\n");

  const failedCount = results.filter((r) => !r.pass).length;
  if (failedCount > 0) {
    console.error(`❌ ${failedCount} tests failed.`);
    process.exit(1);
  } else {
    console.log(`✅ All ${results.length} permission tests PASSED!`);
  }
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
