/**
 * Compliance Audit Service
 *
 * Records privileged administrative actions that override regulated state in
 * the `compliance_audit_log` table. Every override must capture who acted
 * (actor/admin id), why (reason) and the before/after values so the compliance
 * history is complete and auditable.
 *
 * Used by the KYC tier upgrade/override flow (see `kycTierUpgradeService`).
 */

import { queryWrite } from "../config/database";
import logger from "../utils/logger";

export const COMPLIANCE_AUDIT_ACTIONS = {
  /** Admin override of a user's KYC tier, e.g. approving an upgrade request. */
  KYC_TIER_OVERRIDE: "kyc.tier.override",
} as const;

export type ComplianceAuditAction =
  (typeof COMPLIANCE_AUDIT_ACTIONS)[keyof typeof COMPLIANCE_AUDIT_ACTIONS];

export interface ComplianceAuditInput {
  /** Admin/user performing the action. */
  actorId: string;
  actorRole?: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  /** Why the override happened — required context for compliance review. */
  reason?: string | null;
  previousValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

export interface ComplianceAuditRecord {
  id: string;
  actor_id: string;
  actor_role: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  reason: string | null;
  previous_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

/**
 * Minimal query surface so callers can pass a transaction client (`pg`
 * PoolClient) and keep the audit row in the same transaction as the change.
 */
export interface ComplianceAuditQueryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export interface KycOverrideAuditParams {
  userId: string;
  previousLevel: string | null;
  newLevel: string;
  /** Admin id that performed the override. */
  adminId: string;
  reason?: string | null;
  source?: string;
  client?: ComplianceAuditQueryable;
}

const INSERT_SQL = `INSERT INTO compliance_audit_log
  (id, actor_id, actor_role, action, resource_type, resource_id,
   reason, previous_value, new_value, metadata, created_at)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`;

/**
 * Builds the audit record without touching the database. Pure function so the
 * shape of the audit entry can be unit tested directly.
 */
export function buildComplianceAuditRecord(
  input: ComplianceAuditInput,
): ComplianceAuditRecord {
  if (!input.actorId) {
    throw new Error("Compliance audit record requires an actor id");
  }

  if (!input.resourceId) {
    throw new Error("Compliance audit record requires a resource id");
  }

  return {
    id: `compliance_audit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    actor_id: input.actorId,
    actor_role: input.actorRole ?? null,
    action: input.action,
    resource_type: input.resourceType,
    resource_id: input.resourceId,
    reason: input.reason ?? null,
    previous_value: input.previousValue ?? null,
    new_value: input.newValue ?? null,
    metadata: input.metadata ?? {},
    created_at: new Date().toISOString(),
  };
}

/**
 * Persists a compliance audit record. Pass `client` to enlist in an existing
 * transaction (recommended when the audited change must be atomic with it).
 */
export async function logComplianceAudit(
  input: ComplianceAuditInput,
  client?: ComplianceAuditQueryable,
): Promise<ComplianceAuditRecord> {
  const record = buildComplianceAuditRecord(input);
  const executor = client ?? {
    query: (text: string, values?: unknown[]) => queryWrite(text, values),
  };

  await executor.query(INSERT_SQL, [
    record.id,
    record.actor_id,
    record.actor_role,
    record.action,
    record.resource_type,
    record.resource_id,
    record.reason,
    record.previous_value === null
      ? null
      : JSON.stringify(record.previous_value),
    record.new_value === null ? null : JSON.stringify(record.new_value),
    JSON.stringify(record.metadata),
    record.created_at,
  ]);

  return record;
}

/**
 * Convenience wrapper that records a KYC tier override with the admin id and
 * override reason (issue #640).
 */
export async function logKycTierOverride(
  params: KycOverrideAuditParams,
): Promise<ComplianceAuditRecord> {
  const record = await logComplianceAudit(
    {
      actorId: params.adminId,
      actorRole: "admin",
      action: COMPLIANCE_AUDIT_ACTIONS.KYC_TIER_OVERRIDE,
      resourceType: "user",
      resourceId: params.userId,
      reason: params.reason ?? "Admin KYC tier override",
      previousValue: { kycLevel: params.previousLevel },
      newValue: { kycLevel: params.newLevel },
      metadata: {
        adminId: params.adminId,
        source: params.source ?? "admin",
        override: true,
      },
    },
    params.client,
  );

  logger.info(
    {
      userId: params.userId,
      adminId: params.adminId,
      previousLevel: params.previousLevel,
      newLevel: params.newLevel,
    },
    "KYC tier override recorded in compliance audit log",
  );

  return record;
}
