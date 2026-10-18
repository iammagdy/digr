/**
 * One tiny live check per verified social source. It SPENDS REAL PROVIDER BUDGET: ten checks of at most five
 * rows, each call priced between USD 0.0005 and USD 0.002, so typically about USD 0.03 in total (the ceiling it
 * prints before running is the worst case if every source had to be tried). It is run by the owner, on purpose,
 * and never by an automated session.
 *
 * What it proves, per capability: the source answers, the answer is read into rows, the rows carry what the
 * next stage needs (a video link for comments of discovered videos), and what each call really cost.
 * It prints counts and column names only. It never prints a token, a header or a customer value, and it
 * never touches the database, the ledger or any customer balance.
 *
 *   TREG_LIVE=true TREG_TOKEN=... npx tsx scripts/verify/verify-social-live.ts --confirm-spend
 *
 * Without --confirm-spend it only lists what it would call.
 */

import { defaultTregAdapter, type ProviderAdapterCallInput } from "../../src/lib/server/tregAdapter";
import { estimateSocialChunkCostUsd, getSocialCapability } from "../../src/lib/socialSources";

interface Check {
  label: string;
  slug: string;
  params: Record<string, any>;
  rows: number;
  /** For composite checks: the field every row must carry. */
  expectField?: string;
}

const CHECKS: Check[] = [
  { label: "YouTube: comments of a link", slug: "social-youtube-comments", params: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }, rows: 5 },
  { label: "TikTok: comments of a link", slug: "social-tiktok-comments", params: { url: "https://www.tiktok.com/@zachking/video/7231337071831321903" }, rows: 5 },
  { label: "Facebook: comments of a post link", slug: "social-facebook-comments", params: { url: "https://www.facebook.com/reel/753347914167361" }, rows: 5 },
  { label: "TikTok: videos of a keyword", slug: "social-tiktok-videos", params: { query: "coffee" }, rows: 5 },
  { label: "TikTok: videos of a channel", slug: "social-tiktok-videos", params: { channel: "@tiktok" }, rows: 5 },
  { label: "TikTok: trending videos (Egypt)", slug: "social-tiktok-videos", params: { trending: true, region: "EG" }, rows: 5 },
  { label: "YouTube: trending shorts", slug: "social-youtube-videos", params: { trending: true }, rows: 5 },
  { label: "YouTube: videos of a keyword", slug: "social-youtube-videos", params: { query: "coffee" }, rows: 5 },
  { label: "YouTube: videos of a channel", slug: "social-youtube-videos", params: { channel: "@veritasium" }, rows: 5 },
  { label: "TikTok: trending videos WITH their comments (Egypt)", slug: "social-tiktok-comments", params: { trending: true, region: "EG", perVideo: 3, videoCount: 2 }, rows: 6, expectField: "video_url" },
];

function worstCaseUsd(): number {
  return CHECKS.reduce((sum, check) => sum + estimateSocialChunkCostUsd(getSocialCapability(check.slug)!), 0);
}

async function main() {
  const confirmed = process.argv.includes("--confirm-spend");
  console.log(`Social live check: ${CHECKS.length} checks, worst case about USD ${worstCaseUsd().toFixed(3)}.`);
  if (!confirmed) {
    for (const check of CHECKS) console.log(`  would call: ${check.label}`);
    console.log("Nothing was called. Add --confirm-spend to run it.");
    return;
  }
  if (process.env.TREG_LIVE !== "true" || !(process.env.TREG_TOKEN || process.env.TREG_API_KEY)) {
    console.error("Set TREG_LIVE=true and TREG_TOKEN in the environment first (their values are never printed).");
    process.exit(2);
  }

  let totalMicro = 0;
  let failed = 0;
  for (const check of CHECKS) {
    const input: ProviderAdapterCallInput = {
      jobId: `verify_social_${Date.now()}`,
      userId: "verify-social",
      step: 0,
      endpointId: check.slug,
      capabilitySlug: check.slug,
      method: "POST",
      params: check.params,
      paginationStrategy: "cursor",
      cursor: null,
      pageSize: check.rows,
      remainingNeeded: check.rows,
      targetVolumeMax: check.rows,
      deliveredSoFar: 0,
    };
    const started = Date.now();
    const out = await defaultTregAdapter(input);
    const ms = Date.now() - started;
    totalMicro += out.costMicro || 0;
    const columns = out.rows[0] ? Object.keys(out.rows[0]).slice(0, 14).join(", ") : "-";
    const missingField = check.expectField ? out.rows.filter((row) => !row[check.expectField!]).length : 0;
    const pass = out.ok && out.rows.length > 0 && missingField === 0;
    if (!pass) failed += 1;
    console.log(
      `${pass ? "PASS" : "FAIL"}  ${check.label}\n` +
        `      ok=${out.ok} http=${out.httpStatus} rows=${out.rows.length}/${check.rows} cost=USD ${(out.costMicro / 1e6).toFixed(5)} time=${ms}ms nextCursor=${out.nextCursor ? "yes" : "no"}` +
        `${check.expectField ? ` missing_${check.expectField}=${missingField}` : ""}\n` +
        `      columns: ${columns}${out.ok ? "" : `\n      reason: ${out.errorCode || ""} ${out.errorMessageAr || ""}`}`,
    );
  }
  console.log(`\nTotal real cost: USD ${(totalMicro / 1e6).toFixed(5)}. Passed ${CHECKS.length - failed} of ${CHECKS.length}.`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error("Social live check stopped:", error instanceof Error ? error.message : "unknown error");
  process.exit(1);
});
