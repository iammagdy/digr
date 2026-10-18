import { createAdminClient } from "@/lib/supabase/server";
import { normalizeSupportSettings, type SupportSettings } from "@/lib/supportContact";

/** Public contact details from the admin settings; empty strings when unset or unreadable. Shared by the API route and the /contact server render. */
export async function loadSupportSettings(): Promise<SupportSettings> {
  try {
    const { data } = await createAdminClient().from("settings_public").select("value").eq("key", "support").maybeSingle();
    return normalizeSupportSettings(data?.value);
  } catch {
    return { supportEmail: "", whatsappNumber: "" };
  }
}
