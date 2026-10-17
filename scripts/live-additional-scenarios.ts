import puppeteer, { Browser, Page } from "puppeteer-core";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import ExcelJS from "exceljs";

dotenv.config({ path: ".env.local" });

import { createAdminClient } from "../src/lib/supabase/server";

const BASE_URL = "https://diger.tech";
const TEST_EMAIL = process.env.DIGER_TEST_EMAIL || (() => { throw new Error("DIGER_TEST_EMAIL is required"); })();
const TEST_PASSWORD = process.env.DIGER_TEST_PASSWORD || (() => { throw new Error("DIGER_TEST_PASSWORD is required"); })();
const TEST_USER_ID = "47693c59-89f1-405d-bec1-e72271517870";
const ARTIFACT_DIR = path.resolve("C:/Users/lenovo/.gemini/antigravity/brain/19ea4c3a-a1f7-4847-b3e0-723c199db4cf");
const BROWSER_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

async function typeIntoReactInput(page: Page, selector: string, text: string) {
  await page.focus(selector);
  await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement;
    if (el) {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, selector);
  await page.type(selector, text, { delay: 25 });
}

async function sendUserMessage(page: Page, text: string) {
  const inputSelector = '#chat-composer-input, input[aria-label="اسأل ديجر"], textarea[aria-label="اسأل ديجر"]';
  const sendBtnSelector = 'button[aria-label="إرسال الطلب"], button[type="submit"]';

  await page.waitForFunction(
    () => {
      const textAll = document.body.textContent || "";
      const statusP = document.querySelector('p[role="status"]')?.textContent || "";
      return !textAll.includes("يكتب الرد...") && !statusP.includes("جاري");
    },
    { timeout: 25000 }
  ).catch(() => null);

  await typeIntoReactInput(page, inputSelector, text);
  await new Promise((r) => setTimeout(r, 200));

  await page.waitForFunction(
    (sel) => {
      const btn = document.querySelector(sel) as HTMLButtonElement | null;
      return btn && !btn.disabled;
    },
    { timeout: 15000 },
    sendBtnSelector
  );

  await page.click(sendBtnSelector);
}

