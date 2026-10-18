export interface AuthAccount {
  id: string;
  name: string;
  email: string;
  createdAt: string | null;
  lastSignInAt: string | null;
}

/** Read-only account facts from the auth record (name, creation date, last sign-in). Unknown ids resolve to nulls. */
export async function getAuthAccount(adminClient: any, userId: string): Promise<AuthAccount> {
  try {
    const { data, error } = await adminClient.auth.admin.getUserById(userId);
    if (!error && data?.user) {
      const u = data.user;
      const meta = (u.user_metadata || {}) as Record<string, any>;
      return {
        id: userId,
        name: String(meta.name || meta.full_name || ""),
        email: String(u.email || ""),
        createdAt: u.created_at || null,
        lastSignInAt: u.last_sign_in_at || null,
      };
    }
  } catch {
    /* fall through */
  }
  return { id: userId, name: "", email: "", createdAt: null, lastSignInAt: null };
}
