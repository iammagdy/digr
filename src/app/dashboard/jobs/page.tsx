import { redirect } from "next/navigation";

/** «طلباتي» lives at /dashboard/requests in the V7 design. */
export default function JobsRedirect() {
  redirect("/dashboard/requests");
}
