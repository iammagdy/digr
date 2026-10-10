import { Client as ServerClient, Users, TablesDB as ServerTablesDB, Permission, Role, ID } from "node-appwrite";
import { Client as ClientSDK, Databases as ClientDatabases } from "appwrite";
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
    const pass = !expectSuccess && (code === 401 || code === 403 || code === 404 || code === 400);
    results.push({ category, testCase, actor, target, expected, actual, pass });
  }
}

async function getOrCreateTestUser(emailPrefix: string, labels: string[] = []) {
  const email = `${emailPrefix}_p1_${Date.now()}@digr.test`;
  const password = "Password123!Secure";
  const user = await serverUsers.create(ID.unique(), email, undefined, password, emailPrefix);
  if (labels.length > 0) {
    await serverUsers.updateLabels(user.$id, labels);
  }

  // Create session for client SDK
  const session = await serverUsers.createSession(user.$id, (await serverUsers.createToken(user.$id)).secret);

  const client = new ClientSDK()
    .setEndpoint(endpoint)
    .setProject(projectId)
    .setSession(session.secret);

  const databases = new ClientDatabases(client);

  return { user, session, databases, client };
}

async function run() {
  console.log("🔐 Starting P1 Permission Isolation Test Suite...\n");

  const userA = await getOrCreateTestUser("user_a");
  const userB = await getOrCreateTestUser("user_b");
  const adminUser = await getOrCreateTestUser("admin_user", ["admin"]);

  console.log(`Created test actors:`);
  console.log(`  User A: ${userA.user.email} (${userA.user.$id})`);
  console.log(`  User B: ${userB.user.email} (${userB.user.$id})`);
  console.log(`  Admin:  ${adminUser.user.email} (${adminUser.user.$id}) with label 'admin'\n`);

  // Setup: Seed User A's conversation, message, plan quote, note
  const now = new Date().toISOString();
  const convId = ID.unique();
  const msgId = ID.unique();
  const quoteId = ID.unique();
  const noteId = ID.unique();

  const userPerms = [
    Permission.read(Role.user(userA.user.$id)),
    Permission.update(Role.user(userA.user.$id)),
    Permission.delete(Role.user(userA.user.$id)),
    Permission.read(Role.label("admin")),
  ];

  await serverTables.createRow({
    databaseId: DATABASE_ID,
    tableId: "conversations",
    rowId: convId,
    data: {
      userId: userA.user.$id,
      title: "محادثة اختبارية للمستخدم أ",
      status: "active",
      totalTokens: 500,
      costUsd: 0.0001,
      createdAt: now,
      updatedAt: now,
    },
    permissions: userPerms,
  });

  await serverTables.createRow({
    databaseId: DATABASE_ID,
    tableId: "messages",
    rowId: msgId,
    data: {
      conversationId: convId,
      userId: userA.user.$id,
      role: "user",
      content: "طلب استخراج تجريبي",
      status: "ready",
      createdAt: now,
    },
    permissions: userPerms,
  });

  await serverTables.createRow({
    databaseId: DATABASE_ID,
    tableId: "plans_quotes",
    rowId: quoteId,
    data: {
      conversationId: convId,
      userId: userA.user.$id,
      status: "proposed",
      summaryAr: "خطة تجريبية",
      itemsJson: JSON.stringify([{ capabilitySlug: "tiktok-profile", params: {} }]),
      targetVolumeMax: 1,
      unitPricePoints: 1.0,
      quotedPoints: 1,
      settingsVersion: "v1.0",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      createdAt: now,
    },
    permissions: [
      Permission.read(Role.user(userA.user.$id)),
      Permission.read(Role.label("admin")),
    ],
  });

  await serverTables.createRow({
    databaseId: DATABASE_ID,
    tableId: "notes",
    rowId: noteId,
    data: {
      conversationId: convId,
      userId: userA.user.$id,
      contentMarkdown: "# ملاحظات الطلب للمستخدم أ",
      updatedAt: now,
    },
    permissions: userPerms,
  });

  console.log("✓ Seeded User A test entities. Testing access control rules...\n");

  // Category 1: User A accessing own entities
  await record(
    "Tier 2: User A Own Access",
    "User A reads own conversation",
    "User A",
    `conversations/${convId}`,
    "200 OK",
    () => userA.databases.getDocument(DATABASE_ID, "conversations", convId),
    true
  );

  await record(
    "Tier 2: User A Own Access",
    "User A reads own message",
    "User A",
    `messages/${msgId}`,
    "200 OK",
    () => userA.databases.getDocument(DATABASE_ID, "messages", msgId),
    true
  );

  await record(
    "Tier 2: User A Own Access",
    "User A reads own plan quote",
    "User A",
    `plans_quotes/${quoteId}`,
    "200 OK",
    () => userA.databases.getDocument(DATABASE_ID, "plans_quotes", quoteId),
    true
  );

  await record(
    "Tier 2: User A Own Access",
    "User A reads own notes",
    "User A",
    `notes/${noteId}`,
    "200 OK",
    () => userA.databases.getDocument(DATABASE_ID, "notes", noteId),
    true
  );

  // Category 2: User B Cross-User Isolation (Must fail 404/401)
  await record(
    "Tier 2: Cross-User Isolation",
    "User B tries to read User A conversation",
    "User B",
    `conversations/${convId}`,
    "404 Not Found",
    () => userB.databases.getDocument(DATABASE_ID, "conversations", convId),
    false
  );

  await record(
    "Tier 2: Cross-User Isolation",
    "User B tries to read User A message",
    "User B",
    `messages/${msgId}`,
    "404 Not Found",
    () => userB.databases.getDocument(DATABASE_ID, "messages", msgId),
    false
  );

  await record(
    "Tier 2: Cross-User Isolation",
    "User B tries to read User A quote",
    "User B",
    `plans_quotes/${quoteId}`,
    "404 Not Found",
    () => userB.databases.getDocument(DATABASE_ID, "plans_quotes", quoteId),
    false
  );

  await record(
    "Tier 2: Cross-User Isolation",
    "User B tries to read User A notes",
    "User B",
    `notes/${noteId}`,
    "404 Not Found",
    () => userB.databases.getDocument(DATABASE_ID, "notes", noteId),
    false
  );

  await record(
    "Tier 2: Cross-User Isolation",
    "User B tries to update User A conversation",
    "User B",
    `conversations/${convId}`,
    "404 Not Found",
    () => userB.databases.updateDocument(DATABASE_ID, "conversations", convId, { title: "Hacked" }),
    false
  );

  // Category 3: Tier 3 Server-Only Isolation
  await record(
    "Tier 3: Server-Only Tables",
    "User A tries to read capability_registry",
    "User A",
    "capability_registry",
    "401 / 404 Blocked",
    () => userA.databases.listDocuments(DATABASE_ID, "capability_registry"),
    false
  );

  await record(
    "Tier 3: Server-Only Tables",
    "User A tries to read llm_usage",
    "User A",
    "llm_usage",
    "401 / 404 Blocked",
    () => userA.databases.listDocuments(DATABASE_ID, "llm_usage"),
    false
  );

  await record(
    "Tier 3: Server-Only Tables",
    "User A tries to create row in capability_registry",
    "User A",
    "capability_registry",
    "401 / 404 Blocked",
    () => userA.databases.createDocument(DATABASE_ID, "capability_registry", ID.unique(), { slug: "fake" }),
    false
  );

  // Category 4: Admin Access to User Entities
  await record(
    "Admin Role Access",
    "Admin user reads User A conversation",
    "Admin",
    `conversations/${convId}`,
    "200 OK",
    () => adminUser.databases.getDocument(DATABASE_ID, "conversations", convId),
    true
  );

  await record(
    "Admin Role Access",
    "Admin user reads User A quote",
    "Admin",
    `plans_quotes/${quoteId}`,
    "200 OK",
    () => adminUser.databases.getDocument(DATABASE_ID, "plans_quotes", quoteId),
    true
  );

  // Cleanup: Delete test documents and users
  console.log("\n🧹 Cleaning up test users and rows...");
  try {
    await serverTables.deleteRow({ databaseId: DATABASE_ID, tableId: "conversations", rowId: convId });
    await serverTables.deleteRow({ databaseId: DATABASE_ID, tableId: "messages", rowId: msgId });
    await serverTables.deleteRow({ databaseId: DATABASE_ID, tableId: "plans_quotes", rowId: quoteId });
    await serverTables.deleteRow({ databaseId: DATABASE_ID, tableId: "notes", rowId: noteId });

    await serverUsers.delete(userA.user.$id);
    await serverUsers.delete(userB.user.$id);
    await serverUsers.delete(adminUser.user.$id);
    console.log("✓ Cleanup finished cleanly.\n");
  } catch (cleanErr: any) {
    console.warn("Cleanup warning:", cleanErr.message);
  }

  // Print results table
  console.log("==========================================================================================");
  console.log("🎯 P1 PERMISSION ISOLATION TEST RESULTS TABLE");
  console.log("==========================================================================================");
  console.table(
    results.map((r) => ({
      Category: r.category,
      TestCase: r.testCase,
      Actor: r.actor,
      Expected: r.expected,
      Actual: r.actual,
      Result: r.pass ? "✅ PASS" : "❌ FAIL",
    }))
  );

  const allPass = results.every((r) => r.pass);
  console.log(`\nSummary: ${results.filter((r) => r.pass).length}/${results.length} tests PASSED.`);
  if (!allPass) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
