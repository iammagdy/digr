import { redirect } from "next/navigation";

/** Top-level wallet path redirects to /dashboard/topup. */
export default function WalletRedirect() {
  redirect("/dashboard/topup");
}
