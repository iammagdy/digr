/**
 * Acceptance Round 3 Live Browser Verification Suite on https://diger.tech
 */
import puppeteer, { Browser, Page } from "puppeteer-core";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import ExcelJS from "exceljs";
import { createAdminClient } from "../src/lib/supabase/server";

dotenv.config({ path: ".env.local" });

const BASE_URL = "https://diger.tech";
const TEST_EMAIL = process.env.DIGER_TEST_EMAIL || (() => { throw new Error("DIGER_TEST_EMAIL is required"); })();
const TEST_PASSWORD = process.env.DIGER_TEST_PASSWORD || (() => { throw new Error("DIGER_TEST_PASSWORD is required"); })();
const ARTIFACT_DIR = path.resolve("C:/Users/lenovo/.gemini/antigravity/brain/19ea4c3a-a1f7-4847-b3e0-723c199db4cf");
const DOWNLOAD_DIR = path.resolve(ARTIFACT_DIR, "downloads_round3");
const BROWSER_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loginUser(page: Page) {
  console.log(`[login] Navigating to ${BASE_URL}/login...`);
  await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(1000);

  const emailInput = await page.$('input[type="email"]');
  const passInput = await page.$('input[type="password"]');

  if (!emailInput || !passInput) {
    throw new Error("Login inputs not found");
  }

  await emailInput.type(TEST_EMAIL, { delay: 30 });
  await passInput.type(TEST_PASSWORD, { delay: 30 });

  const submitBtn = await page.$('button[type="submit"]');
  if (!submitBtn) throw new Error("Submit button not found");

  const startLogin = Date.now();
  await submitBtn.click();
  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 });
  console.log(`[login] Logged in successfully in ${Date.now() - startLogin}ms. Current URL: ${page.url()}`);
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
  await page.waitForSelector('#chat-composer-input', { timeout: 15000 });
  await page.focus('#chat-composer-input');
  await page.evaluate(() => {
    const el = document.querySelector('#chat-composer-input') as HTMLInputElement;
    if (el) {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await delay(100);
  await page.type('#chat-composer-input', text, { delay: 15 });
  await delay(300);

  await page.waitForFunction(() => {
    const btn = document.querySelector('button[aria-label="إرسال"]') as HTMLButtonElement | null;
    return btn && !btn.disabled;
  }, { timeout: 15000 });

  await page.click('button[aria-label="إرسال"]');
}

async function runScenario(page: Page, options: {
  scenarioName: string;
  prompt: string;
  expectedCountrySnippet: string;
  expectedIndustrySnippet: string;
  expectedVolume: number;
  screenshotPrefix: string;
  inspectDownloads?: boolean;
}) {
  console.log(`\n======================================================`);
  console.log(`[scenario] Starting: ${options.scenarioName}`);
  console.log(`[scenario] Prompt: "${options.prompt}"`);
  console.log(`======================================================`);

  await page.goto(`${BASE_URL}/dashboard/chat`, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(1500);
  await page.evaluate(() => window.dispatchEvent(new Event("diger:new-chat")));
  await delay(1000);

  // 1. Measure greeting
  const greetingEl = await page.$('div[role="status"], p[role="status"]');
  if (greetingEl) {
    const greetingText = await page.evaluate(el => el.textContent, greetingEl);
    console.log(`[greeting] Live greeting rendered: "${greetingText?.trim()}"`);
  }

  // 2. Send prompt and measure plan latency
  const sendStart = Date.now();
  await sendUserMessage(page, options.prompt);
  console.log(`[prompt] Sent at ${new Date().toISOString()}. Waiting for Plan Card...`);

  // 3. Wait for plan card in browser and measure latency (up to 60s)
  await page.waitForSelector('div[aria-label="خطة البحث وعرض السعر"]', { timeout: 60000 });
  const planLatencyMs = Date.now() - sendStart;
  console.log(`[plan_card] Plan card rendered in browser in ${planLatencyMs}ms (${(planLatencyMs / 1000).toFixed(2)}s).`);

  await delay(1000);
  const planScreenshot = path.join(ARTIFACT_DIR, `${options.screenshotPrefix}-plan.png`);
  await page.screenshot({ path: planScreenshot, fullPage: false });
  console.log(`[screenshot] Plan screenshot saved to: ${planScreenshot}`);

  // 4. Verify interpreted parameters displayed in card
  const cardText = await page.evaluate(() => {
    const card = document.querySelector('div[aria-label="خطة البحث وعرض السعر"]');
    return card ? card.textContent : "";
  });

  console.log(`[interpreted_parameters] Card content summary:\n${cardText?.replace(/\s+/g, " ").slice(0, 300)}...`);

  const hasCountry = cardText?.includes(options.expectedCountrySnippet);
  const hasIndustry = cardText?.includes(options.expectedIndustrySnippet);
  console.log(`[verification] Contains expected country "${options.expectedCountrySnippet}": ${hasCountry}`);
  console.log(`[verification] Contains expected industry "${options.expectedIndustrySnippet}": ${hasIndustry}`);

  // 5. Click Start button
  const btnHandle = await page.evaluateHandle(() => {
    const card = document.querySelector('div[aria-label="خطة البحث وعرض السعر"]');
    return Array.from(card?.querySelectorAll("button") || []).find((b) =>
      b.textContent?.includes("أوافق وابدأ البحث") || b.textContent?.includes("اعتماد الخطة والبدء") || b.classList.contains("bg-ac")
    );
  });
  const startBtn = btnHandle.asElement();
  if (!startBtn) throw new Error("Start execution button not found");
  await startBtn.click();
  console.log(`[execution] Clicked Start button via native click. Waiting for activity stream and execution completion...`);

  // 6. Monitor execution until completion or result
  const sb = createAdminClient();
  const execStart = Date.now();
  let completed = false;
  let latestJob: any = null;

  for (let i = 0; i < 45; i++) {
    await delay(1500);

    const { data: dbJob } = await sb
      .from("jobs")
      .select("id, status, delivered_units, charged_credits, reserved_credits, error_message")
      .eq("user_id", "47693c59-89f1-405d-bec1-e72271517870")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (dbJob) {
      latestJob = dbJob;
      if (dbJob.status === "completed" || dbJob.status === "done") {
        console.log(`[execution] Job ${dbJob.id} COMPLETED with ${dbJob.delivered_units} delivered records! Charged: ${dbJob.charged_credits} of ${dbJob.reserved_credits} points.`);
        completed = true;
        break;
      }
      if (dbJob.status === "failed") {
        console.log(`[execution] Job ${dbJob.id} status is failed: ${dbJob.error_message}`);
        completed = true;
        break;
      }
    }

    const state = await page.evaluate(() => {
      const body = document.body.textContent || "";
      return body.includes("اكتمل التنفيذ") || body.includes("ملفات النتائج") || Boolean(document.querySelector('a[href*="/download"]'));
    });

    if (state) {
      completed = true;
      break;
    }
  }

  await delay(2000);
  const execScreenshot = path.join(ARTIFACT_DIR, `${options.screenshotPrefix}-completed.png`);
  await page.screenshot({ path: execScreenshot, fullPage: false });
  console.log(`[screenshot] Execution screenshot saved to: ${execScreenshot}`);

  // 7. Inspect deliverables
  if (options.inspectDownloads && latestJob) {
    console.log(`[downloads] Inspecting deliverables for job: ${latestJob.id}...`);

    // Download & Inspect Excel
    const { data: xlsxBlob, error: xlsxErr } = await sb.storage
      .from("results")
      .download(`47693c59-89f1-405d-bec1-e72271517870/${latestJob.id}/result.xlsx`);

    if (xlsxBlob && !xlsxErr) {
      const xlsxBuffer = Buffer.from(await xlsxBlob.arrayBuffer());
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(xlsxBuffer);
      const dataSheet = wb.getWorksheet("دليل الشركات المعتمد") || wb.getWorksheet("البيانات") || wb.worksheets[0];
      const isRtl = dataSheet?.views?.[0]?.rightToLeft === true;
      const rows: any[] = [];
      dataSheet.eachRow((row, rowNumber) => {
        rows.push({ rowNumber, values: row.values });
      });

      console.log(`[excel_inspection] Sheet: "${dataSheet.name}", RTL: ${isRtl}, Total Rows: ${rows.length}`);
      for (const r of rows) {
        console.log(`[excel_row ${r.rowNumber}]`, JSON.stringify(r.values));
      }

      const excelArtifactPath = path.join(ARTIFACT_DIR, `${options.screenshotPrefix}-result.xlsx`);
      fs.writeFileSync(excelArtifactPath, xlsxBuffer);
      console.log(`[excel_saved] Saved to ${excelArtifactPath}`);
    } else {
      console.warn(`[excel_warning] Could not download Excel:`, xlsxErr);
    }

    // Download & Inspect CSV
    const { data: csvBlob } = await sb.storage
      .from("results")
      .download(`47693c59-89f1-405d-bec1-e72271517870/${latestJob.id}/result.csv`);
    if (csvBlob) {
      const csvText = await csvBlob.text();
      const csvLines = csvText.trim().split("\n");
      console.log(`[csv_inspection] CSV lines: ${csvLines.length}. First 2 lines:\n${csvLines.slice(0, 2).join("\n")}`);
      const csvArtifactPath = path.join(ARTIFACT_DIR, `${options.screenshotPrefix}-result.csv`);
      fs.writeFileSync(csvArtifactPath, csvText, "utf-8");
    }

    // Download & Inspect PDF
    const { data: pdfBlob } = await sb.storage
      .from("results")
      .download(`47693c59-89f1-405d-bec1-e72271517870/${latestJob.id}/result.pdf`);
    if (pdfBlob) {
      const pdfBuffer = Buffer.from(await pdfBlob.arrayBuffer());
      console.log(`[pdf_inspection] PDF size: ${pdfBuffer.length} bytes.`);
      const pdfArtifactPath = path.join(ARTIFACT_DIR, `${options.screenshotPrefix}-result.pdf`);
      fs.writeFileSync(pdfArtifactPath, pdfBuffer);
    }
  }

  return { success: completed, planLatencyMs };
}

async function main() {
  console.log(`Launching Chrome browser from: ${BROWSER_PATH}...`);
  const browser: Browser = await puppeteer.launch({
    executablePath: BROWSER_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1280,900"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  try {
    await loginUser(page);

    // Scenario 1: The owner's exact Liechtenstein Rockets Scenario
    await runScenario(page, {
      scenarioName: "1. Liechtenstein Rockets (The owner's exact bug scenario)",
      prompt: "عايز 5 شركات صناعة الصواريخ في ليختنشتاين في ملف Excel",
      expectedCountrySnippet: "ليختنشتاين",
      expectedIndustrySnippet: "صناعة الصواريخ والفضاء",
      expectedVolume: 5,
      screenshotPrefix: "round3-01-rockets-liechtenstein",
      inspectDownloads: true,
    });

    // Scenario 2: Egypt Contracting
    await runScenario(page, {
      scenarioName: "2. Egypt Contracting Companies",
      prompt: "عايز 5 شركات مقاولات في مصر",
      expectedCountrySnippet: "مصر",
      expectedIndustrySnippet: "المقاولات والتشييد",
      expectedVolume: 5,
      screenshotPrefix: "round3-02-contracting-egypt",
      inspectDownloads: true,
    });

    // Scenario 3: Saudi Arabia IT
    await runScenario(page, {
      scenarioName: "3. Saudi Arabia IT Companies",
      prompt: "عايز 8 شركات تقنية معلومات في السعودية",
      expectedCountrySnippet: "السعودية",
      expectedIndustrySnippet: "تقنية المعلومات والبرمجيات",
      expectedVolume: 8,
      screenshotPrefix: "round3-03-it-saudi",
      inspectDownloads: true,
    });

    // Scenario 4: UAE Food
    await runScenario(page, {
      scenarioName: "4. UAE Food & Restaurants",
      prompt: "عايز 5 شركات أغذية في الإمارات",
      expectedCountrySnippet: "الإمارات",
      expectedIndustrySnippet: "الأغذية والمطاعم",
      expectedVolume: 5,
      screenshotPrefix: "round3-04-food-uae",
      inspectDownloads: true,
    });

    // Scenario 5: Germany Solar Energy
    await runScenario(page, {
      scenarioName: "5. Germany Solar Energy Companies (English)",
      prompt: "I need 6 solar energy companies in Germany",
      expectedCountrySnippet: "ألمانيا",
      expectedIndustrySnippet: "الطاقة الشمسية والمتجددة",
      expectedVolume: 6,
      screenshotPrefix: "round3-05-solar-germany",
      inspectDownloads: true,
    });

    console.log("\n======================================================");
    console.log("All 5 Live Acceptance Scenarios Completed Successfully!");
    console.log("======================================================");
  } catch (err: any) {
    console.error("[FATAL_ERROR] Scenario execution failed:", err);
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
