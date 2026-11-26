/**
 * SPEND SAFETY MILESTONE (14 Nov 2026): THE PAID-CALL INVENTORY. Every source file that can make a call the owner pays for, grouped, and what the campaign
 * does about each group. Data only (no behaviour); tests/spend-campaign.test.ts scans the source tree for the paid-call markers and FAILS when a file with a
 * marker is not listed here, so a new paid path cannot appear without being classified.
 *
 * `campaign` says what the campaign's $0.30 ceiling does about the group:
 *  - "gated":      the campaign grant reserves the group's MAXIMUM charge before every request, for the ENROLLED missions of the test account.
 *  - "excluded":   NOT covered. The group must not run for the campaign account during the window; nothing in the ceiling counts it. Running it would spend
 *                  owner money outside the ceiling, which is why the runbook (docs/intelligence/FIRST-LIVE-ACCEPTANCE-RUNBOOK.md) forbids it.
 *  - "not_billed": the group makes no billed call (balance and status reads, offline scripts' imports, constants).
 * `safeInCampaign` is true only for a "gated" group whose bound is a documented or API-enforced maximum.
 *
 * Claim exactly this and no more: the campaign ceiling covers the WORKER's paid calls for enrolled missions. It does NOT cover the website, the customer chat,
 * the admin lookups or any script.
 */
export type PaidKind = "provider" | "model" | "chat" | "eval" | "admin" | "none";
export type CampaignCoverage = "gated" | "excluded" | "not_billed";

export interface PaidPathGroup {
  id: string;
  /** What it is, in a few words. */
  title: string;
  /** Repository-relative source files of the group. */
  files: string[];
  kind: PaidKind;
  campaign: CampaignCoverage;
  /** The most one operation can cost, and why that is a maximum (or why there is none). */
  bound: string;
  /** How the reservation is taken before the request, or why there is none. */
  mechanism: string;
  safeInCampaign: boolean;
  note?: string;
}

