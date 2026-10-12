import { NextRequest, NextResponse } from "next/server";
import { Storage } from "node-appwrite";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { RECEIPTS_BUCKET } from "@/lib/constants";

export const dynamic = "force-dynamic";

/** Streams a receipt to an admin. The bucket itself is never exposed to the browser. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ fileId: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { fileId } = await params;
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(fileId)) return NextResponse.json({ error: "معرّف غير صالح" }, { status: 400 });

  const storage = new Storage(auth.ctx.client);
  try {
    const [meta, bytes] = await Promise.all([
      storage.getFile({ bucketId: RECEIPTS_BUCKET, fileId }),
      storage.getFileView({ bucketId: RECEIPTS_BUCKET, fileId }),
    ]);
    return new NextResponse(new Uint8Array(bytes as ArrayBuffer), {
      headers: {
        "Content-Type": meta.mimeType || "application/octet-stream",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `inline; filename="${meta.name.replace(/[^\w.-]/g, "_")}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "الإيصال غير موجود" }, { status: 404 });
  }
}
