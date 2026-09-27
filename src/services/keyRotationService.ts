import { pool } from "../config/database";

// ─── Types ───────────────────────────────────────────────────────────────────

export type KeyAlgorithm = "ed25519" | "secp256k1";
export type KeyStatus = "active" | "rotating" | "retired" | "compromised";
export type RotationSource = "scheduled" | "manual" | "emergency";

export interface ManagedKey {
  id: string;
  name: string;
  algorithm: KeyAlgorithm;
  public_key: string;
  status: KeyStatus;
  created_at: string;
  rotated_at: string | null;
  expires_at: string;
  rotation_interval_days: number;
  metadata: Record<string, any>;
}

export interface KeyRotationEvent {
  id: string;
  key_id: string;
  previous_status: KeyStatus;
  new_status: KeyStatus;
  source: RotationSource;
  reason: string;
  performed_by: string | null;
  created_at: string;
}

export interface KeyAgeAlert {
  key_id: string;
  name: string;
  algorithm: KeyAlgorithm;
  public_key: string;
  created_at: string;
  age_days: number;
  rotation_interval_days: number;
  days_until_expiry: number;
  severity: "info" | "warning" | "critical";
}

// ─── Default Configuration ────────────────────────────────────────────────────

const DEFAULT_ROTATION_INTERVAL_DAYS = parseInt(
  process.env.KEY_ROTATION_INTERVAL_DAYS || "90",
  10,
);

const ALERT_THRESHOLDS = {
  warning: 14,
  critical: 3,
};

// ─── Key Lifecycle Management ─────────────────────────────────────────────────

