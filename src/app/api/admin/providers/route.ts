import { NextRequest, NextResponse } from "next/server";
import { Query } from "node-appwrite";
import { getLlmStatusSnapshot } from "@/functions/shared/llmClient";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { LLM_KEY_ENV, LLM_MODEL_ENV, last4 } from "@/lib/server/providerEnv";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { tables } = auth.ctx;

  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const since = startOfDay.toISOString();

  let lastLlmUsage: string | null = null;
  let lastTregCall: string | null = null;
  let tregCallsToday = 0;
  let llmCallsToday = 0;
  let llmCostToday = 0;
  try {
    const u = await tables.listRows({ databaseId: "digr", tableId: "llm_usage", queries: [Query.orderDesc("createdAt"), Query.limit(1)] });
    lastLlmUsage = (u.rows[0] as any)?.createdAt ?? null;
  } catch { /* table not provisioned */ }
  try {
    const c = await tables.listRows({ databaseId: "digr", tableId: "job_calls", queries: [Query.orderDesc("createdAt"), Query.limit(1)] });
    lastTregCall = (c.rows[0] as any)?.createdAt ?? null;
    const today = await tables.listRows({ databaseId: "digr", tableId: "job_calls", queries: [Query.greaterThanEqual("createdAt", since), Query.limit(1)] });
    tregCallsToday = today.total;
  } catch { /* none */ }
  try {
    const today = await tables.listRows({ databaseId: "digr", tableId: "provider_costs", queries: [Query.equal("provider", "llm"), Query.greaterThanEqual("at", since), Query.limit(100)] });
    llmCallsToday = today.total;
    llmCostToday = today.rows.reduce((a: number, r: any) => a + (r.costEgp || 0), 0);
  } catch { /* none */ }

  const snap = getLlmStatusSnapshot(lastLlmUsage);
  const keyEnv = LLM_KEY_ENV[snap.provider] ?? "";

  return NextResponse.json({
    llm: {
      enabled: snap.llm_enabled,
      provider: snap.provider,
      model: snap.model,
      keyEnv,
      modelEnv: LLM_MODEL_ENV[snap.provider],
      keyConfigured: snap.provider === "fake" ? false : snap.key_present,
      keyLast4: keyEnv ? last4(process.env[keyEnv]) : null,
      lastUsage: snap.last_llm_usage_timestamp,
      fallbackReason: snap.last_fallback_reason,
      callsToday: llmCallsToday,
      costTodayEgp: llmCostToday,
    },
    treg: {
      live: process.env.TREG_LIVE === "true",
      tokenConfigured: Boolean((process.env.TREG_TOKEN || process.env.TREG_API_KEY || "").trim()),
      tokenLast4: last4(process.env.TREG_TOKEN || process.env.TREG_API_KEY),
      baseUrl: (process.env.TREG_BASE_URL || "https://treg.to").replace(/\/$/, ""),
      lastCall: lastTregCall,
      callsToday: tregCallsToday,
    },
  });
}
