import { redirect } from "next/navigation";

// Replaced by the overview page in the next step; keeps /admin valid in the meantime.
export default function AdminIndex() {
  redirect("/admin/topups");
}
