import { Client, Users, TablesDB, ID, Query } from "node-appwrite";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1";
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482";
const apiKey = process.env.APPWRITE_API_KEY!;

const client = new Client()
  .setEndpoint(endpoint)
  .setProject(projectId)
  .setKey(apiKey);

const tables = new TablesDB(client);
const users = new Users(client);

async function main() {
  console.log("🚀 Testing ChatHandler End-to-End Flow...\n");

  const email = `chat_test_${Date.now()}@digr.test`;
  const user = await users.create(ID.unique(), email, undefined, "Password123!Secure", "Chat Tester");
  console.log(`Created test user: ${user.email} (${user.$id})`);

  const handler = new ChatHandler(tables);

  try {
    // 1. User with 100 points requests verified TikTok profile
    console.log("\n[Test 1] User with sufficient balance (100 points) requests TikTok profile:");
    const res1 = await handler.handleUserMessage({
      userId: user.$id,
      message: "أريد بيانات ملف حساب تيك توك @tiktok",
      userBalance: 100,
    });

    console.log("  ✓ Conversation ID:", res1.conversationId);
    console.log("  ✓ Output Type:", res1.outputType);
    console.log("  ✓ Content:", res1.contentAr);
    console.log("  ✓ Quoted Points:", res1.planQuote?.quotedPoints);
    console.log("  ✓ Is Affordable:", res1.planQuote?.isAffordable);
    console.log("  ✓ Tokens Used:", res1.tokensUsed);

    if (res1.outputType !== "propose_plan" || !res1.planQuote) {
      throw new Error("Test 1 failed: expected propose_plan with quote");
    }

    // 2. User with 0 points requests same (Affordability check)
    console.log("\n[Test 2] User with zero balance (0 points) requests TikTok profile:");
    const res2 = await handler.handleUserMessage({
      userId: user.$id,
      conversationId: res1.conversationId,
      message: "أريد بيانات ملف حساب تيك توك @tiktok",
      userBalance: 0,
    });

    console.log("  ✓ Output Type:", res2.outputType);
    console.log("  ✓ Content:", res2.contentAr);
    console.log("  ✓ Is Affordable:", res2.planQuote?.isAffordable);

    if (res2.planQuote?.isAffordable !== false) {
      throw new Error("Test 2 failed: expected isAffordable=false for 0 balance");
    }

    // 3. User requests unsupported platform (Instagram) -> capability_requests logged
    console.log("\n[Test 3] User requests unsupported platform (Instagram):");
    const res3 = await handler.handleUserMessage({
      userId: user.$id,
      conversationId: res1.conversationId,
      message: "أريد جمع منشورات حساب تجاري على انستغرام",
      userBalance: 100,
    });

    console.log("  ✓ Output Type:", res3.outputType);
    console.log("  ✓ Content:", res3.contentAr);
    console.log("  ✓ Suggested Alternative:", res3.suggestedAlternative?.unsupportedService);

    // Verify capability_requests table has the record
    const capReqs = await tables.listRows({
      databaseId: "digr",
      tableId: "capability_requests",
      queries: [Query.equal("userId", user.$id)],
    });
    console.log("  ✓ Found capability_requests row in DB:", capReqs.total, "record(s)");
    if (capReqs.total === 0) {
      throw new Error("Test 3 failed: capability_requests was not logged in DB");
    }

    // 4. Verify llm_usage table has usage logged
    const usageRows = await tables.listRows({
      databaseId: "digr",
      tableId: "llm_usage",
      queries: [Query.equal("userId", user.$id)],
    });
    console.log("\n[Test 4] llm_usage records logged:", usageRows.total);
    if (usageRows.total === 0) {
      throw new Error("Test 4 failed: llm_usage was not recorded");
    }

    console.log("\n🎉 All ChatHandler End-to-End tests PASSED!");
  } finally {
    // Cleanup test data
    console.log("\n🧹 Cleaning up test user and rows...");
    const convs = await tables.listRows({ databaseId: "digr", tableId: "conversations", queries: [Query.equal("userId", user.$id)] });
    for (const c of convs.rows) {
      await tables.deleteRow({ databaseId: "digr", tableId: "conversations", rowId: c.$id });
    }
    const msgs = await tables.listRows({ databaseId: "digr", tableId: "messages", queries: [Query.equal("userId", user.$id)] });
    for (const m of msgs.rows) {
      await tables.deleteRow({ databaseId: "digr", tableId: "messages", rowId: m.$id });
    }
    const quotes = await tables.listRows({ databaseId: "digr", tableId: "plans_quotes", queries: [Query.equal("userId", user.$id)] });
    for (const q of quotes.rows) {
      await tables.deleteRow({ databaseId: "digr", tableId: "plans_quotes", rowId: q.$id });
    }
    const reqs = await tables.listRows({ databaseId: "digr", tableId: "capability_requests", queries: [Query.equal("userId", user.$id)] });
    for (const r of reqs.rows) {
      await tables.deleteRow({ databaseId: "digr", tableId: "capability_requests", rowId: r.$id });
    }
    const usgs = await tables.listRows({ databaseId: "digr", tableId: "llm_usage", queries: [Query.equal("userId", user.$id)] });
    for (const u of usgs.rows) {
      await tables.deleteRow({ databaseId: "digr", tableId: "llm_usage", rowId: u.$id });
    }

    await users.delete(user.$id);
    console.log("✓ Cleanup finished.");
  }
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
