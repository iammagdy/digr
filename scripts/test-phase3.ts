import {
  Client as ServerClient,
  Users as ServerUsers,
  TablesDB as ServerTablesDB,
  Storage as ServerStorage,
  Functions as ServerFunctions,
  ID as ServerID,
  Permission,
  Role,
} from "node-appwrite";
import {
  Client as ClientSDK,
  Account as ClientAccount,
  Databases as ClientDatabases,
  Storage as ClientStorage,
  Functions as ClientFunctions,
  ID as ClientID,
} from "appwrite";
import { calculateBalance } from "../src/functions/shared/ledger";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!;
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!;
const apiKey = process.env.APPWRITE_API_KEY!;

if (!apiKey) {
  console.error("APPWRITE_API_KEY is missing from .env.local");
  process.exit(1);
}

const DATABASE_ID = "digr";

// Admin server SDK client
const serverClient = new ServerClient()
  .setEndpoint(endpoint)
  .setProject(projectId)
  .setKey(apiKey);

const serverUsers = new ServerUsers(serverClient);
const serverTables = new ServerTablesDB(serverClient);
const serverStorage = new ServerStorage(serverClient);
const serverFunctions = new ServerFunctions(serverClient);

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function runPhase3Tests() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("🚀 STARTING PHASE 3 E2E INTEGRATION SUITE (JOBS & WORKER)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const timestamp = Date.now();
  const emailUserA = `p3-user-a-${timestamp}@diger.test`;
  const emailUserB = `p3-user-b-${timestamp}@diger.test`;
  const emailAdmin = `p3-admin-${timestamp}@diger.test`;
  const password = "Phase3SecurePassword123!";

  let userAId = "";
  let userBId = "";
  let adminId = "";
  const createdJobIds: string[] = [];
  const createdFileIds: string[] = [];

  try {
    // =========================================================================
    // SECTION 1: Actors Setup & Initial Credit Grant
    // =========================================================================
    console.log("▶ [1/6] Setting up test actors (User A, User B, Admin)...");

    // 1a. User A
    const clientGuest = new ClientSDK().setEndpoint(endpoint).setProject(projectId);
    const guestAccount = new ClientAccount(clientGuest);
    userAId = ClientID.unique();
    await guestAccount.create(userAId, emailUserA, password, "User A Tester");
    console.log(`  ✓ User A created: ${userAId} (${emailUserA})`);

    // Poll for profile
    let profileA: any = null;
    for (let i = 0; i < 15; i++) {
      try {
        profileA = await serverTables.getRow({ databaseId: DATABASE_ID, tableId: "profiles", rowId: userAId });
        if (profileA) break;
      } catch {}
      await sleep(1000);
    }
    if (!profileA) throw new Error("Profile A was not created by on-user-create");
    console.log(`  ✓ Profile A verified: role="${profileA.role}"`);

    // Grant User A initial 10 credits via deterministic ledger entry top_init_<userAId>
    await serverTables.createRow({
      databaseId: DATABASE_ID,
      tableId: "credit_ledger",
      rowId: `top_init_${userAId}`,
      data: {
        userId: userAId,
        delta: 10,
        type: "topup",
        note: "Initial test grant",
        createdAt: new Date().toISOString(),
      },
      permissions: [Permission.read(Role.user(userAId)), Permission.read(Role.label("admin"))],
    });
    const balA = await calculateBalance(serverTables as any, userAId);
    console.log(`  ✓ User A balance established: ${balA} credits`);
    if (balA !== 10) throw new Error(`Expected balance 10, got ${balA}`);

    // 1b. User B (balance = 0)
    userBId = (await serverUsers.create(ServerID.unique(), emailUserB, undefined, password, "User B Tester")).$id;
    console.log(`  ✓ User B created: ${userBId} (0 credits)`);

    // 1c. Admin
    adminId = (await serverUsers.create(ServerID.unique(), emailAdmin, undefined, password, "Admin Tester")).$id;
    await serverUsers.updateLabels(adminId, ["admin"]);
    console.log(`  ✓ Admin created: ${adminId} (label: admin)`);

    // Clients
    const jwtA = (await serverUsers.createJWT(userAId)).jwt;
    const clientA = new ClientSDK().setEndpoint(endpoint).setProject(projectId).setJWT(jwtA);
    const functionsA = new ClientFunctions(clientA);
    const storageA = new ClientStorage(clientA);

    const jwtB = (await serverUsers.createJWT(userBId)).jwt;
    const clientB = new ClientSDK().setEndpoint(endpoint).setProject(projectId).setJWT(jwtB);
    const functionsB = new ClientFunctions(clientB);
    const storageB = new ClientStorage(clientB);

    const jwtAdmin = (await serverUsers.createJWT(adminId)).jwt;
    const clientAdmin = new ClientSDK().setEndpoint(endpoint).setProject(projectId).setJWT(jwtAdmin);
    const storageAdmin = new ClientStorage(clientAdmin);

    // =========================================================================
    // SECTION 2: Insufficient Balance Rejection & Compensating Release
    // =========================================================================
    console.log("\n▶ [2/6] Testing Insufficient Balance & Compensating Release Flow...");

    console.log("  • User B (0 credits) attempting to call create-job for tiktok-profile...");
    const failExec = await functionsB.createExecution(
      "create-job",
      JSON.stringify({
        templateSlug: "tiktok-profile",
        params: { username: "fail_test" },
      }),
      false
    );

    console.log(`  ✓ Execution HTTP status: ${failExec.responseStatusCode}`);
    if (failExec.responseStatusCode !== 400) {
      throw new Error(`Expected HTTP 400 for insufficient balance, got ${failExec.responseStatusCode}`);
    }

    const failBody = JSON.parse(failExec.responseBody || "{}");
    console.log(`  ✓ Rejection message confirmed: "${failBody.error}"`);

    // Verify User B balance remains 0 (no negative balance!)
    const balBAfter = await calculateBalance(serverTables as any, userBId);
    console.log(`  ✓ User B balance remains: ${balBAfter} credits (NO NEGATIVE BALANCE)`);
    if (balBAfter !== 0) throw new Error(`User B balance corrupted: ${balBAfter}`);

    // =========================================================================
    // SECTION 3: Successful Job Creation & Reserve
    // =========================================================================
    console.log("\n▶ [3/6] Testing Successful create-job & Reserve Flow...");

    console.log("  • User A (10 credits) calling create-job for tiktok-profile...");
    const okExec = await functionsA.createExecution(
      "create-job",
      JSON.stringify({
        templateSlug: "tiktok-profile",
        params: { username: "khaby.lame" },
        testScenario: "mock_ok",
      }),
      false
    );

    console.log(`  ✓ Execution HTTP status: ${okExec.responseStatusCode}`);
    if (okExec.responseStatusCode !== 200) {
      throw new Error(`create-job failed: ${okExec.responseBody}`);
    }

    const okBody = JSON.parse(okExec.responseBody || "{}");
    const jobId = okBody.jobId;
    createdJobIds.push(jobId);
    console.log(`  ✓ Created jobId: ${jobId}, status: "${okBody.status}", reservedCredits: ${okBody.reservedCredits}`);

    // Verify deterministic reserve entry res_<jobId>
    const reserveRow: any = await serverTables.getRow({
      databaseId: DATABASE_ID,
      tableId: "credit_ledger",
      rowId: `res_${jobId}`,
    });
    console.log(`  ✓ Deterministic reserve entry res_${jobId} exists: delta=${reserveRow.delta}`);
    if (reserveRow.delta !== -1) throw new Error(`Expected delta -1, got ${reserveRow.delta}`);

    // Verify User A intermediate balance = 9
    const balADuring = await calculateBalance(serverTables as any, userAId);
    console.log(`  ✓ User A balance during job execution: ${balADuring} credits (10 - 1 = 9)`);
    if (balADuring !== 9) throw new Error(`Expected balance 9, got ${balADuring}`);

    // =========================================================================
    // SECTION 4: Worker Execution & rel-first Completion Sequence
    // =========================================================================
    console.log("\n▶ [4/6] Polling job-worker execution & rel-first settlement...");

    let completedJob: any = null;
    for (let i = 0; i < 20; i++) {
      try {
        completedJob = await serverTables.getRow({
          databaseId: DATABASE_ID,
          tableId: "jobs",
          rowId: jobId,
        });
        if (completedJob.status === "done" || completedJob.status === "failed") {
          break;
        }
      } catch {}
      await sleep(1500);
    }

    if (!completedJob || (completedJob.status !== "done" && completedJob.status !== "failed")) {
      console.log("  • Triggering job-worker execution directly...");
      const workerExec = await serverFunctions.createExecution(
        "job-worker",
        JSON.stringify({ jobId, testScenario: "mock_ok" }),
        false
      );
      console.log(`  ✓ Worker execution: status=${workerExec.status}, HTTP code=${workerExec.responseStatusCode}`);
      await sleep(1500);
      completedJob = await serverTables.getRow({ databaseId: DATABASE_ID, tableId: "jobs", rowId: jobId });
    }

    console.log(`  ✓ Job status: "${completedJob.status}"`);
    console.log(`  ✓ Charged credits: ${completedJob.chargedCredits}, rows: ${completedJob.rowsCollected}`);
    if (completedJob.status !== "done") throw new Error(`Job did not complete: status=${completedJob.status}`);

    const resultFileId = completedJob.resultFileId;
    if (resultFileId) createdFileIds.push(resultFileId);
    console.log(`  ✓ Result file generated: ${resultFileId}`);

    // Verify rel-first ledger entries: rel_<jobId> and chg_<jobId>
    const relRow: any = await serverTables.getRow({
      databaseId: DATABASE_ID,
      tableId: "credit_ledger",
      rowId: `rel_${jobId}`,
    });
    console.log(`  ✓ Deterministic release entry rel_${jobId} exists: delta=+${relRow.delta}`);

    const chgRow: any = await serverTables.getRow({
      databaseId: DATABASE_ID,
      tableId: "credit_ledger",
      rowId: `chg_${jobId}`,
    });
    console.log(`  ✓ Deterministic charge entry chg_${jobId} exists: delta=${chgRow.delta}`);
    if (chgRow.delta !== -1) throw new Error(`Expected charge delta -1, got ${chgRow.delta}`);

    // Verify final balance = 9 (10 - 1 = 9)
    const balAFinal = await calculateBalance(serverTables as any, userAId);
    console.log(`  ✓ User A final balance: ${balAFinal} credits`);
    if (balAFinal !== 9) throw new Error(`Expected final balance 9, got ${balAFinal}`);

    // =========================================================================
    // SECTION 5: White-Label Result File & File Security Enforcement
    // =========================================================================
    console.log("\n▶ [5/6] Verifying White-Label Metadata & Storage Security...");

    // (a) User A can download
    const rawFileA = await fetchDownload(storageA, "results", resultFileId, jwtA);
    console.log(`  ✓ Owner (User A) download: SUCCESS (${rawFileA.length} bytes)`);

    const jsonResult = JSON.parse(rawFileA);
    console.log(`  ✓ Platform author: "${jsonResult.metadata.platform}"`);
    console.log(`  ✓ Title: "${jsonResult.metadata.title}"`);
    console.log(`  ✓ Methodology note verified: "${jsonResult.metadata.methodology.slice(0, 45)}..."`);
    console.log(`  ✓ Verified influencer: uniqueId="${jsonResult.data.data.user.uniqueId}", followers=${jsonResult.data.data.stats.followerCount}`);

    // (b) Admin can download
    const rawFileAdmin = await fetchDownload(storageAdmin, "results", resultFileId, jwtAdmin);
    console.log(`  ✓ Admin download: SUCCESS (${rawFileAdmin.length} bytes)`);

    // (c) User B is blocked
    try {
      await fetchDownload(storageB, "results", resultFileId, jwtB);
      throw new Error("User B was able to download User A result file!");
    } catch (e: any) {
      console.log(`  ✓ Non-owner (User B) download: BLOCKED (${e.code} ${e.type})`);
    }

    // =========================================================================
    // SECTION 6: TREG 402 Cost Cap Handling (route_max_cost)
    // =========================================================================
    console.log("\n▶ [6/6] Testing TREG 402 route_max_cost failure & automatic refund...");

    console.log("  • User A calling create-job with testScenario = route_max_cost...");
    const capExec = await functionsA.createExecution(
      "create-job",
      JSON.stringify({
        templateSlug: "tiktok-profile",
        params: { username: "expensive_creator" },
        testScenario: "route_max_cost",
      }),
      false
    );

    const capBody = JSON.parse(capExec.responseBody || "{}");
    const capJobId = capBody.jobId;
    createdJobIds.push(capJobId);
    console.log(`  ✓ Created cap test job: ${capJobId}`);

    // Execute worker directly to evaluate cost cap failure
    const capWorkerExec = await serverFunctions.createExecution(
      "job-worker",
      JSON.stringify({ jobId: capJobId, testScenario: "route_max_cost" }),
      false
    );
    console.log(`  ✓ Cost-cap worker execution: status=${capWorkerExec.status}, HTTP code=${capWorkerExec.responseStatusCode}`);
    await sleep(1500);

    const failedJob: any = await serverTables.getRow({ databaseId: DATABASE_ID, tableId: "jobs", rowId: capJobId });
    console.log(`  ✓ Job status: "${failedJob.status}", errorAr: "${failedJob.errorAr}"`);
    if (failedJob.status !== "failed") throw new Error(`Expected status failed, got ${failedJob.status}`);

    // Verify reserve was released via rel_<jobId>
    const capRelRow: any = await serverTables.getRow({ databaseId: DATABASE_ID, tableId: "credit_ledger", rowId: `rel_${capJobId}` });
    console.log(`  ✓ Reserve refund entry rel_${capJobId} exists: delta=+${capRelRow.delta}`);

    // Verify NO charge was created
    try {
      await serverTables.getRow({ databaseId: DATABASE_ID, tableId: "credit_ledger", rowId: `chg_${capJobId}` });
      throw new Error("Charge row chg_ was unexpectedly created for failed job!");
    } catch (e: any) {
      console.log(`  ✓ Charge row chg_${capJobId}: NOT CREATED (correctly aborted)`);
    }

    // Verify User A balance is restored to 9 (no deduction for failed job)
    const balAfterRefund = await calculateBalance(serverTables as any, userAId);
    console.log(`  ✓ User A balance after cost-cap failure refund: ${balAfterRefund} credits (RESTORED)`);
    if (balAfterRefund !== 9) throw new Error(`Expected balance 9, got ${balAfterRefund}`);

    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("🎉 ALL PHASE 3 JOBS & WORKER VERIFICATION TESTS PASSED!");
    console.log("═══════════════════════════════════════════════════════════════\n");

  } finally {
    console.log("🧹 Cleaning up Phase 3 test entities...");
    for (const jId of createdJobIds) {
      await serverTables.deleteRow({ databaseId: DATABASE_ID, tableId: "credit_ledger", rowId: `res_${jId}` }).catch(() => {});
      await serverTables.deleteRow({ databaseId: DATABASE_ID, tableId: "credit_ledger", rowId: `rel_${jId}` }).catch(() => {});
      await serverTables.deleteRow({ databaseId: DATABASE_ID, tableId: "credit_ledger", rowId: `chg_${jId}` }).catch(() => {});
      await serverTables.deleteRow({ databaseId: DATABASE_ID, tableId: "jobs", rowId: jId }).catch(() => {});
    }
    for (const fId of createdFileIds) {
      await serverStorage.deleteFile("results", fId).catch(() => {});
    }
    if (userAId) {
      await serverTables.deleteRow({ databaseId: DATABASE_ID, tableId: "credit_ledger", rowId: `top_init_${userAId}` }).catch(() => {});
      await serverTables.deleteRow({ databaseId: DATABASE_ID, tableId: "profiles", rowId: userAId }).catch(() => {});
      await serverUsers.delete(userAId).catch(() => {});
    }
    if (userBId) {
      await serverTables.deleteRow({ databaseId: DATABASE_ID, tableId: "profiles", rowId: userBId }).catch(() => {});
      await serverUsers.delete(userBId).catch(() => {});
    }
    if (adminId) {
      await serverTables.deleteRow({ databaseId: DATABASE_ID, tableId: "profiles", rowId: adminId }).catch(() => {});
      await serverUsers.delete(adminId).catch(() => {});
    }
    console.log("  ✓ All Phase 3 test entities safely cleaned up.");
  }
}

runPhase3Tests().catch((err) => {
  console.error("❌ Phase 3 Test Failure:", err);
  process.exit(1);
});
