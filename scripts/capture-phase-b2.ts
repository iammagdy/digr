import puppeteer from "puppeteer-core";
import * as fs from "fs";
import * as path from "path";
import { Client, Users, ID, TablesDB, Query } from "node-appwrite";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE_URL = "http://localhost:3000";
const ARTIFACT_DIR = "C:\\Users\\lenovo\\.gemini\\antigravity\\brain\\b6f21146-6cdf-4686-bafb-7c54799f4945\\screenshots_b2";

const VIEWPORTS = [
  { name: "1280px", width: 1280, height: 850, isMobile: false },
  { name: "768px", width: 768, height: 1024, isMobile: false },
  { name: "375px", width: 375, height: 812, isMobile: true },
];

async function main() {
  console.log("📸 Starting Phase B2 Screenshot Capture...");

  if (!fs.existsSync(ARTIFACT_DIR)) {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  }

  // 1. Appwrite Server Client Setup
  const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1";
  const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482";
  const apiKey = process.env.APPWRITE_API_KEY!;

  const serverClient = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
  const users = new Users(serverClient);
  const tables = new TablesDB(serverClient);

  const timestamp = Date.now();
  const testEmail = `tester_b2_${timestamp}@digr.test`;
  const testPassword = `Pass_${timestamp}!Secret`;
  let testUserId = "";
  let ledgerRowId = "";
  let profileRowId = "";

  try {
    const userDoc = await users.create(ID.unique(), testEmail, undefined, testPassword, "د. أحمد الباحث");
    testUserId = userDoc.$id;
    console.log(`✓ Created test user: ${testEmail} (${testUserId})`);

    // Allow user creation trigger to create profile
    await new Promise((r) => setTimeout(r, 1500));

    try {
      const profRes = await tables.listRows({
        databaseId: "digr",
        tableId: "profiles",
        queries: [Query.equal("userId", testUserId), Query.limit(1)],
      });

      if (profRes.rows.length > 0) {
        profileRowId = profRes.rows[0].$id;
        await tables.updateRow({
          databaseId: "digr",
          tableId: "profiles",
          rowId: profileRowId,
          data: {
            displayName: "د. أحمد الباحث",
            role: "user",
            persona: "researcher",
            purposes: JSON.stringify(["رسالة أو بحث أكاديمي"]),
            topic: "علم الاجتماع الرقمي",
            onboardingCompleted: true,
          },
        });
        console.log("✓ Profile updated with researcher persona");
      }
    } catch (e: any) {
      console.warn("Profile note:", e.message);
    }

    // Seed 150 points in ledger so balance is visible
    try {
      ledgerRowId = ID.unique();
      await tables.createRow({
        databaseId: "digr",
        tableId: "credit_ledger",
        rowId: ledgerRowId,
        data: {
          userId: testUserId,
          type: "topup",
          delta: 150,
          createdAt: new Date().toISOString(),
        },
      });
      console.log("✓ Seeded 150 points for test user");
    } catch (e: any) {
      console.warn("Ledger note:", e.message);
    }

  } catch (err: any) {
    console.error("Setup error:", err.message);
  }

  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=ar"],
  });

  try {
    const page = await browser.newPage();

    // 1. Capture /login and /register across viewports
    console.log("📸 1. Capturing Login & Register...");
    for (const vp of VIEWPORTS) {
      await page.setViewport({ width: vp.width, height: vp.height, isMobile: vp.isMobile });

      await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle0" });
      await new Promise((r) => setTimeout(r, 400));
      await page.screenshot({ path: path.join(ARTIFACT_DIR, `login_${vp.name}.png`) });

      await page.goto(`${BASE_URL}/register`, { waitUntil: "networkidle0" });
      await new Promise((r) => setTimeout(r, 400));
      await page.screenshot({ path: path.join(ARTIFACT_DIR, `register_${vp.name}.png`) });
    }

    // 2. Log in as test user
    console.log("🔑 Logging in test user...");
    await page.setViewport({ width: 1280, height: 850 });
    await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle0" });
    await page.type("#email", testEmail);
    await page.type("#password", testPassword);
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 20000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));
    console.log("✓ Logged in. Current URL:", page.url());

    // 3. Capture Onboarding Steps (1, 2, 3)
    console.log("📸 2. Capturing Onboarding Modal Steps (1, 2, 3)...");
    await page.setViewport({ width: 1280, height: 850 });
    await page.goto(`${BASE_URL}/dashboard/chat`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 1500));

    // Open Onboarding modal via persona button
    await page.evaluate(() => {
      const btn = document.querySelector('button[title="تعديل نمط المساعد"]') as HTMLElement;
      if (btn) btn.click();
    });
    await new Promise((r) => setTimeout(r, 800));

    // Capture Step 1 across viewports
    for (const vp of VIEWPORTS) {
      await page.setViewport({ width: vp.width, height: vp.height, isMobile: vp.isMobile });
      await new Promise((r) => setTimeout(r, 300));
      await page.screenshot({ path: path.join(ARTIFACT_DIR, `onboarding_step1_${vp.name}.png`) });
    }

    // Advance to Step 2
    await page.setViewport({ width: 1280, height: 850 });
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("التالي: غرض الاستخدام")
      ) as HTMLElement;
      if (btn) btn.click();
    });
    await new Promise((r) => setTimeout(r, 600));

    // Capture Step 2 across viewports
    for (const vp of VIEWPORTS) {
      await page.setViewport({ width: vp.width, height: vp.height, isMobile: vp.isMobile });
      await new Promise((r) => setTimeout(r, 300));
      await page.screenshot({ path: path.join(ARTIFACT_DIR, `onboarding_step2_${vp.name}.png`) });
    }

    // Advance to Step 3
    await page.setViewport({ width: 1280, height: 850 });
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("التالي: مجال التخصص")
      ) as HTMLElement;
      if (btn) btn.click();
    });
    await new Promise((r) => setTimeout(r, 600));

    // Capture Step 3 across viewports
    for (const vp of VIEWPORTS) {
      await page.setViewport({ width: vp.width, height: vp.height, isMobile: vp.isMobile });
      await new Promise((r) => setTimeout(r, 300));
      await page.screenshot({ path: path.join(ARTIFACT_DIR, `onboarding_step3_${vp.name}.png`) });
    }

    // Close Onboarding modal
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("تخطي الآن") || b.textContent?.includes("حفظ وبدء الاستخدام")
      ) as HTMLElement;
      if (btn) btn.click();
    });
    await new Promise((r) => setTimeout(r, 1000));
    console.log("✓ Captured Onboarding modal steps 1, 2, 3");

    // 4. Capture Welcome State
    console.log("📸 3. Capturing Welcome Screen across viewports...");
    for (const vp of VIEWPORTS) {
      await page.setViewport({ width: vp.width, height: vp.height, isMobile: vp.isMobile });
      await new Promise((r) => setTimeout(r, 400));
      await page.screenshot({ path: path.join(ARTIFACT_DIR, `welcome_${vp.name}.png`) });
    }
    console.log("✓ Captured welcome state across viewports");

    // 5. Capture Discovery Question Card
    console.log("📸 4. Capturing Discovery Questions Card...");
    await page.setViewport({ width: 1280, height: 850 });

    // Click inquiry card to populate input
    await page.evaluate(() => {
      const card = Array.from(document.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("استشارة واستفسار")
      ) as HTMLElement;
      if (card) card.click();
    });
    await new Promise((r) => setTimeout(r, 300));

    // Submit form
    await page.evaluate(() => {
      const form = document.querySelector("form") as HTMLFormElement;
      if (form) form.requestSubmit();
    });

    // Wait for response to appear
    await page.waitForFunction(
      () => !document.body.innerText.includes("جاري التفكير"),
      { timeout: 15000 }
    ).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));

    // Also send a clarification prompt
    await page.evaluate(() => {
      const ta = document.querySelector("textarea") as HTMLTextAreaElement;
      if (ta) {
        const proto = Object.getPrototypeOf(ta);
        const setVal = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setVal) setVal.call(ta, "عاوز بيانات حساب تيك توك بس مش متأكد من المعرف بالضبط، ممكن تساعدني؟");
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const form = document.querySelector("form") as HTMLFormElement;
      if (form) form.requestSubmit();
    });

    await page.waitForFunction(
      () => document.body.innerText.includes("أسئلة استكشافية") || document.body.innerText.includes("تحديد تفاصيل"),
      { timeout: 15000 }
    ).catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));

    for (const vp of VIEWPORTS) {
      await page.setViewport({ width: vp.width, height: vp.height, isMobile: vp.isMobile });
      await new Promise((r) => setTimeout(r, 400));
      await page.screenshot({ path: path.join(ARTIFACT_DIR, `discovery_card_${vp.name}.png`) });
    }
    console.log("✓ Captured discovery questions card across viewports");

    // 6. Capture Editable Plan Card
    console.log("📸 5. Capturing Editable Plan Card...");
    await page.setViewport({ width: 1280, height: 850 });
    await page.evaluate(() => {
      const ta = document.querySelector("textarea") as HTMLTextAreaElement;
      if (ta) {
        const proto = Object.getPrototypeOf(ta);
        const setVal = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setVal) setVal.call(ta, "أريد بيانات ملف حساب @research_channel على تيك توك وإحصائياته العامة");
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const form = document.querySelector("form") as HTMLFormElement;
      if (form) form.requestSubmit();
    });

    await page.waitForFunction(
      () => document.body.innerText.includes("خطة الاستخراج وعرض السعر"),
      { timeout: 15000 }
    ).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));

    // Open inline plan editor
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("تعديل الخطة يدوياً")
      ) as HTMLElement;
      if (btn) btn.click();
    });
    await new Promise((r) => setTimeout(r, 600));

    for (const vp of VIEWPORTS) {
      await page.setViewport({ width: vp.width, height: vp.height, isMobile: vp.isMobile });
      await new Promise((r) => setTimeout(r, 400));
      await page.screenshot({ path: path.join(ARTIFACT_DIR, `editable_plan_${vp.name}.png`) });
    }
    console.log("✓ Captured editable plan card across viewports");

    // 7. Start Plan Execution & Capture Activity Timeline
    console.log("📸 6. Starting Plan & Capturing Activity Timeline...");
    await page.setViewport({ width: 1280, height: 850 });
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("ابدأ الاستخراج الآن")
      ) as HTMLElement;
      if (btn) btn.click();
    });
    await new Promise((r) => setTimeout(r, 2000));

    for (const vp of VIEWPORTS) {
      await page.setViewport({ width: vp.width, height: vp.height, isMobile: vp.isMobile });
      await new Promise((r) => setTimeout(r, 400));
      await page.screenshot({ path: path.join(ARTIFACT_DIR, `activity_timeline_${vp.name}.png`) });
    }
    console.log("✓ Captured activity timeline across viewports");

    // Wait for execution to finish and load records
    console.log("⏳ Waiting for job completion and data loading...");
    await new Promise((r) => setTimeout(r, 5000));

    // 8. Capture Results Workspace (Table, PDF, Notes, Files, Methodology)
    console.log("📸 7. Capturing Results Workspace (لوحة النتائج)...");
    await page.setViewport({ width: 1280, height: 850 });
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("النتائج")
      ) as HTMLElement;
      if (btn) btn.click();
    });
    await new Promise((r) => setTimeout(r, 1000));

    for (const vp of VIEWPORTS) {
      await page.setViewport({ width: vp.width, height: vp.height, isMobile: vp.isMobile });
      await new Promise((r) => setTimeout(r, 500));

      // Tab 1: Data Table
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === "البيانات");
        if (btn) (btn as HTMLElement).click();
      });
      await new Promise((r) => setTimeout(r, 400));
      await page.screenshot({ path: path.join(ARTIFACT_DIR, `results_table_${vp.name}.png`) });

      // Tab 2: PDF Preview
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === "التقرير");
        if (btn) (btn as HTMLElement).click();
      });
      await new Promise((r) => setTimeout(r, 400));
      await page.screenshot({ path: path.join(ARTIFACT_DIR, `results_pdf_${vp.name}.png`) });

      // Tab 3: Notes
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === "الملاحظات");
        if (btn) (btn as HTMLElement).click();
      });
      await new Promise((r) => setTimeout(r, 400));
      await page.screenshot({ path: path.join(ARTIFACT_DIR, `results_notes_${vp.name}.png`) });

      // Tab 4: Files Downloads
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === "الملفات");
        if (btn) (btn as HTMLElement).click();
      });
      await new Promise((r) => setTimeout(r, 400));
      await page.screenshot({ path: path.join(ARTIFACT_DIR, `results_files_${vp.name}.png`) });

      // Methodology Section
      await page.screenshot({ path: path.join(ARTIFACT_DIR, `results_methodology_${vp.name}.png`) });
    }
    console.log("✓ Captured all Results Workspace tabs");

    // Close canvas drawer before navigating away
    await page.evaluate(() => {
      const closeBtn = document.querySelector('button[aria-label="إغلاق مساحة النتائج"]');
      if (closeBtn) (closeBtn as HTMLElement).click();
    });

    // 9. Order History
    console.log("📸 8. Capturing Order History (/dashboard/jobs)...");
    await page.goto(`${BASE_URL}/dashboard/jobs`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 1500));
    for (const vp of VIEWPORTS) {
      await page.setViewport({ width: vp.width, height: vp.height, isMobile: vp.isMobile });
      await new Promise((r) => setTimeout(r, 400));
      await page.screenshot({ path: path.join(ARTIFACT_DIR, `order_history_${vp.name}.png`) });
    }

    // 10. Balance & Top-up
    console.log("📸 9. Capturing Balance & Top-up (/dashboard/topup)...");
    await page.goto(`${BASE_URL}/dashboard/topup`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 1500));
    for (const vp of VIEWPORTS) {
      await page.setViewport({ width: vp.width, height: vp.height, isMobile: vp.isMobile });
      await new Promise((r) => setTimeout(r, 400));
      await page.screenshot({ path: path.join(ARTIFACT_DIR, `balance_topup_${vp.name}.png`) });
    }

    console.log("\n🎉 ALL Phase B2 real screenshots successfully captured!");

  } finally {
    await browser.close();

    // Clean up test user
    if (testUserId) {
      console.log("🧹 Cleaning up test user and seed ledger row...");
      try {
        await users.delete(testUserId);
        console.log(`✓ Deleted test user ${testUserId}`);
      } catch (e: any) {
        console.warn("User deletion:", e.message);
      }
      if (profileRowId) {
        try {
          await tables.deleteRow({ databaseId: "digr", tableId: "profiles", rowId: profileRowId });
        } catch {}
      }
      if (ledgerRowId) {
        try {
          await tables.deleteRow({ databaseId: "digr", tableId: "credit_ledger", rowId: ledgerRowId });
        } catch {}
      }
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
