import { NextResponse } from "next/server";
import { isLlmEnabledRuntime } from "@/functions/shared/llmClient";

export const dynamic = "force-dynamic";

/** Public, boolean-only: lets the chat show the «simplified mode» banner. Never exposes provider, model or keys. */
export async function GET() {
  return NextResponse.json({ enabled: isLlmEnabledRuntime() }, { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" } });
}
