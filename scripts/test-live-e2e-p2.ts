import { Client, TablesDB, Storage, Users, ID, Query, Permission, Role } from "node-appwrite";
import { Client as UserClient, Account as UserAccount, Storage as UserStorage } from "appwrite";
import * as dotenv from "dotenv";
import { startFakeTregServer, FakeTregServerInstance } from "./fake-treg-server";
import {
  createAndSaveManagedQuote,
  applyPlanOperations,
  computePlanHash,
  PlanState,
} from "../src/functions/shared/planManager";
import { acceptQuote } from "../src/functions/shared/quoteAccept";
import { executeMultiStepJob } from "../src/functions/shared/multiStepWorker";
import { getEnabledCapabilities } from "../src/functions/shared/capabilityRegistry";
import { applyTopup } from "../src/functions/shared/ledger";

dotenv.config({ path: ".env.local" });

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1";
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482";
const apiKey = process.env.APPWRITE_API_KEY!;

if (!apiKey) {
  console.error("❌ APPWRITE_API_KEY not found in .env.local");
  process.exit(1);
}

// Admin / Server SDK
const serverClient = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
const tables = new TablesDB(serverClient);
const storage = new Storage(serverClient);
const users = new Users(serverClient);

async function runLiveE2eTest() {
  console.log("======================================================================");
  console.log("🚀 STARTING LIVE APPWRITE P2 END-TO-END TEST");
  console.log("🌐 Target Endpoint:", endpoint);
  console.log("📦 Project ID:", projectId);
  console.log("======================================================================\n");

  let fakeTreg: FakeTregServerInstance | null = null;
  let testUserId = "";
  let userSessionToken = "";
  let jobId = "";
  const createdDocIds: { tableId: string; rowId: string }[] = [];
  const createdFileIds: string[] = [];

  const stepResults: { step: string; status: "PASS" | "FAIL"; details: string }[] = [];

  try {
    // Step 1: Start Fake TREG server
    fakeTreg = await startFakeTregServer(4040);
    console.log("1. ✓ Fake TREG server started on", fakeTreg.url);
    stepResults.push({ step: "Fake TREG Server", status: "PASS", details: `Running on port 4040` });

    // Step 2: Create live test user
    const testEmail = `e2e_p2_${Date.now()}@digr.test`;
    const testPassword = `Pass_${Date.now()}!Secret`;
    const userDoc = await users.create(ID.unique(), testEmail, undefined, testPassword, "E2E Test User");
    testUserId = userDoc.$id;
    console.log(`2. ✓ Created live test user: ${testEmail} (${testUserId})`);
    stepResults.push({ step: "User Creation", status: "PASS", details: testEmail });

    // Step 3: Establish authenticated user session / JWT via server SDK
    const jwtObj = await users.createJWT(testUserId);
    userSessionToken = jwtObj.jwt;
    console.log("3. ✓ Authenticated user session JWT generated");
    stepResults.push({ step: "Auth Session & JWT", status: "PASS", details: "Active JWT session" });

    // Step 4: Top up user balance with 100 points
    const topupId = `top_e2e_${Date.now()}`;
    await applyTopup(tables, testUserId, topupId, 100, "Live E2E Initial Balance");
    createdDocIds.push({ tableId: "credit_ledger", rowId: topupId });
    console.log("4. ✓ Seeded 100 points in live credit_ledger");
    stepResults.push({ step: "Credit Top-up", status: "PASS", details: "100 points credited" });

    // Step 5: Create Initial Quote
    const capabilities = await getEnabledCapabilities(tables);
    const initialPlan: PlanState = {
      summaryAr: "استخراج ملف حساب تيك توك",
      items: [
        {
          capabilitySlug: "tiktok-profile",
          params: { username: "tiktok" },
          targetVolumeMin: 1,
          targetVolumeMax: 1,
        },
      ],
      outputFormats: ["xlsx", "pdf", "csv"],
    };

    const conversationId = ID.unique();
    const initialQuote = await createAndSaveManagedQuote(tables, {
      conversationId,
      userId: testUserId,
      plan: initialPlan,
      userBalance: 100,
      capabilities,
    });
    createdDocIds.push({ tableId: "plans_quotes", rowId: initialQuote.quoteId });
    console.log(`5. ✓ Created initial quote ${initialQuote.quoteId} (${initialQuote.quotedPoints} points)`);
    stepResults.push({ step: "Quote Creation", status: "PASS", details: `Quote ID: ${initialQuote.quoteId}` });

    // Step 6: Perform Plan Edit (e.g. changing username to 'khaby.lame')
    const editOperations = [
      {
        action: "set_param" as const,
        capabilitySlug: "tiktok-profile",
        key: "username",
        value: "khaby.lame",
      },
    ];

    const editedPlan = applyPlanOperations(initialPlan, editOperations);
    const editedQuote = await createAndSaveManagedQuote(tables, {
      conversationId,
      userId: testUserId,
      plan: editedPlan,
      userBalance: 100,
      capabilities,
    });
    createdDocIds.push({ tableId: "plans_quotes", rowId: editedQuote.quoteId });
    console.log(`6. ✓ Applied plan edit. New quote: ${editedQuote.quoteId}, planHash: ${editedQuote.planHash.slice(0, 12)}...`);
    stepResults.push({ step: "Plan Edit & Re-quote", status: "PASS", details: `New Hash: ${editedQuote.planHash.slice(0, 8)}` });

    // Step 7: Accept Quote (reserve credits on live database)
    const acceptRes = await acceptQuote(tables, {
      userId: testUserId,
      quoteId: editedQuote.quoteId,
      expectedPlanHash: editedQuote.planHash,
    });

    if (!acceptRes.success || !acceptRes.jobId) {
      throw new Error(`acceptQuote failed: ${acceptRes.errorAr}`);
    }

    jobId = acceptRes.jobId;
    createdDocIds.push({ tableId: "jobs", rowId: jobId });
    createdDocIds.push({ tableId: "credit_ledger", rowId: `res_${jobId}` });
    console.log(`7. ✓ Quote accepted. Live job created: ${jobId}, reserved: ${acceptRes.reservedCredits} pts`);
    stepResults.push({ step: "Quote Accept & Reserve", status: "PASS", details: `Job ID: ${jobId}` });

    // Step 8: Execute MultiStepWorker against Fake TREG Server
    console.log("8. Executing multiStepWorker against Fake TREG server...");
    const fakeFetcher = async (cursor: string | null, page: number) => {
      const res = await fetch(`${fakeTreg!.url}/api/v1/tiktok/profile?username=khaby.lame`, {
        headers: {
          "X-Treg-Token": "mock_token_live_test",
        },
      });
      const data = await res.json();
      return {
        ok: res.ok,
        httpStatus: res.status,
        items: [data],
        nextCursor: null,
        costMicro: Number(res.headers.get("X-Treg-Cost-Micro") || 70),
      };
    };

    const workerResult = await executeMultiStepJob(tables, storage, {
      jobId,
      targetVolumeMax: 1,
      unitPricePoints: editedQuote.unitPricePoints,
      reservedCredits: acceptRes.reservedCredits || editedQuote.quotedPoints,
      userId: testUserId,
      templateSlug: "tiktok-profile",
      params: { username: "khaby.lame" },
      fetchPageFn: fakeFetcher,
    });

    createdDocIds.push({ tableId: "credit_ledger", rowId: `rel_${jobId}` });
    createdDocIds.push({ tableId: "credit_ledger", rowId: `chg_${jobId}` });

    if (!workerResult.success) {
      throw new Error(`Worker execution failed: ${workerResult.errorAr}`);
    }

    console.log(`   ✓ Worker completed. Status: ${workerResult.status}, Charged: ${workerResult.chargedCredits} pts`);
    stepResults.push({ step: "Worker Execution", status: "PASS", details: `Delivered: ${workerResult.deliveredUnits} rows` });

    // Record created file IDs
    const xlsxFileId = `xlsx_${jobId}`;
    const pdfFileId = `pdf_${jobId}`;
    const csvFileId = `csv_${jobId}`;
    createdFileIds.push(xlsxFileId, pdfFileId, csvFileId);

    // Step 9: Verify Real Progress Events written to live DB
    const eventsRes = await tables.listRows({
      databaseId: "digr",
      tableId: "job_events",
      queries: [Query.equal("jobId", jobId)],
    });
    console.log(`9. ✓ Verified ${eventsRes.rows.length} progress events recorded in live job_events`);
    for (const ev of eventsRes.rows as any[]) {
      createdDocIds.push({ tableId: "job_events", rowId: ev.$id });
    }
    stepResults.push({ step: "Job Events Stream", status: "PASS", details: `${eventsRes.rows.length} events logged` });

    // Step 10: Authenticated File Downloads using user JWT
    console.log("10. Testing authenticated file downloads via user session JWT...");
    const formats: Array<"xlsx" | "pdf" | "csv"> = ["xlsx", "pdf", "csv"];
    const downloadedSizes: Record<string, number> = {};

    for (const fmt of formats) {
      const fileId = `${fmt}_${jobId}`;
      const downloadUrl = `${endpoint}/storage/buckets/results/files/${fileId}/download`;

      const dlRes = await fetch(downloadUrl, {
        headers: {
          "X-Appwrite-Project": projectId,
          "X-Appwrite-JWT": userSessionToken,
        },
      });

      if (!dlRes.ok) {
        throw new Error(`Download failed for ${fmt} file (HTTP ${dlRes.status})`);
      }

      const fileBuf = await dlRes.arrayBuffer();
      downloadedSizes[fmt] = fileBuf.byteLength;
      if (fileBuf.byteLength === 0) {
        throw new Error(`Downloaded ${fmt} file is empty!`);
      }
      console.log(`   ✓ Downloaded ${fmt.toUpperCase()} (${fileBuf.byteLength} bytes) successfully!`);
    }

    stepResults.push({
      step: "File Downloads (Excel, PDF, CSV)",
      status: "PASS",
      details: `XLSX: ${downloadedSizes.xlsx}B, PDF: ${downloadedSizes.pdf}B, CSV: ${downloadedSizes.csv}B`,
    });

  } catch (err: any) {
    console.error("❌ E2E Test Failure:", err.message);
    stepResults.push({ step: "Execution Error", status: "FAIL", details: err.message });
  } finally {
    // Step 11: Cleanup all test artifacts from Live Appwrite
    console.log("\n11. Cleaning up test artifacts from live Appwrite Cloud...");

    // Delete storage files
    for (const fid of createdFileIds) {
      try {
        await storage.deleteFile("results", fid);
      } catch {}
    }

    // Delete database rows
    for (const doc of createdDocIds) {
      try {
        await tables.deleteRow({ databaseId: "digr", tableId: doc.tableId, rowId: doc.rowId });
      } catch {}
    }

    // Delete test user
    if (testUserId) {
      try {
        await users.delete(testUserId);
      } catch {}
    }

    // Stop fake server
    if (fakeTreg) {
      await fakeTreg.close();
    }
    console.log("   ✓ Cleaned up test user, database rows, storage files, and stopped fake server.");
  }

  // Print Summary Table
  console.log("\n======================================================================");
  console.log("📋 LIVE APPWRITE P2 END-TO-END TEST RESULTS TABLE");
  console.log("======================================================================");
  console.log("| # | الخطوة الاختبارية | الحالة | التفاصيل والملاحظات |");
  console.log("|---|---|---|---|");
  stepResults.forEach((r, idx) => {
    console.log(`| ${idx + 1} | ${r.step} | ${r.status === "PASS" ? "✅ PASS" : "❌ FAIL"} | ${r.details} |`);
  });
  console.log("======================================================================\n");
}

runLiveE2eTest().catch(console.error);
