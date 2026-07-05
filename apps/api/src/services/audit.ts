/**
 * Audit log writer — always called inside the same DB transaction as the
 * mutation it records (blueprint §5.4: "never fire-and-forget"). The two
 * actor kinds (staff user vs. vendor invite) are mutually exclusive on any
 * given row and drive the FK columns `actor_user_id` / `actor_vendor_invite_id`.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Principal } from '@vsa/shared';

/**
 * A subset of PrismaClient usable inside `$transaction`. Prisma exposes
 * `Prisma.TransactionClient` for exactly this — we alias it here so callers
 * can pass either a full client or a tx.
 */
export type PrismaTx = Prisma.TransactionClient | PrismaClient;

export interface AuditEntry {
  action: string; // dotted namespace: 'response.update', 'assessment.submit', 'evidence.upload'
  entityType: string; // 'response', 'assessment', 'evidence_files', ...
  entityId?: string;
  before?: unknown;
  after?: unknown;
}

export async function writeAudit(
  tx: PrismaTx,
  principal: Principal,
  entry: AuditEntry,
): Promise<void> {
  const base = {
    organizationId: principal.orgId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    beforeValue: entry.before === undefined ? null : (entry.before as Prisma.InputJsonValue),
    afterValue: entry.after === undefined ? null : (entry.after as Prisma.InputJsonValue),
  };

  if (principal.kind === 'staff') {
    await tx.auditLog.create({
      data: {
        ...base,
        actorUserId: principal.userId,
        actorVendorInviteId: null,
      },
    });
  } else {
    await tx.auditLog.create({
      data: {
        ...base,
        actorUserId: null,
        actorVendorInviteId: principal.inviteId,
      },
    });
  }
}
