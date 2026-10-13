import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { Account, Client } from "node-appwrite";
import { AdminGate } from "@/components/admin/AdminGate";
import { ENDPOINT, PROJECT_ID } from "@/lib/server/adminAuth";

export const dynamic = "force-dynamic";

/**
 * Server-side guard. When the browser sends a valid Appwrite session (JWT cookie) and the account does NOT carry
 * `labels: admin`, the request is redirected before any admin markup is rendered. When no credential is present yet
 * (first paint after a hard reload), the client gate takes over; every data call is still checked on the server.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  const jwt = (jar.get("diger_jwt") ?? jar.get("digr_jwt"))?.value;
  const session = jar.get(`a_session_${PROJECT_ID}`)?.value || jar.get(`a_session_${PROJECT_ID}_legacy`)?.value;

  if (jwt || session) {
    const client = new Client().setEndpoint(ENDPOINT).setProject(PROJECT_ID);
    if (jwt) client.setJWT(decodeURIComponent(jwt)); else client.setSession(session!);
    let labels: string[] | null = null;
    try {
      labels = ((await new Account(client).get()) as { labels?: string[] }).labels ?? [];
    } catch { /* expired credential: let the client gate refresh it */ }
    if (labels && !labels.includes("admin")) redirect("/dashboard/chat");
  }

  return <AdminGate>{children}</AdminGate>;
}
