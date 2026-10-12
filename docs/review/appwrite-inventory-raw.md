scripts/build-functions.ts:43:        "node-appwrite": "^29.2.0",
scripts/capture-all-screenshots.ts:4:import { Client, Users, ID, TablesDB } from "node-appwrite";
scripts/capture-all-screenshots.ts:33:  const tables = new TablesDB(serverClient);
scripts/capture-phase-b2.ts:4:import { Client, Users, ID, TablesDB, Query } from "node-appwrite";
scripts/capture-phase-b2.ts:33:  const tables = new TablesDB(serverClient);
scripts/check-cleanup.ts:1:import { Client, Users, TablesDB, Storage } from "node-appwrite";
scripts/check-cleanup.ts:12:const t = new TablesDB(c);
scripts/check-function-vars.ts:1:import { Client, Functions } from "node-appwrite";
scripts/check-seeds.ts:1:import { Client, TablesDB } from "node-appwrite";
scripts/check-seeds.ts:11:const tables = new TablesDB(client);
scripts/cleanup-all.ts:1:import { Client, Users, TablesDB, Storage, Query } from "node-appwrite";
scripts/cleanup-all.ts:23:const t = new TablesDB(c);
scripts/deploy-functions.ts:1:import { Client, Functions } from "node-appwrite";
scripts/generate-existing-job-files.ts:1:import { Client, TablesDB, Storage, Permission, Role } from "node-appwrite";
scripts/generate-existing-job-files.ts:16:const tables = new TablesDB(client);
scripts/inspect-job.ts:1:import { Client, TablesDB, Storage } from "node-appwrite";
scripts/inspect-job.ts:11:const tables = new TablesDB(client);
scripts/inspect-sdk.ts:1:import { Client, TablesDB, Databases } from "node-appwrite";
scripts/inspect-sdk.ts:4:const tables = new TablesDB(client);
scripts/inspect-sdk.ts:5:console.log("TablesDB methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(tables)).filter(m => m.includes("Column") || m.includes("Attribute") || m.includes("Table")));
scripts/inspect-sdk.ts:7:const dbs = new Databases(client);
scripts/inspect-sdk.ts:8:console.log("Databases attribute methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(dbs)).filter(m => m.includes("Attribute")));
scripts/inspect-user-pdf.ts:1:import { Client, Storage } from "node-appwrite";
scripts/list-functions.ts:1:import { Client, Functions } from "node-appwrite";
scripts/phase-a-cleanup.ts:1:import { Client, Storage } from "node-appwrite";
scripts/query-job-calls.ts:1:import { Client, TablesDB } from "node-appwrite";
scripts/query-job-calls.ts:11:const tables = new TablesDB(client);
scripts/regenerate-verified-pdf.ts:1:import { Client, Storage, Permission, Role } from "node-appwrite";
scripts/setup-db.ts:1:import { Client, TablesDB, Storage, Permission, Role } from "node-appwrite";
scripts/setup-db.ts:20:const tables = new TablesDB(client);
scripts/setup-db.ts:148:  console.log("🚀 Setting up Digr database & storage via TablesDB in Appwrite Cloud...\n");
scripts/setup-phase-b-db.ts:1:import { Client, TablesDB } from "node-appwrite";
scripts/setup-phase-b-db.ts:11:const tables = new TablesDB(client);
scripts/setup-redesign-db.ts:12:import { Client, TablesDB } from "node-appwrite";
scripts/setup-redesign-db.ts:22:const tables = new TablesDB(client);
scripts/test-cloud-endpoint.ts:1:import { Client, TablesDB } from "node-appwrite";
scripts/test-cloud-endpoint.ts:11:  const tables = new TablesDB(client);
scripts/test-download-files.ts:1:import { Client, Users, Account } from "node-appwrite";
scripts/test-e2e-topup.ts:1:import { Client, Users, TablesDB, ID } from "node-appwrite";
scripts/test-e2e-topup.ts:20:const tables = new TablesDB(client);
scripts/test-live-e2e-p2.ts:1:import { Client, TablesDB, Storage, Users, ID, Query, Permission, Role } from "node-appwrite";
scripts/test-live-e2e-p2.ts:2:import { Client as UserClient, Account as UserAccount, Storage as UserStorage } from "appwrite";
scripts/test-live-e2e-p2.ts:29:const tables = new TablesDB(serverClient);
scripts/test-p1-chathandler.ts:1:import { Client, Users, TablesDB, ID, Query } from "node-appwrite";
scripts/test-p1-chathandler.ts:16:const tables = new TablesDB(client);
scripts/test-p1-permissions.ts:1:import { Client as ServerClient, Users, TablesDB as ServerTablesDB, Permission, Role, ID } from "node-appwrite";
scripts/test-p1-permissions.ts:2:import { Client as ClientSDK, Databases as ClientDatabases } from "appwrite";
scripts/test-p1-permissions.ts:25:const serverTables = new ServerTablesDB(serverClient);
scripts/test-p1-permissions.ts:78:  const databases = new ClientDatabases(client);
scripts/test-permissions.ts:1:import { Client as ServerClient, Users, TablesDB as ServerTablesDB, Storage as ServerStorage, Permission, Role, ID, InputFile } from "node-appwrite";
scripts/test-permissions.ts:2:import { Client as ClientSDK, Databases as ClientDatabases, Storage as ClientStorage } from "appwrite";
scripts/test-permissions.ts:25:const serverTables = new ServerTablesDB(serverClient);
scripts/test-permissions.ts:81:  const dbA = new ClientDatabases(clientA);
scripts/test-permissions.ts:86:  const dbB = new ClientDatabases(clientB);
scripts/test-permissions.ts:91:  const dbAdmin = new ClientDatabases(clientAdmin);
scripts/test-phase2-5.ts:4:  TablesDB as ServerTablesDB,
scripts/test-phase2-5.ts:9:} from "node-appwrite";
scripts/test-phase2-5.ts:13:  Databases as ClientDatabases,
scripts/test-phase2-5.ts:17:} from "appwrite";
scripts/test-phase2-5.ts:41:const serverTables = new ServerTablesDB(serverClient);
scripts/test-phase2-5.ts:94:    const guestAccount = new ClientAccount(clientGuest);
scripts/test-phase2-5.ts:107:    const dbA = new ClientDatabases(clientA);
scripts/test-phase2-5.ts:146:    const dbB = new ClientDatabases(clientB);
scripts/test-phase3.ts:4:  TablesDB as ServerTablesDB,
scripts/test-phase3.ts:10:} from "node-appwrite";
scripts/test-phase3.ts:14:  Databases as ClientDatabases,
scripts/test-phase3.ts:18:} from "appwrite";
scripts/test-phase3.ts:42:const serverTables = new ServerTablesDB(serverClient);
scripts/test-phase3.ts:93:    const guestAccount = new ClientAccount(clientGuest);
scripts/update-bucket.ts:1:import { Client, Storage } from "node-appwrite";
scripts/update-capability-registry.ts:1:import { Client, TablesDB, Query } from "node-appwrite";
scripts/update-capability-registry.ts:15:const tables = new TablesDB(client);
scripts/upload-json-artifact.ts:1:import { Client, TablesDB, Storage, Permission, Role } from "node-appwrite";
scripts/upload-json-artifact.ts:15:const tables = new TablesDB(client);
src/app/admin/layout.tsx:4:import { Account, Client } from "node-appwrite";
src/app/admin/layout.tsx:25:      labels = ((await new Account(client).get()) as { labels?: string[] }).labels ?? [];
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
src/app/api/chat/route.ts:29:    const tables = new TablesDB(serverClient);
src/app/api/chat/route.ts:95:      const userAccount = new Account(userClient);
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
src/app/dashboard/settings/page.tsx:6:import { Functions } from "appwrite";
src/app/dashboard/settings/page.tsx:92:  async function deleteAccount() {
src/app/dashboard/topup/TopupForm.tsx:4:import { Functions, ID, Permission, Role, Storage } from "appwrite";
src/app/dashboard/topup/page.tsx:5:import { Query } from "appwrite";
src/components/app/AppShell.tsx:6:import { Query } from "appwrite";
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
src/functions/shared/briefManager.ts:490:  tables: TablesDB | null | undefined,
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
src/functions/shared/multiStepWorker.ts:1209:      "1. افتح لوحة تحكم Appwrite -> Databases -> digr -> جدول jobs وحدد معرّف الطلب العالق (jobId).",
src/functions/shared/notify.ts:1:import { ID, Messaging, Permission, Role, TablesDB, Users } from "node-appwrite";
src/functions/shared/notify.ts:28:  client: ConstructorParameters<typeof TablesDB>[0],
src/functions/shared/notify.ts:32:  const tables = new TablesDB(client);
src/functions/shared/notify.ts:89:  client: ConstructorParameters<typeof TablesDB>[0],
src/functions/shared/planManager.ts:3:import { TablesDB, ID, Query } from "node-appwrite";
src/functions/shared/planManager.ts:466:  tables: TablesDB,
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
src/functions/shared/rateLimits.ts:51:  tables: TablesDB,
src/functions/shared/rateLimits.ts:95:async function sumDailyUsageCost(tables: TablesDB, userId?: string): Promise<number> {
src/functions/shared/rateLimits.ts:122:  tables: TablesDB,
src/functions/submit-topup/package.json:6:    "node-appwrite": "^29.2.0"
src/functions/submit-topup/src/main.ts:1:import { Client, TablesDB, Storage, Users, Query, Permission, Role, ID } from "node-appwrite";
src/functions/submit-topup/src/main.ts:48:  const tables = new TablesDB(client);
src/hooks/useBalance.tsx:4:import { Query } from "appwrite";
src/hooks/useNotifications.ts:4:import { Query } from "appwrite";
src/hooks/useUser.tsx:13:import { type Models } from "appwrite";
src/lib/appwrite.ts:1:import { Client, Account, Databases } from "appwrite";
src/lib/appwrite.ts:10:export const account = new Account(client);
src/lib/appwrite.ts:11:export const databases = new Databases(client);
src/lib/server/adminAuth.ts:2:import { Account, Client, Query, TablesDB, Users } from "node-appwrite";
src/lib/server/adminAuth.ts:34:  tables: TablesDB;
src/lib/server/adminAuth.ts:60:    me = await new Account(userClient).get();
src/lib/server/adminAuth.ts:74:      tables: new TablesDB(client), users: new Users(client),
src/lib/server/adminAuth.ts:82:export async function listAll(tables: TablesDB, tableId: string, queries: string[] = [], cap = 5000): Promise<any[]> {
src/lib/server/adminAuth.ts:117:export async function creditValueEgp(tables: TablesDB): Promise<number> {
src/lib/server/envAdmin.ts:1:import { Client, Functions, Sites } from "node-appwrite";
src/lib/server/userStats.ts:1:import { Query, TablesDB } from "node-appwrite";
src/lib/server/userStats.ts:5:export async function ledgerBalance(tables: TablesDB, userId: string): Promise<number> {
