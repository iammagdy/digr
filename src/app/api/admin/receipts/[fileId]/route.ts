import { NextRequest, NextResponse } from "next/server";

import { authenticateAdmin } from "@/lib/server/adminAuth";
import { createAdminClient } from "../../../../../lib/supabase/server";
import { RECEIPTS_BUCKET } from "@/lib/constants";

export const dynamic = "force-dynamic";

function guessMime(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

/** Streams a receipt to an admin. The bucket itself is never exposed to the browser. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ fileId: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { fileId: rawFileId } = await params;
  const decoded = decodeURIComponent(rawFileId || "");
  if (!decoded || decoded.includes("..") || !/^[A-Za-z0-9_./-]{1,180}$/.test(decoded)) {
    return NextResponse.json({ error: "معرّف غير صالح" }, { status: 400 });
  }

  // 1. Try Supabase Storage first
  try {
    const adminClient = createAdminClient();
    const { data: blob, error } = await adminClient.storage.from(RECEIPTS_BUCKET).download(decoded);
    if (!error && blob) {
      const arrayBuffer = await blob.arrayBuffer();
      const baseName = decoded.split("/").pop() || "receipt";
      return new NextResponse(new Uint8Array(arrayBuffer), {
        headers: {
          "Content-Type": blob.type || guessMime(baseName),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": `inline; filename="${baseName.replace(/[^\w.-]/g, "_")}"`,
        },
      });
    }
    return NextResponse.json({ error: "الإيصال غير موجود" }, { status: 404 });
  } catch {
    return NextResponse.json({ error: "الإيصال غير موجود" }, { status: 404 });
  }
}
