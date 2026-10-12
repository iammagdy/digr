import { redirect } from "next/navigation";

/** The V7 design has no dashboard home: the app opens on the research assistant. */
export default function DashboardIndex() {
  redirect("/dashboard/chat");
}
