export function resolveAdminLayoutRedirect(
  user: { app_metadata?: { role?: string } } | null | undefined,
  resolved: boolean,
): string | null {
  if (!resolved) return null;
  if (!user) return "/login";
  const isAdmin = user.app_metadata?.role === "admin";
  if (!isAdmin) return "/dashboard/chat";
  return null;
}
