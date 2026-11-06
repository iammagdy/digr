// SIMULATED UI check (not part of the suite; run: npx tsx scripts/browser-journey/nov6-card-ui.chromium.ts <out-dir> after `npm run build`): the REAL AgentMissionCardBody, rendered server-side from the REAL customer view over a compiled plan of the stored X request with no replies card,
import "./react-global";
// then the REAL production CSS (.next/static/css/app/layout.css) in real Chromium at 1280, 390 and 320 px. No backend, no provider, no points.
import { writeFileSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { AgentMissionCardBody, APPROVE_WITHOUT_UNSERVED_AR, SAMPLES_TITLE_AR, UNSERVED_CHOICE_AR } from "../../src/components/mission/AgentMissionCard";
import { customerMissionView } from "../../src/lib/agentMission/customerView";
import { customerPlanView } from "../../src/lib/agentMission/plan";
import { buildAsk } from "../../src/lib/agentMission/foundation/ask";
import { compilePlan, parentInputs } from "../../src/lib/agentMission/foundation/compilePlan";
import { cardOf, TOOL_CARDS } from "../../src/lib/agentMission/foundation/toolCards";
import { loadTregCatalog } from "../../src/lib/treg/catalog";

const OUT = process.argv[2];
const catalog = loadTregCatalog();
const AT = Date.parse("2026-11-06T18:58:24Z");
const REQUEST = "اجمع لي منشورين عامين من إكس عن الذكاء الاصطناعي، مع ردين حقيقيين على كل منشور، والروابط وأسماء الحسابات.";
const card = cardOf("anyapi.x.search.posts")!;
const it = (id: string, text: string, isReply: boolean, replies: number) => ({ id, text, authorName: "synthetic", authorUsername: "synthetic", authorFollowers: 1, createdUtc: "2026-11-06T17:00:00.000Z", url: `https://x.com/i/web/status/${id}`, isReply, lang: "ar", likeCount: 3, replyCount: replies, retweetCount: 0, viewCount: 100 });
const page = { output: { data: { items: [it("2118780026737041638", "@popyou21 اسألي الذكاء الاصطناعي", true, 0), it("9000000000000000001", "synthetic: الذكاء الاصطناعي وسوق العمل", false, 6), it("9000000000000000002", "synthetic: أدوات الذكاء الاصطناعي للطلاب", false, 3)], nextCursor: null } } };
const ask = buildAsk(REQUEST, null, AT);
const r = compilePlan({ ask, pool: { card, params: parentInputs(card, ask), pages: [{ callId: "call_0001", page }] }, exposure: () => undefined, capabilityOf: (id) => catalog.byId.get(id)?.capability ?? null, cards: TOOL_CARDS.filter((c) => c.role !== "tweet.replies"), nowMs: AT });
if (!r.ok) throw new Error(r.reason);
const mission = { id: "msn_ui", status: "plan_ready", question_ar: null, plan_public: customerPlanView(r.plan) as never, reserved_points: 200, unit_price_points: 100, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: new Date(AT).toISOString() };
const view = customerMissionView({ mission, events: [] });
const body = renderToStaticMarkup(createElement(AgentMissionCardBody, { view, isGuest: false }));
const css = readFileSync(".next/static/css/app/layout.css", "utf8");
const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body class="bg-bg"><main style="padding:16px">${body}</main></body></html>`;
const results: Array<Record<string, unknown>> = [];
(async () => {
  const browser = await chromium.launch();
  for (const [name, width] of [["desktop", 1280], ["phone", 390], ["narrow", 320]] as const) {
    const p = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    await p.setContent(html, { waitUntil: "load" });
    await p.evaluate(() => document.querySelectorAll("details").forEach((d) => ((d as HTMLDetailsElement).open = true)));
    const m = await p.evaluate(() => ({
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      approve: document.querySelector('[data-testid="agent-approve"]')?.textContent ?? null,
      approveVisible: (() => { const b = document.querySelector('[data-testid="agent-approve"]') as HTMLElement | null; if (!b) return false; const rc = b.getBoundingClientRect(); return rc.width > 0 && rc.left >= 0 && rc.right <= window.innerWidth; })(),
      unserved: document.querySelector('[data-testid="agent-unserved"]')?.textContent ?? null,
      samples: document.querySelector('[data-testid="agent-samples"]')?.getAttribute("aria-label") ?? null,
      samplesNote: Boolean(document.querySelector('[data-testid="agent-samples-note"]')),
      dir: document.documentElement.dir,
    }));
    const checks = {
      "no sideways scroll": !m.overflowX,
      "approve names the scope decision": m.approve === APPROVE_WITHOUT_UNSERVED_AR,
      "approve fully on screen": m.approveVisible,
      "excluded step and its choice shown": Boolean(m.unserved && m.unserved.includes("الردود") && m.unserved.includes(UNSERVED_CHOICE_AR)),
      "samples labelled preliminary": m.samples === SAMPLES_TITLE_AR && m.samplesNote,
      "rtl": m.dir === "rtl",
    };
    for (const [check, ok] of Object.entries(checks)) results.push({ viewport: name, width, check, ok });
    await p.screenshot({ path: `${OUT}/card-${name}-${width}.png`, fullPage: true });
    await p.close();
  }
  await browser.close();
  writeFileSync(`${OUT}/card-ui-results.json`, JSON.stringify({ evidence: "SIMULATED (real Chromium, real card component and production CSS, compiled plan of the stored X request with no replies card; synthetic original tweets); NOT production", results }, null, 1));
  console.log(results.filter((x) => x.ok).length, "of", results.length, "ok");
  for (const x of results) if (!x.ok) console.log("FAIL", JSON.stringify(x));
})();
