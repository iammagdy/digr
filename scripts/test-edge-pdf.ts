import puppeteer from "puppeteer-core";
import * as path from "path";
import * as fs from "fs";

const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

async function main() {
  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--headless=new",
      "--enable-features=PdfOopif",
      "--allow-file-access-from-files",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1800, deviceScaleFactor: 1 });
    const pdfPath = path.resolve("artifacts_test/iam_megz_6aca1d11003678efd3c5.pdf");
    console.log("Navigating to PDF:", `file://${pdfPath}`);
    await page.goto(`file://${pdfPath}`, { waitUntil: "load" });
    await new Promise((r) => setTimeout(r, 2000));
    await page.screenshot({ path: "iam_megz_pdf_preview.png" });
    await page.screenshot({ path: "C:\\Users\\lenovo\\.gemini\\antigravity\\brain\\b6f21146-6cdf-4686-bafb-7c54799f4945\\iam_megz_verified_pdf.png" });
    console.log("Screenshot saved to iam_megz_pdf_preview.png and artifact folder!");
  } catch (err: any) {
    console.error("Error:", err.message);
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