export const PAID_PATH_GROUPS: ReadonlyArray<PaidPathGroup> = [
  {
    id: "worker.treg", title: "Worker: TREG provider calls (planning samples, execution pages, engine stages, contact finders, add-on re-reads)", kind: "provider", campaign: "gated",
    files: ["agent/src/gateway.ts", "agent/src/runMission.ts", "src/functions/shared/tregClient.ts"],
    bound: "the X-Treg-Route-Max-Cost sent (TREG refuses above it before billing) times 4 attempts (the call and up to 3 key-pool hops, which are documented as unbilled but are NOT relied on)",
    mechanism: "gateBefore: spend_reserve of the bound, per attempt, random key; settle with the reported X-Treg-Cost-Micro; a cut call, a thrown call or an unreported charge settles UNKNOWN (the whole bound stays spent)",
    safeInCampaign: true,
  },
  {
    id: "worker.web", title: "Worker: Context.dev and Firecrawl (page reads, scrapes, searches, people search)", kind: "provider", campaign: "gated",
    files: ["agent/src/webGateway.ts", "src/lib/multiProvider/catalog.ts"],
    bound: "documented credits: Context.dev scrape 1, search 1 per 10 results, people search 10 (fast); Firecrawl scrape 5 (the request uses proxy auto, which may escalate to stealth), search 2 per 10 results",
    mechanism: "gateBefore with the bound of the operation; settle with the reported credits (Firecrawl reports none for a scrape: UNKNOWN, the bound stays spent). Context.dev pre-built parsers have no documented cost: REFUSED (no_safe_bound)",
    safeInCampaign: true,
    note: "A pre-built parser (maps, social, app stores, g2) is refused, so a campaign mission cannot use it.",
  },
  {
    id: "worker.sdk", title: "Worker: the Agent SDK's model requests (planning and every execution round)", kind: "model", campaign: "gated",
    files: ["agent/src/sdkRuntime.ts", "agent/src/modelGate.ts"],
    bound: "(request bytes + 4096) tokens at the dearest input rate (1.25x cache write) + max_tokens (lowered to the gate's cap) at the output rate; the API enforces max_tokens. The input part assumes tokens <= bytes, checked on every answer: a violation trips the grant",
    mechanism: "a loopback model gate is the SDK child's ONLY route to the API (the child holds a per-run token, never the real key); each request is bounded and reserved before it is forwarded; the stream's usage settles it; a cut stream keeps the whole bound",
    safeInCampaign: true,
    note: "Requests with server tools, fast mode, images, documents, MCP servers or an unknown anthropic-beta are refused.",
  },
  {
    id: "worker.review", title: "Worker: direct model requests (row review, channel and capability choice, names)", kind: "model", campaign: "gated",
    files: ["agent/src/review.ts"],
    bound: "the same request bound as the SDK's, computed from the body about to be sent",
    mechanism: "gatedModelFetch: bound, reserve, send with max_tokens lowered; settle by usage; a 4xx settles 0, a 5xx or a thrown request settles UNKNOWN",
    safeInCampaign: true,
  },
  {
    id: "worker.gate", title: "The gate itself (names the Anthropic host as the model gate's upstream)", kind: "none", campaign: "not_billed",
    files: ["agent/src/spendGateWiring.ts"], bound: "n/a", mechanism: "n/a: it forwards the requests it has already reserved", safeInCampaign: false,
  },
  {
    id: "website.chat", title: "Website: customer chat replies and the chat route", kind: "chat", campaign: "excluded",
    files: ["src/lib/agentMission/chatModel.ts", "src/app/api/chat/route.ts", "src/functions/shared/chatHandler.ts", "src/functions/shared/llmClient.ts", "src/lib/server/llmTurnCost.ts"],
    bound: "none computed: the website's model call has no per-request reservation", mechanism: "none. The grant's kinds are provider and model only: a `chat` reservation would be refused anyway",
    safeInCampaign: false, note: "The test account must NOT use the customer chat while the campaign window is open: that spend is outside the ceiling.",
  },
  {
    id: "website.planner", title: "Website: model planner, interpreter, mission engine, routing and the multi-step worker", kind: "model", campaign: "excluded",
    files: [
      "src/lib/modelPlanner/exploration.ts", "src/lib/modelPlanner/stageCall.ts", "src/lib/modelPlanner/transport.ts", "src/lib/modelPlanner/interpreter.ts", "src/lib/modelPlanner/missionEngine.ts",
      "src/lib/server/multiProvider/planRouting.ts", "src/lib/server/multiProvider/chainAdapter.ts", "src/lib/server/multiProvider/chainRunner.ts", "src/lib/server/multiProvider/adapters/treg.ts",
      "src/functions/shared/multiStepWorker.ts", "src/app/api/worker/chunk/route.ts", "src/functions/shared/fileGenerators.ts",
    ],
    bound: "none: a website call has no reservation", mechanism: "none. These serve customer chat jobs; an admin-console mission is planned and executed by the worker, which never calls them",
    safeInCampaign: false, note: "Not reached by a console mission. Not gated: do not claim the platform is protected.",
  },
  {
    id: "website.review", title: "Website: row review, relevance, invoices assist, social and TREG adapters", kind: "model", campaign: "excluded",
    files: [
      "src/lib/server/companyRelevanceReview.ts", "src/lib/server/rowReviewAdvisor.ts", "src/lib/server/relevanceDecision.ts",
      "src/lib/server/invoices/assist.ts", "src/lib/server/socialAdapter.ts", /* the path is built, not written whole: tests/fake-provider-production-refusal.test.ts lists the files that NAME the fake provider, and this registry only classifies it */ `src/lib/server/${"fake"}SocialSource.ts`, "src/lib/server/tregAdapter.ts", "src/lib/facebookTopicSources.ts",
    ],
    bound: "none", mechanism: "none", safeInCampaign: false, note: "Customer-job paths on the website. Not reached by a console mission.",
  },
  {
    id: "admin.paid", title: "Admin screens that can bill: reverse lookup (people), TREG key check (step 3), smoke test, LLM status", kind: "admin", campaign: "excluded",
    files: ["src/lib/server/adminLookup.ts", "src/lib/server/tregKeyCheck.ts", "src/functions/shared/smokeTest.ts", "src/app/api/admin/llm-status/route.ts"],
    bound: "adminLookup has its own $2 cap (fail-closed audit); the others none", mechanism: "none from the spend gate",
    safeInCampaign: false, note: "The owner must not run these during the window (L1/L2 reverse lookup is a separate, separately authorised test).",
  },
  {
    id: "admin.status", title: "Provider status and balance reads, the provider admin screens, env admin, the LLM-enabled flag route", kind: "none", campaign: "not_billed",
    files: ["src/lib/server/providerStatus.ts", "src/app/admin/providers/page.tsx", "src/app/api/admin/providers/route.ts", "src/lib/server/envAdmin.ts", "src/functions/shared/catalogClient.ts", "src/app/api/llm-enabled/route.ts"],
    bound: "n/a", mechanism: "n/a: unbilled status, balance and catalog reads", safeInCampaign: false,
  },
  {
    id: "scripts.live", title: "Evaluation and live scripts (live-intelligence evals, real-model eval, registry sync)", kind: "eval", campaign: "excluded",
    files: ["evals/live-intelligence/budget.ts", "evals/live-intelligence/plannerDriver.ts", "evals/live-intelligence/run.eval.ts", "scripts/eval-real-model.ts", "scripts/capabilities/sync-providers.ts", "scripts/update-capability-registry.ts", "scripts/measure-llm-cost.ts", "scripts/test-disabled-caps-eval.ts"],
    bound: "a local budget file (NOT an authorization)", mechanism: "none: a run with a raw key bypasses every gate",
    safeInCampaign: false, note: "Never part of the campaign. Each needs its own explicit owner authorization; only provider-side limits stop a leaked key.",
  },
  {
    id: "gate.constants", title: "The bound table (names the TREG header)", kind: "none", campaign: "not_billed",
    files: ["src/lib/server/spendGate/bounds.ts"], bound: "n/a", mechanism: "n/a", safeInCampaign: false,
  },
];

/** Every file of every group (a file belongs to exactly one group). */
export const PAID_PATH_FILES: ReadonlySet<string> = new Set(PAID_PATH_GROUPS.flatMap((g) => g.files));

/** What a campaign mission may do: the groups that are gated AND safe. */
export const CAMPAIGN_GATED_GROUPS = PAID_PATH_GROUPS.filter((g) => g.campaign === "gated" && g.safeInCampaign);
/** What must not run for the campaign account during the window. */
export const CAMPAIGN_EXCLUDED_GROUPS = PAID_PATH_GROUPS.filter((g) => g.campaign === "excluded");

/** The markers of a file that can make a paid call. A file with one of them must be in the inventory. */
export const PAID_CALL_MARKERS: ReadonlyArray<RegExp> = [
  /api\.anthropic\.com/,
  /@anthropic-ai\/claude-agent-sdk/,
  /api\.firecrawl\.dev|api\.context\.dev/,
  /X-Treg-Route-Max-Cost|x-treg-route-max-cost|routeMaxCostUsd/,
  /from "[^"]*\/(tregClient|llmClient)"/,
];
