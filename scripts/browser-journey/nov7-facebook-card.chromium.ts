// SIMULATED UI check (not part of the suite; run: npx tsx scripts/browser-journey/nov7-facebook-card.chromium.ts <out-dir> after `npm run build`): the REAL AgentMissionCardBody, rendered server-side from the REAL customer view over the
import "./react-global";
// plan the REAL compiler (planByCompiler, test-account mode) makes from the Nov 7 Facebook retest's stored rows (msn_365928deea447ca8ae92: first search empty, second search with the posts), then the REAL production CSS in real Chromium at 1280, 390 and 320 px.
// No backend, no provider, no points.
import { writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { AgentMissionCardBody } from "../../src/components/mission/AgentMissionCard";
import { customerMissionView } from "../../src/lib/agentMission/customerView";
import { customerPlanView } from "../../src/lib/agentMission/plan";
import { loadTregCatalog } from "../../src/lib/treg/catalog";
import { buildShapeDigest } from "../../src/lib/modelPlanner/digest";
import { createMemoryStore } from "../../agent/src/memoryStore";
import { RAW_PATH } from "../../agent/src/gateway";
import { planByCompiler } from "../../agent/src/compiled";

const OUT = process.argv[2];
const catalog = loadTregCatalog();
const NOW = Date.parse("2026-11-06T22:17:00Z");
const REQUEST = "اجمع لي منشورين عامين من فيسبوك عن الذكاء الاصطناعي (منشورات فيديو لو متاح)، مع تعليقين حقيقيين على كل منشور، والروابط وأسماء الصفحات.";
const FULL_LINK = "https://www.facebook.com/permalink.php?story_fbid=pfbid02V4SXQw2Vc6D9FxaKnmKn8DZZ6T88NX19REzuHy89GwEt9SJTCCWsVb7g9UhVPfTKl&id=61570030318692";
const ITEMS = [
  { id: "122181051998667677", text: "⭕ #إيلون_ماسك : الذكاء الاصطناعي سيقود البشرية إلى عصر الوفرة", authorName: "العالم الجديد - يوسف بهنس ", authorUrl: "https://www.facebook.com/people/%D8%A7%D9%84%D8%B9%D8%A7%D9%84%D9%85-%D8%A7%D9%84%D8%AC%D8%AF%D9%8A%D8%AF-%D9%8A%D9%88%D8%B3%D9%81-%D8%A8%D9%87%D9%86%D8%B3/61570030318692/", createdUtc: "2026-10-20T05:57:06.000Z", url: FULL_LINK, commentCount: 281, reactionCount: 1617, shareCount: 261 },
  { id: "1545315464289711", text: "بيل غيتس يحذر: الذكاء الاصطناعي قد يجلب جائحة أسوأ من كوفيد.", authorName: "AraGeek - أراجيك", authorUrl: "https://www.facebook.com/arageek", createdUtc: "2026-11-05T14:35:22.000Z", url: "https://www.facebook.com/arageek/posts/pfbid0yXbAwXQLu3U2UePJHGqqAEve4YEPZMpvW58kpYqdPYuXaX4hdNQCFGUM7DPmoPUBl", commentCount: 189, reactionCount: 813, shareCount: 216 },
  { id: "1701176435379155", text: "منتدى للتعمّق والتعلّم في موضوع الذكاء الاصطناعي", authorName: "إسرائيل تتكلم بالعربية", authorUrl: "https://www.facebook.com/IsraelArabic", createdUtc: "2026-11-03T15:00:09.000Z", url: "https://www.facebook.com/IsraelArabic/posts/pfbid0kqd4nWc2mwA75DQatNduRLEAQwBHbC3vaNoo7XvhaLpYMary9CkE7YTdgDSPs7U1l", commentCount: 148, reactionCount: 339, shareCount: 8 },
  { id: "1022516487027532", text: "كم مرة سألت أحد نماذج الذكاء الاصطناعي سؤالًا دينيًا", authorName: "Abdallah Seye", authorUrl: "https://www.facebook.com/abdallah.seye.2025", createdUtc: "2026-06-27T03:52:21.000Z", url: "https://www.facebook.com/abdallah.seye.2025/posts/pfbid0LCAuFnswLvHuPmsJ8Bu2dZTcure1jfT8tGsRG1JGLi3HqaihdRxoeaDxwWM4xNcTl", commentCount: 103, reactionCount: 327, shareCount: 5 },
];
const comments = (post: string) => ({ success: true, comments: [1, 2, 3].map((i) => ({ id: `c_${post}_${i}`, text: `تعليق ${i}`, author: { name: `user ${i}` }, created_at: "2026-11-05T15:00:00.000Z", reactions: 1, replies_count: 0, feedback_id: `fb_${i}`, expansion_token: `tok_${i}` })), cursor: null, has_next_page: false });

(async () => {
  const store = createMemoryStore();
  let seq = 0;
  const gateway = {
    async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
      const endpointId = String(input.endpoint_id ?? "");
      const params = (input.params ?? {}) as Record<string, unknown>;
      const callId = `call_${String((seq += 1)).padStart(4, "0")}`;
      const body = endpointId === "justoneapi.x.facebook-search-post-v1" ? { code: 0, data: { results: [], cursor: null } } : endpointId === "anyapi.facebook.search_posts" ? { output: { data: { items: ITEMS } } } : endpointId === "scrapecreators.x.v1-facebook-post-comments" ? comments(String(params.url ?? "")) : null;
      const endpoint = catalog.byId.get(endpointId);
      if (!body || !endpoint) return { ok: false as const, call_id: callId, failed: true as const, http_status: 0, message: "not served" };
      await store.putFile("msn_ui_fb", RAW_PATH(callId), JSON.stringify(body), "application/json");
      const { reading } = buildShapeDigest(body, endpoint);
      return { ok: true as const, call_id: callId, http_status: 200, rows_in_page: reading.rows.length, has_more: reading.hasMore ?? null, next_cursor: reading.nextCursor ?? null, shape: null, first_rows: [], warnings: [], saved: callId };
    },
  };
  const out = await planByCompiler({ mission: { id: "msn_ui_fb", request_text: REQUEST, answer_text: null, created_at: "2026-11-06T22:16:12Z" }, gateway, store, catalog, nowMs: NOW, catalogOnly: true });
  if (out.kind !== "plan") throw new Error(`no plan: ${out.kind}`);
  const pub = customerPlanView(out.plan, { now: NOW });
  // the card shows the deepest delivered stage's samples: the posts stage is what this check is about, so the comments stage is shown as not delivered here
  const plan_public = { ...pub, stages: pub.stages.map((s) => (s.parent_key === null ? s : { ...s, sample_rows: [] })) };
  const mission = { id: "msn_ui_fb", status: "plan_ready", question_ar: null, plan_public: plan_public as never, reserved_points: 248, unit_price_points: 36, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: new Date(NOW).toISOString() };
  const view = customerMissionView({ mission, events: [] });
  const body = renderToStaticMarkup(createElement(AgentMissionCardBody, { view, isGuest: false }));
  // the production build names its stylesheet by hash; a dev build writes app/layout.css
  const cssDir = ".next/static/css";
  const css = existsSync(`${cssDir}/app/layout.css`) ? readFileSync(`${cssDir}/app/layout.css`, "utf8") : readdirSync(cssDir).filter((f) => f.endsWith(".css")).map((f) => readFileSync(`${cssDir}/${f}`, "utf8")).join("\n");
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body class="bg-bg"><main style="padding:16px">${body}</main></body></html>`;
  const results: Array<Record<string, unknown>> = [];
  const browser = await chromium.launch();
  for (const [name, width] of [["desktop", 1280], ["phone", 390], ["narrow", 320]] as const) {
    const p = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    await p.setContent(html, { waitUntil: "load" });
    await p.evaluate(() => document.querySelectorAll("details").forEach((d) => ((d as HTMLDetailsElement).open = true)));
    const m = await p.evaluate((full) => {
      const cells = Array.from(document.querySelectorAll('[data-testid="agent-samples"] td')).map((td) => td.textContent ?? "");
      const card = document.body.textContent ?? "";
      return {
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        wholeLink: cells.includes(full),
        cutLink: cells.some((c) => c.includes("story_fbid=") && !c.includes("&id=")),
        authorShown: cells.some((c) => c.includes("AraGeek")),
        authorWarning: /أسماء أصحاب الحسابات/.test(card),
        dir: document.documentElement.dir,
      };
    }, FULL_LINK);
    const checks = {
      "no sideways scroll (the long link wraps)": !m.overflowX,
      "the permalink is shown whole, with its id": m.wholeLink,
      "no cut permalink anywhere in the samples": !m.cutLink,
      "the page names are in the samples": m.authorShown,
      "no false «account names unavailable» line": !m.authorWarning,
      "rtl": m.dir === "rtl",
    };
    for (const [check, ok] of Object.entries(checks)) results.push({ viewport: name, width, check, ok });
    await p.screenshot({ path: `${OUT}/nov7-fb-card-${name}-${width}.png`, fullPage: true });
    await p.close();
  }
  await browser.close();
  writeFileSync(`${OUT}/nov7-fb-card-results.json`, JSON.stringify({ evidence: "SIMULATED (real Chromium, real card component and production CSS, the real compiler over the Nov 7 retest's stored rows: first search empty, second search with the posts); NOT production", results }, null, 1));
  const failed = results.filter((r) => r.ok !== true);
  console.log(`${results.length - failed.length}/${results.length} checks pass`);
  if (failed.length > 0) { console.log(JSON.stringify(failed, null, 1)); process.exit(1); }
})();
