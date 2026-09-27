import { pool, queryRead, queryWrite } from "../config/database";
import { encrypt, decrypt, encryptField, decryptField } from "../utils/encryption";

export enum UserStatus {
  ACTIVE = "active",
  FROZEN = "frozen",
  SUSPENDED = "suspended",
  DEACTIVATED = "deactivated",
}

export enum UserRole {
  USER = "user",
  ADMIN = "admin",
  SUPER_ADMIN = "super-admin",
  COMPLIANCE_OFFICER = "compliance_officer",
  DEVELOPER = "developer",
}

export enum KycLevel {
  NONE = "none",
  BASIC = "basic",
  ENHANCED = "enhanced",
  FULL = "full",
}

/**
 * Comprehensive User model type.
 * Maps to the `users` database table.
 */
export interface User {
  /** Unique user identifier (UUID) */
  id: string;
  /** Encrypted phone number (E.164 format before encryption) */
  phoneNumber: string;
  /** KYC verification level */
  kycLevel: KycLevel | string;
  /** Preferred language code (e.g. "en", "fr") */
  preferredLanguage?: string;
  /** Encrypted email address */
  email?: string;
  /** User-chosen display name */
  displayName?: string | null;
  /** Merchant Category Code for the user's business */
  mcc?: string | null;
  /** Encrypted TOTP secret for 2FA */
  two_factor_secret?: string | null;
  /** Array of one-time backup codes for 2FA recovery */
  backup_codes?: string[] | null;
  /** Account status */
  status: UserStatus | string;
  /** Token version for JWT invalidation on password/2FA changes */
  tokenVersion?: number;
  /** Account creation timestamp */
  createdAt: Date;
  /** Last profile update timestamp */
  updatedAt: Date;
  /** Whether the user has opted out of SMS communications */
  smsOptOut?: boolean;
  /** Whether 2FA is mandatory for withdrawal operations */
  mandatory2FAWithdrawals?: boolean;
  /** Number of days to delay settlement payouts */
  settlementDelayDays?: number;
  /** Whether the account is active (false = soft-deactivated) */
  is_active?: boolean;
  /** Timestamp when the account was soft-deactivated */
  deactivated_at?: Date | null;
  /** Encrypted first name (sensitive, only returned to authorized roles) */
  firstName?: string;
  /** Encrypted last name (sensitive, only returned to authorized roles) */
  lastName?: string;
  /** Encrypted physical address (sensitive) */
  address?: string;
  /** Encrypted date of birth (sensitive) */
  dateOfBirth?: string;
  /** Encrypted national ID number (sensitive) */
  idNumber?: string;
}

