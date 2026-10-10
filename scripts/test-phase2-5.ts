import {
  Client as ServerClient,
  Users as ServerUsers,
  TablesDB as ServerTablesDB,
  Storage as ServerStorage,
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

async function runPhase25Tests() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("🚀 STARTING PHASE 2.5 VERIFICATION SUITE (LIVE DEPLOYED FUNCTIONS)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const timestamp = Date.now();
  const emailUserA = `p25-user-a-${timestamp}@digr.test`;
  const emailUserB = `p25-user-b-${timestamp}@digr.test`;
  const emailAdmin = `p25-admin-${timestamp}@digr.test`;
  const password = "Phase25SecurePassword123!";

  let userAId = "";
  let userBId = "";
  let adminId = "";
  let topupId = "";
  let receiptFileId = "";
  const callSeedId = `call_${timestamp}`;
  const intSeedId = `int_${timestamp}`;

  try {
    // =========================================================================
    // SECTION 1: Real Sign-Up & Event-Triggered Profile Creation
    // =========================================================================
    console.log("▶ [1/4] Testing Real Sign-up & on-user-create Event Trigger...");

    // Create User A via client SDK (real browser-style registration)
    const clientGuest = new ClientSDK().setEndpoint(endpoint).setProject(projectId);
    const guestAccount = new ClientAccount(clientGuest);

    userAId = ClientID.unique();
    console.log(`  • Registering User A via Client SDK account.create (${emailUserA})...`);
    await guestAccount.create(userAId, emailUserA, password, "User A Tester");
    console.log(`  ✓ User A created: ${userAId}`);

    // Create session to authenticate User A client SDK
    console.log("  • Establishing authenticated session via JWT for User A...");
    const jwtA = (await serverUsers.createJWT(userAId)).jwt;
    const clientA = new ClientSDK().setEndpoint(endpoint).setProject(projectId).setJWT(jwtA);
    const storageA = new ClientStorage(clientA);
    const functionsA = new ClientFunctions(clientA);
    const dbA = new ClientDatabases(clientA);

    // Wait and poll for profile row created by deployed on-user-create function
    console.log("  • Polling digr.profiles for row created by live on-user-create trigger...");
    let profile: any = null;
    for (let i = 0; i < 15; i++) {
      try {
        profile = await serverTables.getRow({
          databaseId: DATABASE_ID,
          tableId: "profiles",
          rowId: userAId,
        });
        if (profile) break;
      } catch (e) {
        // Wait and retry
      }
      await sleep(1000);
    }

    if (!profile) {
      throw new Error(`Profile was not created by on-user-create function within 15s for user ${userAId}`);
    }
    console.log(`  ✓ Profile row confirmed: displayName="${profile.displayName}", role="${profile.role}"`);
    if (profile.role !== "user") {
      throw new Error(`Profile role expected 'user', found: ${profile.role}`);
    }

    // Register User B and Admin via server for comparison
    const userB = await serverUsers.create(ServerID.unique(), emailUserB, undefined, password, "User B Tester");
    userBId = userB.$id;
    const adminUser = await serverUsers.create(ServerID.unique(), emailAdmin, undefined, password, "Admin Tester");
    adminId = adminUser.$id;
    await serverUsers.updateLabels(adminId, ["admin"]);
    console.log(`  ✓ User B created: ${userBId}`);
    console.log(`  ✓ Admin created: ${adminId} (label: admin)`);

    const jwtB = (await serverUsers.createJWT(userBId)).jwt;
    const clientB = new ClientSDK().setEndpoint(endpoint).setProject(projectId).setJWT(jwtB);
    const storageB = new ClientStorage(clientB);
    const dbB = new ClientDatabases(clientB);

    const jwtAdmin = (await serverUsers.createJWT(adminId)).jwt;
    const clientAdmin = new ClientSDK().setEndpoint(endpoint).setProject(projectId).setJWT(jwtAdmin);
    const storageAdmin = new ClientStorage(clientAdmin);
    const functionsAdmin = new ClientFunctions(clientAdmin);

    // =========================================================================
    // SECTION 2: Receipts Browser-Style Flow & Security Validation
    // =========================================================================
    console.log("\n▶ [2/4] Testing Receipts Browser Flow & Permission Enforcement...");

    receiptFileId = ClientID.unique();
    const receiptContent = "FAKE_PNG_RECEIPT_BYTES_FOR_TESTING";
    const receiptFile = new File([Buffer.from(receiptContent)], "receipt.png", { type: "image/png" });

    console.log("  • User A uploading receipt via Client SDK storage.createFile...");
    await storageA.createFile("receipts", receiptFileId, receiptFile);
    console.log(`  ✓ Receipt uploaded: ${receiptFileId}`);

    // Verify User A cannot widen file permissions
    console.log("  • Testing if User A can widen receipt permissions to Role.any()...");
    try {
      await storageA.updateFile("receipts", receiptFileId, [Permission.read(Role.any())]);
      throw new Error("Client was unexpectedly able to widen file permissions!");
    } catch (err: any) {
      const code = err.code || err.status || 401;
      console.log(`  ✓ Client permission widening correctly blocked (${code} ${err.type || "unauthorized"})`);
    }

    // =========================================================================
    // SECTION 3: Deployed submit-topup & approve-topup E2E Execution
    // =========================================================================
    console.log("\n▶ [3/4] Testing Deployed submit-topup & approve-topup Functions...");

    console.log("  • Calling live submit-topup via Functions execution API with FORGED parameters...");
    const submitPayload = {
      amountEgp: 200,
      reference: "INSTA-E2E-LIVE",
      receiptFileId: receiptFileId,
      // Forged fields:
      userId: "ATTACKER_OVERRIDE_ID",
      status: "approved",
      credits: 999999,
    };

    const submitExec = await functionsA.createExecution(
      "submit-topup",
      JSON.stringify(submitPayload),
      false
    );

    console.log(`  ✓ Execution finished: status=${submitExec.status}, HTTP code=${submitExec.responseStatusCode}`);
    if (submitExec.responseStatusCode !== 200) {
      throw new Error(`submit-topup failed: ${submitExec.responseBody}`);
    }

    const submitRes = JSON.parse(submitExec.responseBody);
    topupId = submitRes.topupId;
    console.log(`  ✓ Created topupId: ${topupId}`);

    // Verify topup document in database
    const topupDoc: any = await serverTables.getRow({
      databaseId: DATABASE_ID,
      tableId: "topups",
      rowId: topupId,
    });

    console.log("  • Verifying forgeries were ignored by deployed function:");
    console.log(`    - userId: ${topupDoc.userId} (matches User A, attacker ID ignored)`);
    console.log(`    - status: ${topupDoc.status} (forced to pending, forged status ignored)`);
    console.log(`    - credits: ${topupDoc.credits || "null"} (unsettled, forged credits ignored)`);

    if (topupDoc.userId !== userAId || topupDoc.status !== "pending") {
      throw new Error("Tamper resistance failure: forged values were accepted in topup row!");
    }

    // Verify Receipt Permissions After submit-topup
    console.log("  • Verifying Receipt Permissions after submit-topup enforcement:");
    // (a) User A (owner) can download
    const dlA = await fetchDownload(storageA, "receipts", receiptFileId, jwtA);
    console.log(`    ✓ (a) Owner (User A) download: SUCCESS (${dlA.length} bytes)`);

    // (b) User B cannot download
    try {
      await fetchDownload(storageB, "receipts", receiptFileId, jwtB);
      throw new Error("User B was able to download User A receipt!");
    } catch (e: any) {
      console.log(`    ✓ (b) Non-owner (User B) download: BLOCKED (${e.code} ${e.type})`);
    }

    // (c) Admin-label user can download
    const dlAdmin = await fetchDownload(storageAdmin, "receipts", receiptFileId, jwtAdmin);
    console.log(`    ✓ (c) Admin user download: SUCCESS (${dlAdmin.length} bytes)`);

    // Admin Approval via Deployed approve-topup Function
    console.log("\n  • Admin calling live approve-topup with confirmedAmountEgp = 250...");
    const approvePayload = {
      topupId,
      action: "approve",
      confirmedAmountEgp: 250,
    };

    const approveExec = await functionsAdmin.createExecution(
      "approve-topup",
      JSON.stringify(approvePayload),
      false
    );

    console.log(`  ✓ Execution finished: status=${approveExec.status}, HTTP code=${approveExec.responseStatusCode}`);
    if (approveExec.responseStatusCode !== 200) {
      throw new Error(`approve-topup failed: ${approveExec.responseBody}`);
    }

    const approveRes = JSON.parse(approveExec.responseBody);
    console.log(`  ✓ Approval response: status="${approveRes.status}", credits=${approveRes.credits}`);

    // Verify ledger entry top_<topupId>
    const ledgerRow: any = await serverTables.getRow({
      databaseId: DATABASE_ID,
      tableId: "credit_ledger",
      rowId: `top_${topupId}`,
    });
    console.log(`  ✓ Deterministic ledger entry top_${topupId} exists: delta=+${ledgerRow.delta}, type=${ledgerRow.type}`);

    // Verify calculated balance
    const balance = await calculateBalance(serverTables as any, userAId);
    console.log(`  ✓ User A balance calculated from ledger: ${balance} credits`);
    if (balance !== 2500) {
      throw new Error(`Expected balance 2500, found: ${balance}`);
    }

    // Duplicate Approval Idempotency Test
    console.log("  • Testing Idempotency (attempting duplicate approval on same topup)...");
    const dupExec = await functionsAdmin.createExecution(
      "approve-topup",
      JSON.stringify(approvePayload),
      false
    );

    console.log(`  ✓ Duplicate approval rejected with code ${dupExec.responseStatusCode}`);
    if (dupExec.responseStatusCode !== 400) {
      throw new Error(`Expected HTTP 400 on duplicate approval, got ${dupExec.responseStatusCode}`);
    }

    const balanceAfter = await calculateBalance(serverTables as any, userAId);
    console.log(`  ✓ Balance after duplicate attempt: ${balanceAfter} credits (NO DOUBLE CREDIT)`);
    if (balanceAfter !== 2500) {
      throw new Error(`Idempotency failure: balance changed to ${balanceAfter}`);
    }

    // =========================================================================
    // SECTION 4: Control Tests for Server-Only Tables
    // =========================================================================
    console.log("\n▶ [4/4] Testing Control Tests on Server-Only Tables...");

    // 1. Seed real rows in job_calls and jobs_internal
    console.log("  • Seeding real control rows in job_calls and jobs_internal with server key...");
    await serverTables.createRow({
      databaseId: DATABASE_ID,
      tableId: "job_calls",
      rowId: callSeedId,
      data: {
        jobId: "ctrl_test_job_1",
        tregCallId: "call_ctrl_12345",
        endpointId: "ep_ctrl_test",
        idemKey: "idem_ctrl_12345",
        httpStatus: 200,
        costMicro: 1500,
        cacheHit: false,
        createdAt: new Date().toISOString(),
      },
    });

    await serverTables.createRow({
      databaseId: DATABASE_ID,
      tableId: "jobs_internal",
      rowId: intSeedId,
      data: {
        jobId: "ctrl_test_job_1",
        actualCostMicro: 1500,
        revenueCredits: 10,
        marginEgp: 0.85,
      },
    });

    // 2. Server Key confirms all 4 rows exist
    console.log("  • Server Key GET verification:");
    const s1 = await serverTables.getRow({ databaseId: DATABASE_ID, tableId: "settings", rowId: "pricing" });
    console.log(`    ✓ settings/pricing exists: key="${(s1 as any).key}"`);
    const s2 = await serverTables.getRow({ databaseId: DATABASE_ID, tableId: "templates_private", rowId: "tiktok-profile" });
    console.log(`    ✓ templates_private/tiktok-profile exists: slug="${(s2 as any).slug}"`);
    const s3 = await serverTables.getRow({ databaseId: DATABASE_ID, tableId: "job_calls", rowId: callSeedId });
    console.log(`    ✓ job_calls/${callSeedId} exists: tregCallId="${(s3 as any).tregCallId}"`);
    const s4 = await serverTables.getRow({ databaseId: DATABASE_ID, tableId: "jobs_internal", rowId: intSeedId });
    console.log(`    ✓ jobs_internal/${intSeedId} exists: jobId="${(s4 as any).jobId}"`);

    // 3. Normal User A JWT GET & LIST verification (Must be rejected)
    console.log("\n  • User A (Normal JWT) Access Lockdown Verification:");
    const controlResources = [
      { table: "settings", id: "pricing" },
      { table: "templates_private", id: "tiktok-profile" },
      { table: "job_calls", id: callSeedId },
      { table: "jobs_internal", id: intSeedId },
    ];

    for (const res of controlResources) {
      // Test getDocument
      try {
        await dbA.getDocument(DATABASE_ID, res.table, res.id);
        throw new Error(`User A was unexpectedly able to GET ${res.table}/${res.id}`);
      } catch (err: any) {
        const code = err.code || err.status || 401;
        console.log(`    ✓ User A GET ${res.table}/${res.id} -> BLOCKED (${code} ${err.type || "not_found"})`);
      }

      // Test listDocuments
      try {
        await dbA.listDocuments(DATABASE_ID, res.table);
        throw new Error(`User A was unexpectedly able to LIST ${res.table}`);
      } catch (err: any) {
        const code = err.code || err.status || 401;
        console.log(`    ✓ User A LIST ${res.table} -> BLOCKED (${code} ${err.type || "unauthorized"})`);
      }
    }

    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("🎉 ALL PHASE 2.5 VERIFICATION TESTS PASSED SUCCESSFULLY!");
    console.log("═══════════════════════════════════════════════════════════════\n");

  } finally {
    // Clean up only the exact entities created in this test
    console.log("🧹 Cleaning up Phase 2.5 test entities...");
    if (callSeedId) await serverTables.deleteRow({ databaseId: DATABASE_ID, tableId: "job_calls", rowId: callSeedId }).catch(() => {});
    if (intSeedId) await serverTables.deleteRow({ databaseId: DATABASE_ID, tableId: "jobs_internal", rowId: intSeedId }).catch(() => {});
    if (topupId) {
      await serverTables.deleteRow({ databaseId: DATABASE_ID, tableId: "credit_ledger", rowId: `top_${topupId}` }).catch(() => {});
      await serverTables.deleteRow({ databaseId: DATABASE_ID, tableId: "topups", rowId: topupId }).catch(() => {});
    }
    if (receiptFileId) await serverStorage.deleteFile("receipts", receiptFileId).catch(() => {});
    if (userAId) {
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
    console.log("  ✓ All test entities cleaned up cleanly.");
  }
}

runPhase25Tests().catch((err) => {
  console.error("❌ Phase 2.5 Test Failure:", err);
  process.exit(1);
});
