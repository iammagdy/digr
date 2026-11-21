import { redirect } from "next/navigation";

/** «المحفظة» / «شحن الرصيد» lives at /dashboard/topup. */
export default function DashboardWalletRedirect() {
  redirect("/dashboard/topup");
}