export class UserModel {
  async list(limit = 50, offset = 0): Promise<{ users: Array<Pick<User, "id" | "kycLevel" | "status" | "createdAt" | "updatedAt">>; total: number }> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const safeOffset = Math.max(Math.trunc(offset), 0);
    const result = await queryRead(
      `SELECT id, kyc_level, status, created_at, updated_at,
              COUNT(*) OVER() AS total_count
       FROM users
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [safeLimit, safeOffset],
    );

    return {
      users: result.rows.map((row) => ({
        id: row.id,
        kycLevel: row.kyc_level,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      total: result.rows.length > 0 ? Number(result.rows[0].total_count) : 0,
    };
  }

  async findById(id: string, requester?: { id: string; role: string }): Promise<User | null> {
    const result = await queryRead("SELECT * FROM users WHERE id = $1", [id]);
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const AUTHORIZED_ROLES = ["admin", "super-admin", "compliance_officer"];
    const isAuthorized = requester && (
      AUTHORIZED_ROLES.includes(requester.role) ||
      requester.id === id
    );

    return {
      id: row.id,
      phoneNumber: decrypt(row.phone_number) as string,
      kycLevel: row.kyc_level,
      preferredLanguage: row.preferred_language ?? row.language ?? undefined,
      email: decrypt(row.email) as string,
      displayName: row.display_name ?? null,
      two_factor_secret: decrypt(row.two_factor_secret) ?? null,
      backup_codes: row.backup_codes ?? null,
      status: row.status,
      tokenVersion: row.token_version ?? 0,
      isActive: row.is_active ?? true,
      deactivatedAt: row.deactivated_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      smsOptOut: row.sms_opt_out ?? false,
      mandatory2FAWithdrawals: row.mandatory_2fa_withdrawals ?? false,
      is_active: row.is_active ?? true,
      deactivated_at: row.deactivated_at ?? null,
      
      firstName: isAuthorized ? (decryptField(row.first_name) as string ?? undefined) : row.first_name ?? undefined,
      lastName: isAuthorized ? (decryptField(row.last_name) as string ?? undefined) : row.last_name ?? undefined,
      address: isAuthorized ? (decryptField(row.address) as string ?? undefined) : row.address ?? undefined,
      dateOfBirth: isAuthorized ? (decryptField(row.date_of_birth) as string ?? undefined) : row.date_of_birth ?? undefined,
      idNumber: isAuthorized ? (decryptField(row.id_number) as string ?? undefined) : row.id_number ?? undefined,
    };
  }

  async updateEmail(id: string, email: string): Promise<void> {
    const encryptedEmail = encrypt(email);
    await queryWrite("UPDATE users SET email = $1 WHERE id = $2", [encryptedEmail, id]);
  }

  async updateDisplayName(id: string, displayName: string | null): Promise<void> {
    await queryWrite(
      "UPDATE users SET display_name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
      [displayName, id],
    );
  }

  async updateSensitiveData(
    id: string,
    data: {
      firstName?: string;
      lastName?: string;
      address?: string;
      dateOfBirth?: string;
      idNumber?: string;
    }
  ): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramIdx = 1;

    if (data.firstName !== undefined) {
      fields.push(`first_name = $${paramIdx++}`);
      values.push(encryptField(data.firstName));
    }
    if (data.lastName !== undefined) {
      fields.push(`last_name = $${paramIdx++}`);
      values.push(encryptField(data.lastName));
    }
    if (data.address !== undefined) {
      fields.push(`address = $${paramIdx++}`);
      values.push(encryptField(data.address));
    }
    if (data.dateOfBirth !== undefined) {
      fields.push(`date_of_birth = $${paramIdx++}`);
      values.push(encryptField(data.dateOfBirth));
    }
    if (data.idNumber !== undefined) {
      fields.push(`id_number = $${paramIdx++}`);
      values.push(encryptField(data.idNumber));
    }

    if (fields.length === 0) return;

    values.push(id);
    const query = `UPDATE users SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramIdx}`;
    await queryWrite(query, values);
  }

  async updateStatus(
    id: string,
    status: UserStatus,
    changedBy: string,
    reason?: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<User | null> {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Get current user status for audit
      const currentUser = await this.findById(id);
      if (!currentUser) {
        await client.query('ROLLBACK');
        return null;
      }

      // Update user status
      const updateQuery = "UPDATE users SET status = $1 WHERE id = $2 RETURNING *";
      const result = await client.query(updateQuery, [status, id]);

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      // Log audit entry
      const auditQuery = `
        INSERT INTO user_status_audit (
          user_id, action, old_status, new_status, reason, changed_by, ip_address, user_agent
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `;

      const action = status === UserStatus.FROZEN ? 'FREEZE' :
                     status === UserStatus.SUSPENDED ? 'SUSPEND' :
                     currentUser.status === UserStatus.FROZEN ? 'UNFREEZE' : 'UNSUSPEND';

      await client.query(auditQuery, [
        id,
        action,
        currentUser.status,
        status,
        reason,
        changedBy,
        ipAddress,
        userAgent
      ]);

      await client.query('COMMIT');

      // Return updated user
      const row = result.rows[0];
      return {
        id: row.id,
        phoneNumber: decrypt(row.phone_number) as string,
        kycLevel: row.kyc_level,
        preferredLanguage: row.preferred_language ?? row.language ?? undefined,
        email: decrypt(row.email) as string,
        displayName: row.display_name ?? null,
        two_factor_secret: decrypt(row.two_factor_secret) ?? null,
        backup_codes: row.backup_codes ?? null,
        status: row.status,
        isActive: row.is_active ?? true,
        deactivatedAt: row.deactivated_at ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        smsOptOut: row.sms_opt_out ?? false,
        settlementDelayDays: row.settlement_delay_days ?? 0,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getAuditHistory(userId: string): Promise<any[]> {
    const query = `
      SELECT
        a.id,
        a.action,
        a.old_status AS "oldStatus",
        a.new_status AS "newStatus",
        a.reason,
        a.created_at AS "createdAt",
        a.ip_address AS "ipAddress",
        a.user_agent AS "userAgent",
        u.phone_number AS "changedByUser"
      FROM user_status_audit a
      JOIN users u ON a.changed_by = u.id
      WHERE a.user_id = $1
      ORDER BY a.created_at DESC
    `;

    const result = await queryRead(query, [userId]);
    return result.rows;
  }
  async incrementTokenVersion(id: string): Promise<number> {
    const query = `
      UPDATE users
      SET token_version = COALESCE(token_version, 0) + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING token_version
    `;
    const result = await queryWrite(query, [id]);
    return result.rows[0]?.token_version || 0;
  }

  async updateMandatory2FAWithdrawals(id: string, enabled: boolean): Promise<void> {
    await queryWrite(
      "UPDATE users SET mandatory_2fa_withdrawals = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
      [enabled, id]
    );
  }

  async deactivate(id: string, deactivatedBy?: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE users
         SET is_active = false,
             deactivated_at = CURRENT_TIMESTAMP,
             status = 'suspended',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [id],
      );
      if (deactivatedBy) {
        await client.query(
          `INSERT INTO user_status_audit (user_id, action, new_status, changed_by)
           VALUES ($1, 'DEACTIVATE', 'suspended', $2)`,
          [id, deactivatedBy],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
