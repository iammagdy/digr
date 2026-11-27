import { NextResponse } from "next/server";
import { RETIRED_QUOTE_AR } from "@/lib/chat/retiredQuoteCopy";

const retiredQuoteActions = new Set(["accept-quote", "edit-plan", "sample-remainder"]);

// Cached chat pages still parse JSON from these discontinued actions.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ retiredQuoteAction: string }> },
) {
  const { retiredQuoteAction } = await params;
  if (!retiredQuoteActions.has(retiredQuoteAction)) {
    return NextResponse.json({ success: false }, { status: 404 });
  }
  return NextResponse.json({ success: false, error: RETIRED_QUOTE_AR }, { status: 410 });
}
