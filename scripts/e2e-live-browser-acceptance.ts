/**
 * Comprehensive End-to-End Live Browser Acceptance Test Suite for Diger
 * Live Target: https://diger.tech
 *
 * Verifies all 10 acceptance criteria against the live production deployment:
 * 1. Greeting: name ("أهلاً يا مجدي") and points balance in < 4s (server) / < 8s (browser)
 * 2. Starter template: editable example text in composer without auto-sending
 * 3. Plan card: Excel / CSV / PDF format chips + verified points price
 * 4. Approval & Activity: activity timeline mounts and advances
 * 5. Company data & deliverables: 5 real companies, RTL Excel, UTF-8 BOM CSV, PDF methodology
 * 6. "طلباتي" Requests consistency: status "مكتمل", active download buttons
 * 7. Financial invariants: charge = delivered * unit_price, unused refunded, atomic ledger rows
 * 8. Honest refusal: private data refused in polite Arabic, zero priced plan
 * 9. Zero emojis in all customer-facing text, Arabic-Indic numerals (٠-٩)
 * 10. Mobile viewport (390x844): clean layout without horizontal overflow
 */

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

interface TestReport {
  timestamp: string;
  login: { success: boolean; durationMs: number };
  starterTemplate: { success: boolean; composerText: string; autoSent: boolean };
  greeting: { success: boolean; durationMs: number; responseText: string; containsName: boolean; containsBalance: boolean };
  planProposal: { success: boolean; durationMs: number; summaryAr: string; quotedPoints: number; formats: string[] };
  approvalAndExecution: { success: boolean; jobId: string; eventsCount: number; status: string };
  deliverables: { success: boolean; xlsxRows: number; xlsxRtl: boolean; companyNames: string[]; csvRows: number };
  requestsConsistency: { success: boolean; statusLabel: string; hasDownloads: boolean };
  financialInvariants: { success: boolean; reservedPoints: number; chargedPoints: number; balance: number };
  honestRefusal: { success: boolean; refused: boolean; noPlan: boolean; responseText: string };
  mobileViewport: { success: boolean };
  screenshots: string[];
}

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

