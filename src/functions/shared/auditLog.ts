import { ID, Permission, Role, TablesDB } from "./dbCompat";

export type AuditKind = "approve" | "reject" | "key" | "toggle" | "setting" | "login";

export interface AuditEntry {
  actorId: string;
  actorName: string;
  kind: AuditKind;
  /** Human label, e.g. «اعتماد شحن» */
  label: string;
  /** What happened, e.g. «أحمد محمد علي · ١٠٠ ج.م → ١٬٠٠٠ نقطة» */
  target: string;
  targetType?: string;
  targetId?: string;
  ip?: string;
}

/**
 * Append-only: rows are only ever created (by the server key). Nothing in the codebase updates or deletes them,
 * and the table grants no update/delete permission to any role.
 */
export async function writeAudit(client: ConstructorParameters<typeof TablesDB>[0], e: AuditEntry, log?: (m: string) => void): Promise<void> {
  try {
    await new TablesDB(client).createRow({
      databaseId: "digr",
      tableId: "admin_audit_log",
      rowId: ID.unique(),
      data: {
        actorId: e.actorId,
        action: e.kind,
        targetType: e.targetType ?? null,
        targetId: e.targetId ?? null,
        meta: JSON.stringify({ who: e.actorName, label: e.label, target: e.target }).slice(0, 1024),
        ip: (e.ip || "").slice(0, 64) || null,
        createdAt: new Date().toISOString(),
      },
      permissions: [Permission.read(Role.label("admin"))],
    });
  } catch (err: any) {
    // The audit trail must never block the action itself, but a failure is surfaced in the function log.
    log?.(`audit write failed: ${err?.message}`);
  }
}
