import puppeteer from "puppeteer-core";
import * as fs from "fs";
import * as path from "path";
import { Client, Users, ID, TablesDB } from "node-appwrite";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE_URL = "http://localhost:3000";
const ARTIFACT_DIR = "C:\\Users\\lenovo\\.gemini\\antigravity\\brain\\b6f21146-6cdf-4686-bafb-7c54799f4945";

const VIEWPORTS = [
  { name: "375px", width: 375, height: 812, isMobile: true },
  { name: "768px", width: 768, height: 1024, isMobile: false },
  { name: "1280px", width: 1280, height: 850, isMobile: false },
];

async function capture() {
  console.log("📸 Starting Automated Screenshot Capture for Phase B...");

  if (!fs.existsSync(ARTIFACT_DIR)) {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  }

  // 1. Create a designated test user for authenticated screenshot views
  const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || "https://cloud.appwrite.io/v1";
  const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482";
  const apiKey = process.env.APPWRITE_API_KEY!;

  const serverClient = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
  const users = new Users(serverClient);
  const tables = new TablesDB(serverClient);

  const testEmail = `researcher_${Date.now()}@diger.test`;
  const testPassword = `Pass_${Date.now()}!Secret`;
  let testUserId = "";

  try {
    const userDoc = await users.create(ID.unique(), testEmail, undefined, testPassword, "د. أحمد الباحث");
    testUserId = userDoc.$id;
    console.log(`✓ Created test user: ${testEmail}`);

    // Create profile with onboardingCompleted: true
    await tables.createRow({
      databaseId: "digr",
      tableId: "profiles",
      rowId: testUserId,
      data: {
        userId: testUserId,
        displayName: "د. أحمد الباحث",
        role: "user",
        persona: "researcher",
        purposes: JSON.stringify(["نشر علمي في مجلة محكمة"]),
        topic: "علم الاجتماع الرقمي",
        onboardingCompleted: true,
        createdAt: new Date().toISOString(),
      },
    });

    // Seed 100 points in ledger so balance is visible
    await tables.createRow({
      databaseId: "digr",
      tableId: "credit_ledger",
      rowId: `seed_${testUserId}`,
      data: {
        userId: testUserId,
        type: "topup",
        delta: 100,
        createdAt: new Date().toISOString(),
      },
    });
  } catch (err: any) {
    console.warn("Could not setup user profile:", err.message);
  }

  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=ar"],
  });

  try {
    const page = await browser.newPage();

    // Log in on desktop
    if (testUserId) {
      console.log("🔑 Logging in test user...");
      await page.setViewport({ width: 1280, height: 850 });
      await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle0" });
      await page.type("#email", testEmail);
      await page.type("#password", testPassword);
      await Promise.all([
        page.click('button[type="submit"]'),
        page.waitForNavigation({ waitUntil: "networkidle0", timeout: 15000 }).catch(() => {}),
      ]);
      console.log("✓ Logged in successfully.");
    }

    // Capture each viewport
    for (const vp of VIEWPORTS) {
      console.log(`\n--- Capturing Viewport: ${vp.name} (${vp.width}x${vp.height}) ---`);
      await page.setViewport({
        width: vp.width,
        height: vp.height,
        isMobile: vp.isMobile,
        hasTouch: vp.isMobile,
      });

      // 1. First screen with greeting and chips
      await page.goto(`${BASE_URL}/dashboard/chat`, { waitUntil: "networkidle0" });
      await new Promise((r) => setTimeout(r, 1000));
      const firstScreenPath = path.join(ARTIFACT_DIR, `phase_b_chat_first_${vp.name}.png`);
      await page.screenshot({ path: firstScreenPath });
      console.log(`✓ Saved ${firstScreenPath}`);

      // Capture Onboarding Modal
      if (vp.name === "1280px" || vp.name === "375px") {
        const personaBtn = await page.$('button::-p-text("⚙️")');
        if (personaBtn) {
          await personaBtn.click();
          await new Promise((r) => setTimeout(r, 600));
          const onboardingPath = path.join(ARTIFACT_DIR, `phase_b_onboarding_${vp.name}.png`);
          await page.screenshot({ path: onboardingPath });
          console.log(`✓ Saved ${onboardingPath}`);
          const skipBtn = await page.$('button::-p-text("تخطي الآن")');
          if (skipBtn) await skipBtn.click();
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      // 2. Populate conversation with a request to show plan card & discovery card
      const textarea = await page.$('textarea[placeholder*="اكتب طلبك"]');
      if (textarea) {
        await textarea.type("أريد بيانات ملف حساب @khaby.lame على تيك توك وإحصائياته العامة");
        await page.keyboard.press("Enter");
        // Wait for assistant response to appear
        await new Promise((r) => setTimeout(r, 3500));
      }

      const chatPlanPath = path.join(ARTIFACT_DIR, `phase_b_chat_plan_${vp.name}.png`);
      await page.screenshot({ path: chatPlanPath });
      console.log(`✓ Saved ${chatPlanPath}`);

      // 3. Toggle canvas open on desktop or mobile
      const canvasBtn = await page.$('button::-p-text("مساحة النتائج")');
      if (canvasBtn) {
        await canvasBtn.click();
        await new Promise((r) => setTimeout(r, 1000));
      }

      const canvasPath = path.join(ARTIFACT_DIR, `phase_b_chat_canvas_${vp.name}.png`);
      await page.screenshot({ path: canvasPath });
      console.log(`✓ Saved ${canvasPath}`);
    }

    console.log("\n🎉 All Phase B screenshots captured successfully outside public/!");
  } finally {
    await browser.close();
  }
}

capture().catch((err) => {
  console.error("Screenshot capture failed:", err);
  process.exit(1);
});
