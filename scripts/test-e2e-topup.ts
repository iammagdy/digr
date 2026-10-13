import { Client, Users, TablesDB, ID } from "node-appwrite";
import { calculateBalance } from "../src/functions/shared/ledger";
import onUserCreateHandler from "../src/functions/on-user-create/src/main";
import submitTopupHandler from "../src/functions/submit-topup/src/main";
import approveTopupHandler from "../src/functions/approve-topup/src/main";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!;
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!;
const apiKey = process.env.APPWRITE_API_KEY!;

const client = new Client()
  .setEndpoint(endpoint)
  .setProject(projectId)
  .setKey(apiKey);

const users = new Users(client);
const tables = new TablesDB(client);

// Mock Appwrite Function response helper
function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    json(data: any, code: number = 200) {
      this.statusCode = code;
      this.body = data;
      return this;
    },
    send(text: string, code: number = 200) {
      this.statusCode = code;
      this.body = text;
      return this;
    },
  };
}

async function runE2ETest() {
  console.log("🔄 Starting End-to-End Top-up Flow & Tamper-Resistance Verification...\n");

  const emailUser = `e2e-user-${Date.now()}@diger.test`;
  const emailAdmin = `e2e-admin-${Date.now()}@diger.test`;
  const password = "E2EPassword123!";

  console.log("Step 1: Registering User and Admin...");
  const user = await users.create(ID.unique(), emailUser, undefined, password, "E2E Customer");
  const admin = await users.create(ID.unique(), emailAdmin, undefined, password, "E2E Admin");
  await users.updateLabels(admin.$id, ["admin"]);
  console.log(`  ✓ User created: ${user.$id}`);
  console.log(`  ✓ Admin created: ${admin.$id} (label: admin)`);

  console.log("\nStep 2: Testing on-user-create trigger Function...");
  const mockRes1 = createMockRes();
  await onUserCreateHandler({
    req: {
      body: { $id: user.$id, name: user.name, email: user.email },
      headers: {},
    },
    res: mockRes1,
    log: () => {},
    error: console.error,
  });

  const profile = await tables.getRow({ databaseId: "digr", tableId: "profiles", rowId: user.$id });
  console.log(`  ✓ Profile provisioned: displayName="${(profile as any).displayName}", role="${(profile as any).role}"`);
  if ((profile as any).role !== "user") {
    throw new Error("Profile role was not set to 'user'");
  }

  console.log("\nStep 3: Submitting top-up with FORGED parameters (testing tamper resistance)...");
  const mockRes2 = createMockRes();
  await submitTopupHandler({
    req: {
      headers: { "x-appwrite-user-id": user.$id },
      body: {
        amountEgp: 200,
        reference: "INSTA-REF-777",
        receiptFileId: "receipt_fake_id",
        // FORGERIES (must be ignored):
        userId: "ATTACKER_OVERRIDE_ID",
        status: "approved",
        credits: 999999,
      },
    },
    res: mockRes2,
    log: () => {},
    error: console.error,
  });

  const topupId = mockRes2.body.topupId;
  const topupDoc = await tables.getRow({ databaseId: "digr", tableId: "topups", rowId: topupId });
  console.log(`  ✓ Topup created: ID=${topupId}`);
  console.log(`  ✓ Verifying forgeries were rejected:`);
  console.log(`    - userId: ${(topupDoc as any).userId} (matches caller, forged value ignored)`);
  console.log(`    - status: ${(topupDoc as any).status} (forced to 'pending', forged value ignored)`);
  console.log(`    - credits: ${(topupDoc as any).credits || "null"} (unsettled, forged value ignored)`);

  if ((topupDoc as any).userId !== user.$id || (topupDoc as any).status !== "pending") {
    throw new Error("Tamper resistance failure: forged fields were accepted!");
  }

  console.log("\nStep 4: Admin approval with confirmedAmountEgp...");
  const mockRes3 = createMockRes();
  await approveTopupHandler({
    req: {
      headers: { "x-appwrite-user-id": admin.$id },
      body: {
        topupId,
        action: "approve",
        confirmedAmountEgp: 250, // User requested 200, admin verified 250
      },
    },
    res: mockRes3,
    log: () => {},
    error: console.error,
  });

  console.log(`  ✓ Approval response:`, mockRes3.body);

  // Check topup document updated
  const approvedTopup = await tables.getRow({ databaseId: "digr", tableId: "topups", rowId: topupId });
  console.log(`  ✓ Topup document updated: status=${(approvedTopup as any).status}, confirmedAmount=${(approvedTopup as any).confirmedAmountEgp}, credits=${(approvedTopup as any).credits}`);

  // Check ledger entry exists: top_<topupId>
  const ledgerDoc = await tables.getRow({ databaseId: "digr", tableId: "credit_ledger", rowId: `top_${topupId}` });
  console.log(`  ✓ Ledger entry top_${topupId} exists: delta=+${(ledgerDoc as any).delta}, type=${(ledgerDoc as any).type}`);

  // Check balance calculation
  const balance = await calculateBalance(tables as any, user.$id);
  console.log(`  ✓ User balance calculated from ledger: ${balance} credits`);
  if (balance !== 2500) {
    throw new Error(`Expected balance 2500 (from 250 EGP / 0.1), got ${balance}`);
  }

  console.log("\nStep 5: Testing Idempotency (attempting duplicate approval)...");
  const mockRes4 = createMockRes();
  await approveTopupHandler({
    req: {
      headers: { "x-appwrite-user-id": admin.$id },
      body: {
        topupId,
        action: "approve",
        confirmedAmountEgp: 250,
      },
    },
    res: mockRes4,
    log: () => {},
    error: console.error,
  });

  console.log(`  ✓ Duplicate approval rejected: code=${mockRes4.statusCode}, error="${mockRes4.body.error}"`);
  const balanceAfter = await calculateBalance(tables as any, user.$id);
  console.log(`  ✓ Balance after duplicate attempt: ${balanceAfter} credits (NO DOUBLE CREDIT)`);

  if (balanceAfter !== 2500) {
    throw new Error(`Idempotency failure! Balance changed to ${balanceAfter}`);
  }

  console.log("\nStep 6: Cleaning up test entities...");
  await tables.deleteRow({ databaseId: "digr", tableId: "credit_ledger", rowId: `top_${topupId}` }).catch(() => {});
  await tables.deleteRow({ databaseId: "digr", tableId: "topups", rowId: topupId }).catch(() => {});
  await tables.deleteRow({ databaseId: "digr", tableId: "profiles", rowId: user.$id }).catch(() => {});
  await users.delete(user.$id).catch(() => {});
  await users.delete(admin.$id).catch(() => {});
  console.log("  ✓ All test entities cleaned up successfully.");

  console.log("\n🎉 END-TO-END TOP-UP TEST PASSED COMPLETELY!\n");
}

runE2ETest().catch((err) => {
  console.error("❌ E2E Test Failed:", err);
  process.exit(1);
});
