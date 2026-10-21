import { redirect } from "next/navigation";
import { registerPathForCode } from "@/lib/signupPromo";

/** The path a QR code or a shared link points to: straight to sign-up, with the invitation code (if any) already in its field. */
export default async function JoinPage({ searchParams }: { searchParams: Promise<{ code?: string; promo?: string }> }) {
  const params = await searchParams;
  redirect(registerPathForCode(params.code ?? params.promo));
}
