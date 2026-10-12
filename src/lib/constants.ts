/** Appwrite resource IDs — centralised so nothing is scattered across the codebase */

export const DATABASE_ID = "digr";

// Collections (public)
export const PROFILES_COLLECTION = "profiles";
export const CREDIT_LEDGER_COLLECTION = "credit_ledger";
export const TOPUPS_COLLECTION = "topups";
export const TEMPLATES_COLLECTION = "templates";
export const JOBS_COLLECTION = "jobs";
export const JOB_EVENTS_COLLECTION = "job_events";
export const SETTINGS_PUBLIC_COLLECTION = "settings_public";
export const NOTIFICATIONS_COLLECTION = "notifications";
export const ADMIN_AUDIT_LOG_COLLECTION = "admin_audit_log";
export const PROVIDER_COSTS_COLLECTION = "provider_costs";

// Collections (server-only — referenced in Functions, not client code)
export const TEMPLATES_PRIVATE_COLLECTION = "templates_private";
export const JOBS_INTERNAL_COLLECTION = "jobs_internal";
export const JOB_CALLS_COLLECTION = "job_calls";
export const SETTINGS_COLLECTION = "settings";

// Storage buckets
export const RESULTS_BUCKET = "results";
export const RECEIPTS_BUCKET = "receipts";
export const PARTIALS_BUCKET = "partials";

// Help links in the app sidebar. Overridable per deployment; default to the support mailbox.
export const SUPPORT_URL = process.env.NEXT_PUBLIC_SUPPORT_URL || "mailto:support@digr.app";
export const HELP_CENTER_URL = process.env.NEXT_PUBLIC_HELP_URL || SUPPORT_URL;
