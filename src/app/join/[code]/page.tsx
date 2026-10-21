import { redirect } from "next/navigation";
import { registerPathForCode } from "@/lib/signupPromo";

/** `/join/CODE`: the short form for a QR code. */
export default async function JoinWithCodePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  redirect(registerPathForCode(decodeURIComponent(code)));
}