export async function registerKey(params: {
  name: string;
  algorithm: KeyAlgorithm;
  publicKey: string;
  rotationIntervalDays?: number;
  expiresAt?: string;
  metadata?: Record<string, any>;
}): Promise<ManagedKey> {
  const id = `key_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date();
  const interval = params.rotationIntervalDays ?? DEFAULT_ROTATION_INTERVAL_DAYS;
  const expiresAt = params.expiresAt
    ? new Date(params.expiresAt)
    : new Date(now.getTime() + interval * 24 * 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO managed_keys
      (id, name, algorithm, public_key, status, created_at, expires_at,
       rotation_interval_days, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      params.name,
      params.algorithm,
      params.publicKey,
      "active",
      now.toISOString(),
      expiresAt.toISOString(),
      interval,
      JSON.stringify(params.metadata ?? {}),
    ],
  );

  await logRotationEvent({
    keyId: id,
    previousStatus: "active",
    newStatus: "active",
    source: "manual",
    reason: "Key registered",
    performedBy: null,
  });

  return {
    id,
    name: params.name,
    algorithm: params.algorithm,
    public_key: params.publicKey,
    status: "active",
    created_at: now.toISOString(),
    rotated_at: null,
    expires_at: expiresAt.toISOString(),
    rotation_interval_days: interval,
    metadata: params.metadata ?? {},
  };
}

export async function rotateKey(params: {
  keyId: string;
  newPublicKey: string;
  source: RotationSource;
  reason: string;
  performedBy?: string | null;
}): Promise<ManagedKey> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Get current key
    const currentResult = await client.query(
      `SELECT * FROM managed_keys WHERE id = $1`,
      [params.keyId],
    );

    if (currentResult.rows.length === 0) {
      throw new Error(`Key ${params.keyId} not found`);
    }

    const current = currentResult.rows[0];

    // Mark current key as rotating
    await client.query(
      `UPDATE managed_keys SET status = 'rotating' WHERE id = $1`,
      [params.keyId],
    );

    await logRotationEvent({
      keyId: params.keyId,
      previousStatus: current.status,
      newStatus: "rotating",
      source: params.source,
      reason: params.reason,
      performedBy: params.performedBy ?? null,
    });

    // Update to new public key and mark as active
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + (current.rotation_interval_days || DEFAULT_ROTATION_INTERVAL_DAYS) * 24 * 60 * 60 * 1000,
    );

    await client.query(
      `UPDATE managed_keys
       SET public_key = $1, status = 'active', rotated_at = $2, expires_at = $3
       WHERE id = $4`,
      [params.newPublicKey, now.toISOString(), expiresAt.toISOString(), params.keyId],
    );

    await logRotationEvent({
      keyId: params.keyId,
      previousStatus: "rotating",
      newStatus: "active",
      source: params.source,
      reason: `Rotation completed: ${params.reason}`,
      performedBy: params.performedBy ?? null,
    });

    await client.query("COMMIT");

    return {
      id: params.keyId,
      name: current.name,
      algorithm: current.algorithm,
      public_key: params.newPublicKey,
      status: "active",
      created_at: current.created_at,
      rotated_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      rotation_interval_days: current.rotation_interval_days,
      metadata: typeof current.metadata === "string" ? JSON.parse(current.metadata) : current.metadata,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// ─── Scheduled Rotation Job ──────────────────────────────────────────────────

export async function runScheduledKeyRotation(): Promise<{
  checked: number;
  rotated: number;
  alerts: KeyAgeAlert[];
}> {
  const now = new Date();
  const result = await pool.query(
    `SELECT * FROM managed_keys WHERE status = 'active'`,
  );

  let rotated = 0;
  const alerts: KeyAgeAlert[] = [];

  for (const key of result.rows) {
    const expiresAt = new Date(key.expires_at);
    const daysUntilExpiry = Math.ceil(
      (expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
    );

    const ageDays = Math.ceil(
      (now.getTime() - new Date(key.created_at).getTime()) / (24 * 60 * 60 * 1000),
    );

    // Generate age alerts
    if (daysUntilExpiry <= ALERT_THRESHOLDS.critical) {
      alerts.push({
        key_id: key.id,
        name: key.name,
        algorithm: key.algorithm,
        public_key: key.public_key,
        created_at: key.created_at,
        age_days: ageDays,
        rotation_interval_days: key.rotation_interval_days,
        days_until_expiry: daysUntilExpiry,
        severity: "critical",
      });
    } else if (daysUntilExpiry <= ALERT_THRESHOLDS.warning) {
      alerts.push({
        key_id: key.id,
        name: key.name,
        algorithm: key.algorithm,
        public_key: key.public_key,
        created_at: key.created_at,
        age_days: ageDays,
        rotation_interval_days: key.rotation_interval_days,
        days_until_expiry: daysUntilExpiry,
        severity: "warning",
      });
    }

    // Auto-rotate if past expiry
    if (daysUntilExpiry <= 0) {
      console.warn(
        `[key-rotation] Key ${key.id} (${key.name}) has expired, triggering emergency rotation`,
      );

      await pool.query(
        `UPDATE managed_keys SET status = 'compromised' WHERE id = $1`,
        [key.id],
      );

      await logRotationEvent({
        keyId: key.id,
        previousStatus: "active",
        newStatus: "compromised",
        source: "emergency",
        reason: `Key expired ${Math.abs(daysUntilExpiry)} days ago`,
        performedBy: null,
      });

      rotated++;
    }
  }

  if (alerts.length > 0) {
    await pool.query(
      `INSERT INTO key_rotation_alerts (alerts, checked_at) VALUES ($1, $2)`,
      [JSON.stringify(alerts), now.toISOString()],
    );
  }

  return {
    checked: result.rows.length,
    rotated,
    alerts,
  };
}

// ─── Audit Log ────────────────────────────────────────────────────────────────

async function logRotationEvent(params: {
  keyId: string;
  previousStatus: KeyStatus;
  newStatus: KeyStatus;
  source: RotationSource;
  reason: string;
  performedBy: string | null;
}): Promise<void> {
  const id = `rot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  await pool.query(
    `INSERT INTO key_rotation_events
      (id, key_id, previous_status, new_status, source, reason, performed_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
    [
      id,
      params.keyId,
      params.previousStatus,
      params.newStatus,
      params.source,
      params.reason,
      params.performedBy,
    ],
  );
}

// ─── Query Helpers ────────────────────────────────────────────────────────────

export async function getManagedKeys(
  status?: KeyStatus,
): Promise<ManagedKey[]> {
  const where = status ? `WHERE status = $1` : "";
  const values = status ? [status] : [];

  const result = await pool.query(
    `SELECT * FROM managed_keys ${where} ORDER BY created_at DESC`,
    values,
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    algorithm: row.algorithm,
    public_key: row.public_key,
    status: row.status,
    created_at: row.created_at,
    rotated_at: row.rotated_at,
    expires_at: row.expires_at,
    rotation_interval_days: row.rotation_interval_days,
    metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
  }));
}

export async function getKeyRotationHistory(
  keyId?: string,
  limit: number = 50,
): Promise<KeyRotationEvent[]> {
  const where = keyId ? `WHERE key_id = $1` : "";
  const values = keyId ? [keyId, limit] : [limit];

  const result = await pool.query(
    `SELECT * FROM key_rotation_events ${where} ORDER BY created_at DESC LIMIT $${values.length}`,
    values,
  );

  return result.rows.map((row) => ({
    id: row.id,
    key_id: row.key_id,
    previous_status: row.previous_status,
    new_status: row.new_status,
    source: row.source,
    reason: row.reason,
    performed_by: row.performed_by,
    created_at: row.created_at,
  }));
}

export async function getKeyAgeAlerts(): Promise<KeyAgeAlert[]> {
  const result = await pool.query(
    `SELECT * FROM key_rotation_alerts ORDER BY checked_at DESC LIMIT 10`,
  );

  if (result.rows.length === 0) return [];
  return result.rows[0].alerts;
}