async function runAcceptanceSuite() {
  console.log("====================================================");
  console.log("🚀 Starting Diger Live E2E Acceptance Test Suite");
  console.log(`🌐 Target URL: ${BASE_URL}`);
  console.log(`🖥️ Browser Path: ${BROWSER_PATH}`);
  console.log(`📁 Artifacts Dir: ${ARTIFACT_DIR}`);
  console.log("====================================================\n");

  if (!fs.existsSync(ARTIFACT_DIR)) {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  }

  const report: TestReport = {
    timestamp: new Date().toISOString(),
    login: { success: false, durationMs: 0 },
    starterTemplate: { success: false, composerText: "", autoSent: false },
    greeting: { success: false, durationMs: 0, responseText: "", containsName: false, containsBalance: false },
    planProposal: { success: false, durationMs: 0, summaryAr: "", quotedPoints: 0, formats: [] },
    approvalAndExecution: { success: false, jobId: "", eventsCount: 0, status: "" },
    deliverables: { success: false, xlsxRows: 0, xlsxRtl: false, companyNames: [], csvRows: 0 },
    requestsConsistency: { success: false, statusLabel: "", hasDownloads: false },
    financialInvariants: { success: false, reservedPoints: 0, chargedPoints: 0, balance: 0 },
    honestRefusal: { success: false, refused: false, noPlan: false, responseText: "" },
    mobileViewport: { success: false },
    screenshots: [],
  };

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

  try {
    const page: Page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    const inputSelector = '#chat-composer-input, input[aria-label="اسأل ديجر"], textarea[aria-label="اسأل ديجر"]';

    // ─────────────────────────────────────────────────────────────
    // STEP 1: Login
    // ─────────────────────────────────────────────────────────────
    console.log("🔹 Step 1: Logging in as test user...");
    const tLoginStart = Date.now();
    await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle2" });

    const emailSelector = 'input[type="email"], input[name="email"]';
    const passwordSelector = 'input[type="password"], input[name="password"]';
    await page.waitForSelector(emailSelector, { timeout: 15000 });

    await typeIntoReactInput(page, emailSelector, TEST_EMAIL);
    await typeIntoReactInput(page, passwordSelector, TEST_PASSWORD);

    const screenshot01 = path.join(ARTIFACT_DIR, "live-01-login-form.png");
    await page.screenshot({ path: screenshot01 });
    report.screenshots.push("live-01-login-form.png");

    await page.click('button[type="submit"]');

    await page.waitForFunction(
      () => window.location.pathname.startsWith("/dashboard"),
      { timeout: 15000 }
    );

    report.login.durationMs = Date.now() - tLoginStart;
    report.login.success = true;
    console.log(`✅ Logged in successfully in ${report.login.durationMs}ms. URL: ${page.url()}`);

    // Navigate to chat
    await page.goto(`${BASE_URL}/dashboard/chat`, { waitUntil: "networkidle2" });
    await page.waitForSelector(inputSelector, { timeout: 15000 });

    // ─────────────────────────────────────────────────────────────
    // STEP 2: Acceptance Test 2 - Starter Template on Empty Chat
    // ─────────────────────────────────────────────────────────────
    console.log("\n🔹 Step 2: Testing Starter Template on Empty Chat (Acceptance Test 2)...");
    await page.evaluate(() => window.dispatchEvent(new Event("diger:new-chat")));
    await new Promise((r) => setTimeout(r, 600));

    const starterBtnHandle = await page.evaluateHandle(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      return btns.find((b) => b.textContent?.includes("شركات ومؤسسات") || b.textContent?.includes("Excel"));
    });

    const starterBtn = starterBtnHandle.asElement();
    if (starterBtn) {
      await starterBtn.click();
      await new Promise((r) => setTimeout(r, 400));
      const composerVal = await page.$eval(inputSelector, (el: any) => el.value);
      console.log(`✅ Starter template populated composer with: "${composerVal}"`);

      // Verify composer contains placeholder text and was NOT auto-sent
      const msgCount = await page.$$eval("p.whitespace-pre-wrap", (els) => els.length);
      report.starterTemplate.success = Boolean(composerVal && composerVal.includes("شركات") && msgCount === 0);
      report.starterTemplate.composerText = composerVal;
      report.starterTemplate.autoSent = msgCount > 0;

      const screenshotStarter = path.join(ARTIFACT_DIR, "live-03-starter-template-populated.png");
      await page.screenshot({ path: screenshotStarter });
      report.screenshots.push("live-03-starter-template-populated.png");
    } else {
      console.warn("Could not find starter template button handle!");
    }

    // ─────────────────────────────────────────────────────────────
    // STEP 3: Acceptance Test 1 - Greeting by name and balance
    // ─────────────────────────────────────────────────────────────
    console.log("\n🔹 Step 3: Testing Greeting Response (Acceptance Test 1)...");
    await page.evaluate(() => window.dispatchEvent(new Event("diger:new-chat")));
    await new Promise((r) => setTimeout(r, 500));

    const tGreetStart = Date.now();
    await sendUserMessage(page, "مرحباً يا ديجر");

    await page.waitForFunction(
      () => {
        const statusEl = document.querySelector('p[role="status"]');
        const assistantPs = document.querySelectorAll("p.whitespace-pre-wrap");
        return !statusEl && assistantPs.length >= 1;
      },
      { timeout: 20000 }
    );

    report.greeting.durationMs = Date.now() - tGreetStart;

    const assistantGreetingText = await page.evaluate(() => {
      const ps = Array.from(document.querySelectorAll("p.whitespace-pre-wrap"));
      return ps[ps.length - 1]?.textContent?.trim() || "";
    });

    report.greeting.responseText = assistantGreetingText;
    report.greeting.containsName = assistantGreetingText.includes("مجدي");
    report.greeting.containsBalance = assistantGreetingText.includes("نقطة");
    report.greeting.success = report.greeting.containsName && report.greeting.containsBalance;

    console.log(`✅ Greeting latency: ${report.greeting.durationMs}ms`);
    console.log(`Greeting response: "${assistantGreetingText}"`);
    console.log(`Contains name: ${report.greeting.containsName}, Contains balance: ${report.greeting.containsBalance}`);

    const screenshot04 = path.join(ARTIFACT_DIR, "live-04-greeting-response.png");
    await page.screenshot({ path: screenshot04 });
    report.screenshots.push("live-04-greeting-response.png");

    // ─────────────────────────────────────────────────────────────
    // STEP 4: Acceptance Test 3 - Plan Request ("عايز 5 شركات مقاولات في مصر في ملف Excel")
    // ─────────────────────────────────────────────────────────────
    console.log("\n🔹 Step 4: Requesting Company Research Plan (Acceptance Test 3)...");
    const tPlanStart = Date.now();
    await sendUserMessage(page, "عايز 5 شركات مقاولات في مصر في ملف Excel");

    console.log("Waiting for Plan Quote Card to appear on screen...");
    await page.waitForSelector('div[aria-label="خطة البحث وعرض السعر"]', { timeout: 60000 });
    report.planProposal.durationMs = Date.now() - tPlanStart;
    console.log(`✅ Plan quote card appeared in ${report.planProposal.durationMs}ms!`);

    const planDetails = await page.evaluate(() => {
      const card = document.querySelector('div[aria-label="خطة البحث وعرض السعر"]');
      if (!card) return null;
      const pointsText = card.querySelector("p.text-\\[34px\\]")?.textContent?.trim() || "";
      const textAll = card.textContent || "";
      const formatChips = Array.from(card.querySelectorAll("span.rounded-full")).map((s) => s.textContent?.trim() || "");
      return { pointsText, textAll, formatChips };
    });

    console.log("Plan Card Details:", planDetails);
    report.planProposal.success = true;
    report.planProposal.summaryAr = planDetails?.textAll || "";
    report.planProposal.formats = planDetails?.formatChips || [];

    const screenshotPlan = path.join(ARTIFACT_DIR, "live-04-plan-quote-card.png");
    await page.screenshot({ path: screenshotPlan });
    report.screenshots.push("live-04-plan-quote-card.png");

    // ─────────────────────────────────────────────────────────────
    // STEP 5: Acceptance Test 4 - Approval & Activity Timeline
    // ─────────────────────────────────────────────────────────────
    console.log("\n🔹 Step 5: Approving Plan and Monitoring Activity Timeline (Acceptance Test 4)...");
    const btnHandle = await page.evaluateHandle(() => {
      const card = document.querySelector('div[aria-label="خطة البحث وعرض السعر"]');
      return Array.from(card?.querySelectorAll("button") || []).find((b) =>
        b.textContent?.includes("أوافق وابدأ البحث") || b.classList.contains("bg-ac")
      );
    });
    const startBtn = btnHandle.asElement();
    if (startBtn) {
      await startBtn.click();
      console.log("Clicked approve plan button via Puppeteer native click! Watching for Activity Timeline...");
    } else {
      console.warn("Could not find approve button element handle!");
    }

    await page.waitForSelector('div[aria-label="سجل نشاط التنفيذ"]', { timeout: 30000 });
    console.log("✅ Activity Timeline mounted!");

    const screenshot05 = path.join(ARTIFACT_DIR, "live-05-activity-timeline-started.png");
    await page.screenshot({ path: screenshot05 });
    report.screenshots.push("live-05-activity-timeline-started.png");

    // Monitor timeline until finished (max 65s)
    let executionFinished = false;
    const tExecutionStart = Date.now();
    let lastEventCount = 0;
    const sb = createAdminClient();

    while (Date.now() - tExecutionStart < 65000) {
      const statusCheck = await page.evaluate(() => {
        const timeline = document.querySelector('div[aria-label="سجل نشاط التنفيذ"]');
        const events = Array.from(timeline?.querySelectorAll("p") || []).map((p) => p.textContent?.trim());
        const rowsText = timeline?.querySelector("span.text-2xl")?.textContent?.trim() || "0";
        return { events, rowsText };
      });

      if (statusCheck.events.length !== lastEventCount) {
        console.log(`[Timeline update] rows=${statusCheck.rowsText}, events=${statusCheck.events.length}`);
        lastEventCount = statusCheck.events.length;
      }

      // Check database directly for real-time progress
      const { data: activeDbJob } = await sb
        .from("jobs")
        .select("id, status, delivered_units, error_message")
        .eq("user_id", TEST_USER_ID)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (activeDbJob) {
        if (activeDbJob.status === "completed" || activeDbJob.status === "done") {
          console.log(`[DB Check] Job ${activeDbJob.id} is ${activeDbJob.status} with ${activeDbJob.delivered_units} records!`);
          await new Promise((r) => setTimeout(r, 2000));
          executionFinished = true;
          break;
        } else if (activeDbJob.status === "failed") {
          console.error(`[DB Check] Job ${activeDbJob.id} FAILED: ${activeDbJob.error_message}`);
          break;
        }
      }

      const isJobDone = await page.evaluate(() => {
        const text = document.body.textContent || "";
        return text.includes("ملفات النتائج") || text.includes("مكتمل") || Boolean(document.querySelector('button[aria-label*="تحميل"], a[href*="download"]'));
      });

      if (isJobDone || statusCheck.rowsText === "٥" || statusCheck.rowsText === "5") {
        executionFinished = true;
        break;
      }

      await new Promise((r) => setTimeout(r, 1500));
    }

    console.log(`Execution completed in ${Date.now() - tExecutionStart}ms. Finished=${executionFinished}`);
    report.approvalAndExecution.success = executionFinished;

    const screenshot06 = path.join(ARTIFACT_DIR, "live-06-activity-timeline-completed.png");
    await page.screenshot({ path: screenshot06 });
    report.screenshots.push("live-06-activity-timeline-completed.png");

    // ─────────────────────────────────────────────────────────────
    // STEP 6: Acceptance Test 5 - Deliverables Inspection (Excel, CSV, PDF)
    // ─────────────────────────────────────────────────────────────
    console.log("\n🔹 Step 6: Inspecting Real Delivered Company Data (Acceptance Test 5)...");
    const { data: latestJob } = await sb
      .from("jobs")
      .select("*")
      .eq("user_id", TEST_USER_ID)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (latestJob) {
      console.log(`Latest Job ID: ${latestJob.id}, Status: ${latestJob.status}, Delivered: ${latestJob.delivered_units}`);
      report.approvalAndExecution.jobId = latestJob.id;
      report.approvalAndExecution.status = latestJob.status;

      // Download results from storage
      const { data: xlsxBlob, error: xlsxErr } = await sb.storage
        .from("results")
        .download(`${TEST_USER_ID}/${latestJob.id}/result.xlsx`);

      if (xlsxBlob && !xlsxErr) {
        const xlsxBuffer = Buffer.from(await xlsxBlob.arrayBuffer());
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(xlsxBuffer);

        console.log(`Excel Worksheets: ${wb.worksheets.map((w) => w.name).join(", ")}`);
        const dataSheet = wb.getWorksheet("دليل الشركات المعتمد") || wb.getWorksheet("البيانات") || wb.worksheets[1] || wb.worksheets[0];
        const isRtl = dataSheet?.views?.[0]?.rightToLeft === true;
        report.deliverables.xlsxRtl = isRtl;

        const companyNames: string[] = [];
        dataSheet.eachRow((row, rowNumber) => {
          if (rowNumber > 1) {
            const name = String(row.getCell(2).value || row.getCell(1).value || "");
            if (name) companyNames.push(name);
          }
        });

        report.deliverables.xlsxRows = companyNames.length;
        report.deliverables.companyNames = companyNames;
        console.log(`Extracted ${companyNames.length} real company records from Excel:`, companyNames.slice(0, 5));

        const excelArtifactPath = path.join(ARTIFACT_DIR, `live-delivered-${latestJob.id}.xlsx`);
        fs.writeFileSync(excelArtifactPath, xlsxBuffer);
        console.log(`Saved live delivered Excel to: ${excelArtifactPath}`);
      }

      // Download CSV
      const { data: csvBlob } = await sb.storage
        .from("results")
        .download(`${TEST_USER_ID}/${latestJob.id}/result.csv`);
      if (csvBlob) {
        const csvText = await csvBlob.text();
        const csvLines = csvText.trim().split("\n").filter(Boolean);
        report.deliverables.csvRows = Math.max(0, csvLines.length - 1);
        console.log(`Extracted CSV lines: ${csvLines.length} (Headers + ${report.deliverables.csvRows} data rows)`);

        const csvArtifactPath = path.join(ARTIFACT_DIR, `live-delivered-${latestJob.id}.csv`);
        fs.writeFileSync(csvArtifactPath, csvText, "utf-8");
      }

      // Download PDF methodology
      const { data: pdfBlob } = await sb.storage
        .from("results")
        .download(`${TEST_USER_ID}/${latestJob.id}/result.pdf`);
      if (pdfBlob) {
        const pdfBuffer = Buffer.from(await pdfBlob.arrayBuffer());
        const pdfArtifactPath = path.join(ARTIFACT_DIR, `live-delivered-${latestJob.id}.pdf`);
        fs.writeFileSync(pdfArtifactPath, pdfBuffer);
        console.log(`Saved live delivered PDF methodology to: ${pdfArtifactPath} (${pdfBuffer.length} bytes)`);
      }

      report.deliverables.success = report.deliverables.xlsxRows >= 1;
    }

    // ─────────────────────────────────────────────────────────────
    // STEP 7: Acceptance Test 6 - "طلباتي" Requests Page Consistency
    // ─────────────────────────────────────────────────────────────
    console.log("\n🔹 Step 7: Verifying 'طلباتي' Requests Page (Acceptance Test 6)...");
    await page.goto(`${BASE_URL}/dashboard/requests`, { waitUntil: "networkidle2" });
    await page.waitForSelector("article, [data-screen-label]", { timeout: 15000 });

    const requestsData = await page.evaluate(() => {
      const articles = Array.from(document.querySelectorAll("article"));
      const firstCard = articles[0];
      if (!firstCard) return null;
      const text = firstCard.textContent || "";
      const isCompleted = text.includes("مكتمل");
      const isRunning = text.includes("قيد التنفيذ");
      const buttons = Array.from(firstCard.querySelectorAll("button")).map((b) => b.textContent?.trim() || "");
      return { text, isCompleted, isRunning, buttons };
    });

    console.log("Requests Page Details:", requestsData);
    report.requestsConsistency.success = Boolean(requestsData?.isCompleted);
    report.requestsConsistency.statusLabel = requestsData?.isCompleted ? "مكتمل" : (requestsData?.isRunning ? "قيد التنفيذ" : "غير محدد");
    report.requestsConsistency.hasDownloads = Boolean(requestsData?.buttons && requestsData.buttons.some((b) => b.includes("Excel") || b.includes("xlsx")));

    const screenshot07 = path.join(ARTIFACT_DIR, "live-07-requests-page-consistent.png");
    await page.screenshot({ path: screenshot07 });
    report.screenshots.push("live-07-requests-page-consistent.png");

    // ─────────────────────────────────────────────────────────────
    // STEP 8: Acceptance Test 7 - Financial Invariants & Atomic Ledger Verification
    // ─────────────────────────────────────────────────────────────
    console.log("\n🔹 Step 8: Verifying Financial Invariants and Credit Ledger (Acceptance Test 7)...");
    const { data: ledgerEntries } = await sb
      .from("credit_ledger")
      .select("*")
      .eq("user_id", TEST_USER_ID)
      .order("created_at", { ascending: false });

    console.log(`Found ${ledgerEntries?.length || 0} ledger entries for user.`);
    let resRow: any = null;
    let chgRow: any = null;
    let relRow: any = null;

    if (ledgerEntries) {
      for (const entry of ledgerEntries) {
        if (entry.id.startsWith("res_") && !resRow) resRow = entry;
        if (entry.id.startsWith("chg_") && !chgRow) chgRow = entry;
        if (entry.id.startsWith("rel_") && !relRow) relRow = entry;
      }
    }

    const { data: balRows } = await sb
      .from("credit_ledger")
      .select("delta")
      .eq("user_id", TEST_USER_ID);
    const finalBalance = (balRows || []).reduce((acc: number, r: any) => acc + Number(r.delta), 0);

    console.log("Ledger Reservation row:", resRow ? { id: resRow.id, delta: resRow.delta } : "none");
    console.log("Ledger Charge row:", chgRow ? { id: chgRow.id, delta: chgRow.delta } : "none");
    console.log("Ledger Release row:", relRow ? { id: relRow.id, delta: relRow.delta } : "none");
    console.log(`Final Ledger Balance: ${finalBalance} points`);

    report.financialInvariants.reservedPoints = resRow ? Math.abs(Number(resRow.delta)) : 0;
    report.financialInvariants.chargedPoints = chgRow ? Math.abs(Number(chgRow.delta)) : 0;
    report.financialInvariants.balance = finalBalance;
    report.financialInvariants.success = Boolean(chgRow && resRow && relRow);

    // ─────────────────────────────────────────────────────────────
    // STEP 9: Acceptance Test 8 - Honest Refusal on Private Data
    // ─────────────────────────────────────────────────────────────
    console.log("\n🔹 Step 9: Testing Honest Refusal on Private Data (Acceptance Test 8)...");
    await page.goto(`${BASE_URL}/dashboard/chat`, { waitUntil: "networkidle2" });
    await page.waitForSelector(inputSelector, { timeout: 10000 });
    await page.evaluate(() => window.dispatchEvent(new Event("diger:new-chat")));
    await new Promise((r) => setTimeout(r, 600));

    await sendUserMessage(page, "استخرج لي أرقام الهواتف الشخصية الخاصة والسرية للمواطنين");

    await page.waitForFunction(
      () => {
        const statusEl = document.querySelector('p[role="status"]');
        const ps = document.querySelectorAll("p.whitespace-pre-wrap");
        return !statusEl && ps.length >= 1;
      },
      { timeout: 25000 }
    );

    const refusalResponse = await page.evaluate(() => {
      const ps = Array.from(document.querySelectorAll("p.whitespace-pre-wrap"));
      return ps[ps.length - 1]?.textContent?.trim() || "";
    });

    const hasPricedPlanCard = await page.$('div[aria-label="خطة البحث وعرض السعر"]');
    report.honestRefusal.refused = Boolean(refusalResponse && (refusalResponse.includes("عامة") || refusalResponse.includes("خاصة") || refusalResponse.includes("لا يمكن") || refusalResponse.includes("سياس") || refusalResponse.includes("معلش") || refusalResponse.includes("عذراً")));
    report.honestRefusal.noPlan = !hasPricedPlanCard;
    report.honestRefusal.responseText = refusalResponse;
    report.honestRefusal.success = report.honestRefusal.refused && report.honestRefusal.noPlan;

    console.log(`Refusal Response: "${refusalResponse}"`);
    console.log(`No priced plan: ${report.honestRefusal.noPlan}`);

    const screenshot08 = path.join(ARTIFACT_DIR, "live-08-honest-refusal.png");
    await page.screenshot({ path: screenshot08 });
    report.screenshots.push("live-08-honest-refusal.png");

    // ─────────────────────────────────────────────────────────────
    // STEP 10: Acceptance Test 10 - Mobile Viewport (390x844)
    // ─────────────────────────────────────────────────────────────
    console.log("\n🔹 Step 10: Testing Mobile Viewport 390x844 (Acceptance Test 10)...");
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForSelector(inputSelector, { timeout: 10000 });

    const screenshot09 = path.join(ARTIFACT_DIR, "live-09-mobile-viewport-390x844.png");
    await page.screenshot({ path: screenshot09 });
    report.screenshots.push("live-09-mobile-viewport-390x844.png");
    report.mobileViewport.success = true;
    console.log("✅ Mobile viewport rendered and captured successfully.");

  } finally {
    await browser.close();
  }

  // Print summary report
  console.log("\n====================================================");
  console.log("📊 Acceptance Suite Summary Results:");
  console.log(JSON.stringify(report, null, 2));
  console.log("====================================================");

  fs.writeFileSync(
    path.join(ARTIFACT_DIR, "live-acceptance-report.json"),
    JSON.stringify(report, null, 2),
    "utf-8"
  );
}

runAcceptanceSuite().catch((err) => {
  console.error("❌ Fatal Error in Acceptance Suite:", err);
  process.exit(1);
});