async function runAdditionalScenarios() {
  console.log("====================================================");
  console.log("🚀 Running Additional Live Scenarios (Acceptance Test 8)");
  console.log("1. Larger Request: 20 Companies (Pagination & Deduplication)");
  console.log("2. Second Live Capability: TikTok Public Profile");
  console.log("====================================================\n");

  const browser: Browser = await puppeteer.launch({
    executablePath: BROWSER_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1280,900",
      "--lang=ar-EG,ar",
    ],
  });

  const sb = createAdminClient();

  try {
    const page: Page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    const inputSelector = '#chat-composer-input, input[aria-label="اسأل ديجر"], textarea[aria-label="اسأل ديجر"]';

    // Login
    console.log("🔹 Logging in...");
    await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle2" });
    const emailSelector = 'input[type="email"], input[name="email"]';
    const passwordSelector = 'input[type="password"], input[name="password"]';
    await page.waitForSelector(emailSelector, { timeout: 15000 });
    await typeIntoReactInput(page, emailSelector, TEST_EMAIL);
    await typeIntoReactInput(page, passwordSelector, TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => window.location.pathname.startsWith("/dashboard"), { timeout: 15000 });

    // ─────────────────────────────────────────────────────────────
    // SCENARIO 8A: 20 Companies Request (Pagination & Volume)
    // ─────────────────────────────────────────────────────────────
    console.log("\n🔹 Scenario 8A: Requesting 20 Construction Companies in Egypt...");
    await page.goto(`${BASE_URL}/dashboard/chat`, { waitUntil: "networkidle2" });
    await page.waitForSelector(inputSelector, { timeout: 15000 });
    await page.evaluate(() => window.dispatchEvent(new Event("diger:new-chat")));
    await new Promise((r) => setTimeout(r, 600));

    await sendUserMessage(page, "عايز 20 شركة مقاولات في مصر في ملف Excel");

    console.log("Waiting for 20-company plan quote card...");
    await page.waitForSelector('div[aria-label="خطة البحث وعرض السعر"]', { timeout: 45000 });
    console.log("✅ Plan card appeared for 20 companies!");

    const plan20Details = await page.evaluate(() => {
      const card = document.querySelector('div[aria-label="خطة البحث وعرض السعر"]');
      return card?.textContent || "";
    });
    console.log("20-Company Plan Details:", plan20Details);

    const screenshotPlan20 = path.join(ARTIFACT_DIR, "live-10-plan-20-companies.png");
    await page.screenshot({ path: screenshotPlan20 });

    // Approve
    const start20BtnHandle = await page.evaluateHandle(() => {
      const card = document.querySelector('div[aria-label="خطة البحث وعرض السعر"]');
      return Array.from(card?.querySelectorAll("button") || []).find((b) =>
        b.textContent?.includes("أوافق وابدأ البحث") || b.classList.contains("bg-ac")
      );
    });
    const start20Btn = start20BtnHandle.asElement();
    if (start20Btn) {
      await start20Btn.click();
      console.log("Approved 20-company plan! Watching activity timeline...");
    }

    await page.waitForSelector('div[aria-label="سجل نشاط التنفيذ"]', { timeout: 30000 });
    console.log("Activity timeline mounted for 20-company job!");

    // Wait for job completion in DB
    let job20Done = false;
    const tStart20 = Date.now();
    let job20Id = "";

    while (Date.now() - tStart20 < 90000) {
      const { data: dbJob } = await sb
        .from("jobs")
        .select("id, status, delivered_units, error_message")
        .eq("user_id", TEST_USER_ID)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (dbJob) {
        job20Id = dbJob.id;
        if (dbJob.status === "completed" || dbJob.status === "done") {
          console.log(`✅ [DB Check] 20-company Job ${dbJob.id} completed with ${dbJob.delivered_units} records!`);
          job20Done = true;
          break;
        } else if (dbJob.status === "failed") {
          console.error(`❌ [DB Check] 20-company Job ${dbJob.id} failed: ${dbJob.error_message}`);
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    const screenshotExec20 = path.join(ARTIFACT_DIR, "live-11-execution-20-companies.png");
    await page.screenshot({ path: screenshotExec20 });

    if (job20Done && job20Id) {
      const { data: xlsxBlob } = await sb.storage
        .from("results")
        .download(`${TEST_USER_ID}/${job20Id}/result.xlsx`);

      if (xlsxBlob) {
        const xlsxBuf = Buffer.from(await xlsxBlob.arrayBuffer());
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(xlsxBuf);
        const dataSheet = wb.getWorksheet("دليل الشركات المعتمد") || wb.getWorksheet("البيانات") || wb.worksheets[1];
        const names: string[] = [];
        dataSheet?.eachRow((row, rowNumber) => {
          if (rowNumber > 1) {
            const name = String(row.getCell(2).value || row.getCell(1).value || "");
            if (name) names.push(name);
          }
        });
        console.log(`✅ Downloaded Excel for 20-company job: ${names.length} rows delivered:`, names.slice(0, 10));
        fs.writeFileSync(path.join(ARTIFACT_DIR, `live-delivered-20-${job20Id}.xlsx`), xlsxBuf);
      }
    }

    // ─────────────────────────────────────────────────────────────
    // SCENARIO 8B: Second Live Capability (TikTok Public Profile)
    // ─────────────────────────────────────────────────────────────
    console.log("\n🔹 Scenario 8B: Requesting TikTok Profile for public account...");
    await page.goto(`${BASE_URL}/dashboard/chat`, { waitUntil: "networkidle2" });
    await page.waitForSelector(inputSelector, { timeout: 15000 });
    await page.evaluate(() => window.dispatchEvent(new Event("diger:new-chat")));
    await new Promise((r) => setTimeout(r, 600));

    await sendUserMessage(page, "عايز بيانات حساب khaby.lame على تيك توك في ملف Excel");

    console.log("Waiting for TikTok profile plan quote card...");
    await page.waitForSelector('div[aria-label="خطة البحث وعرض السعر"]', { timeout: 45000 });
    console.log("✅ Plan card appeared for TikTok public profile!");

    const tiktokPlanDetails = await page.evaluate(() => {
      const card = document.querySelector('div[aria-label="خطة البحث وعرض السعر"]');
      return card?.textContent || "";
    });
    console.log("TikTok Profile Plan Details:", tiktokPlanDetails);

    const screenshotTikTokPlan = path.join(ARTIFACT_DIR, "live-12-plan-tiktok-profile.png");
    await page.screenshot({ path: screenshotTikTokPlan });

    // Approve TikTok profile plan
    const startTiktokBtnHandle = await page.evaluateHandle(() => {
      const card = document.querySelector('div[aria-label="خطة البحث وعرض السعر"]');
      return Array.from(card?.querySelectorAll("button") || []).find((b) =>
        b.textContent?.includes("أوافق وابدأ البحث") || b.classList.contains("bg-ac")
      );
    });
    const startTiktokBtn = startTiktokBtnHandle.asElement();
    if (startTiktokBtn) {
      await startTiktokBtn.click();
      console.log("Approved TikTok profile plan! Watching activity timeline...");
    }

    await page.waitForSelector('div[aria-label="سجل نشاط التنفيذ"]', { timeout: 30000 });

    let tiktokJobDone = false;
    let tiktokJobId = "";
    const tStartTiktok = Date.now();

    while (Date.now() - tStartTiktok < 60000) {
      const { data: dbJob } = await sb
        .from("jobs")
        .select("id, status, delivered_units, error_message")
        .eq("user_id", TEST_USER_ID)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (dbJob) {
        tiktokJobId = dbJob.id;
        if (dbJob.status === "completed" || dbJob.status === "done") {
          console.log(`✅ [DB Check] TikTok Profile Job ${dbJob.id} completed with ${dbJob.delivered_units} record!`);
          tiktokJobDone = true;
          break;
        } else if (dbJob.status === "failed") {
          console.error(`❌ [DB Check] TikTok Profile Job ${dbJob.id} failed: ${dbJob.error_message}`);
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    const screenshotTikTokExec = path.join(ARTIFACT_DIR, "live-13-execution-tiktok-profile.png");
    await page.screenshot({ path: screenshotTikTokExec });

    console.log("\n====================================================");
    console.log(`🎉 Additional Scenarios Results:`);
    console.log(`- 20-Company Job: ${job20Id} (Done: ${job20Done})`);
    console.log(`- TikTok Profile Job: ${tiktokJobId} (Done: ${tiktokJobDone})`);
    console.log("====================================================");

  } finally {
    await browser.close();
  }
}

runAdditionalScenarios().catch((err) => {
  console.error("❌ Fatal Error in Additional Scenarios:", err);
  process.exit(1);
});
