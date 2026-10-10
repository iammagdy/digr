import puppeteer from "puppeteer-core";
import * as path from "path";

const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE_URL = "http://localhost:3000";
const ARTIFACT_DIR = "C:\\Users\\lenovo\\.gemini\\antigravity\\brain\\b6f21146-6cdf-4686-bafb-7c54799f4945";

async function main() {
  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=ar"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 850 });
    await page.goto(`${BASE_URL}/dashboard/chat`, { waitUntil: "networkidle0" });

    // Open onboarding modal via persona button
    const personaBtn = await page.$('button::-p-text("⚙️")');
    if (personaBtn) {
      await personaBtn.click();
      await new Promise((r) => setTimeout(r, 600));
    }

    const modalPathDesktop = path.join(ARTIFACT_DIR, "phase_b_onboarding_1280px.png");
    await page.screenshot({ path: modalPathDesktop });
    console.log(`✓ Saved ${modalPathDesktop}`);

    // Mobile viewport
    await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
    await new Promise((r) => setTimeout(r, 600));
    const modalPathMobile = path.join(ARTIFACT_DIR, "phase_b_onboarding_375px.png");
    await page.screenshot({ path: modalPathMobile });
    console.log(`✓ Saved ${modalPathMobile}`);
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
