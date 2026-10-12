src/app/admin/topups/page.tsx:4:import { Functions } from "appwrite";
src/app/api/admin/alerts/route.ts:2:import { Query } from "node-appwrite";
src/app/api/admin/audit/route.ts:2:import { Query } from "node-appwrite";
src/app/api/admin/finance/route.ts:2:import { Query } from "node-appwrite";
src/app/api/admin/jobs/route.ts:2:import { Query } from "node-appwrite";
src/app/api/admin/llm-status/route.ts:2:import { Client as ServerClient, TablesDB, Client as UserClient, Account, Query } from "node-appwrite";
src/app/api/admin/llm-status/route.ts:114:      const userAccount = new Account(userClient);
src/app/api/admin/llm-status/route.ts:144:        const tables = new TablesDB(serverClient);
src/app/api/admin/provider-balance/route.ts:2:import { Client as ServerClient, TablesDB, Client as UserClient, Account } from "node-appwrite";
src/app/api/admin/provider-balance/route.ts:114:      const userAccount = new Account(userClient);
src/app/api/admin/provider-balance/route.ts:137:    let tables: TablesDB | null = null;
src/app/api/admin/provider-balance/route.ts:144:        tables = new TablesDB(serverClient);
src/app/api/admin/providers/route.ts:2:import { Query } from "node-appwrite";
src/app/api/admin/receipts/[fileId]/route.ts:2:import { Storage } from "node-appwrite";
src/app/api/admin/settings/route.ts:2:import { Query } from "node-appwrite";
src/app/api/admin/smoke/route.ts:2:import { Client as UserClient, Account } from "node-appwrite";
src/app/api/admin/smoke/route.ts:58:    const userAccount = new Account(userClient);
src/app/api/admin/stats/route.ts:2:import { Query } from "node-appwrite";
src/app/api/admin/topups/route.ts:2:import { Query } from "node-appwrite";
src/app/api/admin/users/[id]/route.ts:2:import { Query } from "node-appwrite";
src/app/api/admin/users/route.ts:2:import { Query } from "node-appwrite";
src/app/api/chat/edit-plan/route.ts:2:import { Client as ServerClient, TablesDB, Client as UserClient, Account } from "node-appwrite";
src/app/api/chat/edit-plan/route.ts:23:const tables = new TablesDB(serverClient);
src/app/api/chat/edit-plan/route.ts:60:      const userAccount = new Account(userClient);
src/app/api/chat/metadata/route.ts:2:import { Account, Client, TablesDB } from "node-appwrite";
src/app/api/chat/metadata/route.ts:23:      await new Account(userClient).get();
src/app/api/chat/metadata/route.ts:34:    const capabilities = await getEnabledCapabilities(new TablesDB(serverClient));
src/app/api/chat/route.ts:2:import { Client as ServerClient, TablesDB, Client as UserClient, Account } from "node-appwrite";
src/app/api/chat/route.ts:105:        const userAccount = new Account(userClient);
src/app/api/chat/route.ts:136:    // Determine tables DAL: Supabase Admin client or Appwrite TablesDB
src/app/api/chat/route.ts:142:        tables = new TablesDB(serverClient);
src/app/api/chat/route.ts:145:      tables = new TablesDB(serverClient);
src/app/api/jobs/[id]/artifacts/route.ts:2:import { Account, Client, ID, Permission, Query, Role, Storage, TablesDB } from "node-appwrite";
src/app/api/jobs/[id]/artifacts/route.ts:12:const tables = new TablesDB(serverClient);
src/app/api/jobs/[id]/artifacts/route.ts:44:    const account = new Account(userClient);
src/app/api/jobs/[id]/data/route.ts:2:import { Client as ServerClient, TablesDB, Storage, Client as UserClient, Account } from "node-appwrite";
src/app/api/jobs/[id]/data/route.ts:13:const tables = new TablesDB(serverClient);
src/app/api/jobs/[id]/data/route.ts:43:      const userAccount = new Account(userClient);
src/app/api/jobs/[id]/methodology/route.ts:2:import { Client as ServerClient, TablesDB, Storage, Client as UserClient, Account } from "node-appwrite";
src/app/api/jobs/[id]/methodology/route.ts:14:const tables = new TablesDB(serverClient);
src/app/api/jobs/[id]/methodology/route.ts:46:      const userAccount = new Account(userClient);
src/app/api/onboarding/route.ts:2:import { Client as ServerClient, TablesDB, Client as UserClient, Account, Query } from "node-appwrite";
src/app/api/onboarding/route.ts:14:const tables = new TablesDB(serverClient);
src/app/api/onboarding/route.ts:56:      const userAccount = new Account(userClient);
src/app/dashboard/chat/page.tsx:10:import { Storage, Query } from "appwrite";
src/app/dashboard/requests/page.tsx:5:import { Query } from "appwrite";
src/app/dashboard/settings/page.tsx:94:  async function deleteAccount() {
src/app/dashboard/topup/TopupForm.tsx:4:import { Functions, ID, Permission, Role, Storage } from "appwrite";
src/app/dashboard/topup/page.tsx:5:import { Query } from "appwrite";
src/functions/approve-topup/package.json:6:    "node-appwrite": "^29.2.0"
src/functions/approve-topup/src/main.ts:1:import { Client, TablesDB, Users } from "node-appwrite";
src/functions/approve-topup/src/main.ts:36:  const tables = new TablesDB(client);
src/functions/create-job/package.json:6:    "node-appwrite": "^29.2.0"
src/functions/create-job/src/main.ts:1:import { Client, TablesDB, Functions, Query, Permission, Role, ID } from "node-appwrite";
src/functions/create-job/src/main.ts:31:  const tables = new TablesDB(client);
src/functions/job-worker/package.json:6:    "node-appwrite": "^29.2.0"
src/functions/job-worker/src/main.ts:1:import { Client, TablesDB, Storage } from "node-appwrite";
src/functions/job-worker/src/main.ts:26:  const tables = new TablesDB(client);
src/functions/on-user-create/package.json:6:    "node-appwrite": "^29.2.0"
src/functions/on-user-create/src/main.ts:1:import { Client, TablesDB, Permission, Role } from "node-appwrite";
src/functions/on-user-create/src/main.ts:15:  const tables = new TablesDB(client);
src/functions/purge-deleted-accounts/package.json:6:    "node-appwrite": "^29.2.0"
src/functions/purge-deleted-accounts/src/main.ts:1:import { Client, TablesDB, Storage, Users, Query } from "node-appwrite";
src/functions/purge-deleted-accounts/src/main.ts:11:async function deleteAll(tables: TablesDB, tableId: string, queries: string[]) {
src/functions/purge-deleted-accounts/src/main.ts:29:  const tables = new TablesDB(client);
src/functions/request-account-deletion/package.json:6:    "node-appwrite": "^29.2.0"
src/functions/request-account-deletion/src/main.ts:1:import { Client, TablesDB, Users, Query } from "node-appwrite";
src/functions/request-account-deletion/src/main.ts:19:  const tables = new TablesDB(client);
src/functions/shared/artifactVersions.ts:1:import { Query, TablesDB } from "node-appwrite";
src/functions/shared/artifactVersions.ts:18:export async function recordInitialArtifactVersion(tables: TablesDB, input: InitialArtifactVersionInput): Promise<void> {
src/functions/shared/auditLog.ts:1:import { ID, Permission, Role, TablesDB } from "node-appwrite";
src/functions/shared/auditLog.ts:22:export async function writeAudit(client: ConstructorParameters<typeof TablesDB>[0], e: AuditEntry, log?: (m: string) => void): Promise<void> {
src/functions/shared/auditLog.ts:24:    await new TablesDB(client).createRow({
src/functions/shared/briefManager.ts:1:import { TablesDB, Query } from "node-appwrite";
src/functions/shared/briefManager.ts:454:  tables: TablesDB | null | undefined,
src/functions/shared/capabilityRegistry.ts:1:import { TablesDB } from "node-appwrite";
src/functions/shared/capabilityRegistry.ts:414:  tables?: TablesDB,
src/functions/shared/capabilityRegistry.ts:466:export async function getEnabledCapabilities(tables: TablesDB): Promise<Capability[]> {
src/functions/shared/chatHandler.ts:2:import { TablesDB, ID, Query } from "node-appwrite";
src/functions/shared/chatHandler.ts:544:  private tables: TablesDB;
src/functions/shared/chatHandler.ts:547:  constructor(tables: TablesDB) {
src/functions/shared/ledger.ts:1:import { TablesDB, Query, Permission, Role } from "node-appwrite";
src/functions/shared/ledger.ts:10:export async function calculateBalance(tables: TablesDB, userId: string): Promise<number> {
src/functions/shared/ledger.ts:45:  tables: TablesDB,
src/functions/shared/ledger.ts:72:  tables: TablesDB,
src/functions/shared/ledger.ts:101:  tables: TablesDB,
src/functions/shared/ledger.ts:124:  tables: TablesDB,
src/functions/shared/ledger.ts:159:  tables: TablesDB,
src/functions/shared/ledger.ts:189:  tables: TablesDB,
src/functions/shared/ledger.ts:213:  tables: TablesDB,
src/functions/shared/multiStepWorker.ts:2:import { TablesDB, Storage, Permission, Role, ID, Query } from "node-appwrite";
src/functions/shared/multiStepWorker.ts:320:  tables: TablesDB,
src/functions/shared/multiStepWorker.ts:1064:  tables: TablesDB,
src/functions/shared/multiStepWorker.ts:1157:  tables: TablesDB,
src/functions/shared/multiStepWorker.ts:1209:      "1. ╪º┘ü╪¬╪¡ ┘ä┘ê╪¡╪⌐ ╪¬╪¡┘â┘à Appwrite -> Databases -> digr -> ╪¼╪»┘ê┘ä jobs ┘ê╪¡╪»╪» ┘à╪╣╪▒┘æ┘ü ╪º┘ä╪╖┘ä╪¿ ╪º┘ä╪╣╪º┘ä┘é (jobId).",
src/functions/shared/notify.ts:1:import { ID, Messaging, Permission, Role, TablesDB, Users } from "node-appwrite";
src/functions/shared/notify.ts:28:  client: ConstructorParameters<typeof TablesDB>[0],
src/functions/shared/notify.ts:32:  const tables = new TablesDB(client);
src/functions/shared/notify.ts:89:  client: ConstructorParameters<typeof TablesDB>[0],
src/functions/shared/planManager.ts:3:import { TablesDB, ID, Query } from "node-appwrite";
src/functions/shared/planManager.ts:467:  tables: TablesDB,
src/functions/shared/providerCosts.ts:1:import { ID, TablesDB } from "node-appwrite";
src/functions/shared/providerCosts.ts:6:async function usdToEgp(tables: TablesDB): Promise<number> {
src/functions/shared/providerCosts.ts:29:export async function logProviderCost(tables: TablesDB, input: ProviderCostInput): Promise<void> {
src/functions/shared/providerSpend.ts:1:import { TablesDB, Query } from "node-appwrite";
src/functions/shared/providerSpend.ts:49:export async function getDailyProviderSpendUsd(tables?: TablesDB | null): Promise<number> {
src/functions/shared/providerSpend.ts:80:export async function getTotalProviderSpendUsd(tables?: TablesDB | null): Promise<number> {
src/functions/shared/providerSpend.ts:105:export async function recordProviderCallSpend(costMicro: number, tables?: TablesDB | null): Promise<void> {
src/functions/shared/providerSpend.ts:116:  tables?: TablesDB | null
src/functions/shared/providerSpend.ts:142:  tables?: TablesDB | null,
src/functions/shared/providerSpend.ts:197:  tables?: TablesDB | null,
src/functions/shared/providerSpend.ts:217:  tables?: TablesDB | null
src/functions/shared/quoteAccept.ts:1:import { TablesDB, ID, Query, Permission, Role } from "node-appwrite";
src/functions/shared/quoteAccept.ts:36:  tables: TablesDB,
src/functions/shared/rateLimits.ts:1:import { TablesDB, Query } from "node-appwrite";
src/functions/shared/rateLimits.ts:49: * Supports both Supabase client and Appwrite TablesDB.
src/functions/shared/rateLimits.ts:76:    // Appwrite TablesDB
src/functions/shared/rateLimits.ts:117:async function sumDailyUsageCost(tables: TablesDB, userId?: string): Promise<number> {
src/functions/shared/rateLimits.ts:144: * Supports both Supabase client and Appwrite TablesDB.
src/functions/shared/rateLimits.ts:168:    // Appwrite TablesDB
src/functions/submit-topup/package.json:6:    "node-appwrite": "^29.2.0"
src/functions/submit-topup/src/main.ts:1:import { Client, TablesDB, Storage, Users, Query, Permission, Role, ID } from "node-appwrite";
src/functions/submit-topup/src/main.ts:48:  const tables = new TablesDB(client);
src/lib/appwrite.ts:1:import { Client, Account, Databases } from "appwrite";
src/lib/appwrite.ts:10:export const account = new Account(client);
src/lib/appwrite.ts:11:export const databases = new Databases(client);
src/lib/server/adminAuth.ts:2:import { Account, Client, Query, TablesDB, Users } from "node-appwrite";
src/lib/server/adminAuth.ts:34:  tables: TablesDB;
src/lib/server/adminAuth.ts:69:            tables: new TablesDB(client),
src/lib/server/adminAuth.ts:125:    me = await new Account(userClient).get();
src/lib/server/adminAuth.ts:139:      tables: new TablesDB(client), users: new Users(client),
src/lib/server/adminAuth.ts:147:export async function listAll(tables: TablesDB, tableId: string, queries: string[] = [], cap = 5000): Promise<any[]> {
src/lib/server/adminAuth.ts:182:export async function creditValueEgp(tables: TablesDB): Promise<number> {
src/lib/server/envAdmin.ts:1:import { Client, Functions, Sites } from "node-appwrite";
src/lib/server/userStats.ts:1:import { Query, TablesDB } from "node-appwrite";
src/lib/server/userStats.ts:5:export async function ledgerBalance(tables: TablesDB, userId: string): Promise<number> {

---
# Post-Phase C Verification (After Decoupling)
- Client/UI files (`src/app/**/*.tsx`, `src/components/**/*.tsx`, `src/hooks/**/*.ts*`) importing `"appwrite"`: **0 matches**
- Client bundle `.next/static` scan (`scripts/check-client-bundle-secrets.ts` + pattern grep for `appwrite`, `6ac947090008606ef482`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`): **0 matches across 82 static bundle files**
- Active API routes ported to Supabase:
  - `/api/jobs/[id]/download` (new route generating 300s signed URLs from private `results` bucket with job ownership check)
  - `/api/jobs/[id]/data` (reads from Supabase `jobs`, `artifact_versions`, and `results` storage bucket)
  - `/api/jobs/[id]/methodology` (deducts 10 pts via deterministic `res_meth_`, `rel_meth_`, `chg_meth_` entries in `credit_ledger`)
  - `/api/jobs/[id]/artifacts` (reads/writes versions in Supabase `artifact_versions` and `results` storage bucket)
  - `/api/chat`, `/api/chat/metadata`, `/api/chat/edit-plan`, `/api/onboarding`
  - `/api/admin/*` (backed by Supabase `createSupabaseTablesAdapter` and `createSupabaseUsersAdapter` in `src/lib/server/adminAuth.ts` plus Supabase `receipts` bucket in `/api/admin/receipts/[fileId]`)
- Legacy `src/functions/*` directory left untouched as archived Appwrite Cloud Functions reference (never imported by Next.js client or deployed to Vercel).
