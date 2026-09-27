import { pool } from "../config/database";

export interface PaymentLink {
  id: string;
  merchantId: string;
  amount: string;
  currency: string;
  description?: string;
  token: string;
  isOneTime: boolean;
  isUsed: boolean;
  stellarAddress: string;
  redirectSuccessUrl?: string;
  redirectFailUrl?: string;
  expiresAt?: Date;
  /**
   * IANA timezone name supplied by the merchant (e.g. "Africa/Lagos").
   * When present, `expiresAt` was calculated in this timezone so clients can
   * display the expiry in the correct local time.
   *
   * Issue #644 – without storing the timezone, expiration timestamps were
   * ambiguous and payers saw "midnight UTC" instead of midnight in their zone.
   */
  timezone?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExpirationNotificationRecord {
  id: string;
  paymentLinkId: string;
  notificationType: "warning_24h" | "expired";
  sentAt: Date;
  createdAt: Date;
}

export class PaymentLinkModel {
  async create(
    link: Omit<PaymentLink, "id" | "isUsed" | "createdAt" | "updatedAt">,
  ): Promise<PaymentLink> {
    const result = await pool.query(
      `INSERT INTO payment_links (
        merchant_id, amount, currency, description, token, is_one_time, stellar_address, redirect_success_url, redirect_fail_url, expires_at, timezone
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING 
        id, merchant_id as "merchantId", amount, currency, description, token, 
        is_one_time as "isOneTime", is_used as "isUsed", stellar_address as "stellarAddress", 
        redirect_success_url as "redirectSuccessUrl", redirect_fail_url as "redirectFailUrl", 
        expires_at as "expiresAt", timezone, created_at as "createdAt", updated_at as "updatedAt"`,
      [
        link.merchantId,
        link.amount,
        link.currency,
        link.description ?? null,
        link.token,
        link.isOneTime,
        link.stellarAddress,
        link.redirectSuccessUrl ?? null,
        link.redirectFailUrl ?? null,
        link.expiresAt ?? null,
        link.timezone ?? null,
      ],
    );
    return result.rows[0];
  }

  async findByToken(token: string): Promise<PaymentLink | null> {
    const result = await pool.query(
      `SELECT 
        id, merchant_id as "merchantId", amount, currency, description, token, 
        is_one_time as "isOneTime", is_used as "isUsed", stellar_address as "stellarAddress", 
        redirect_success_url as "redirectSuccessUrl", redirect_fail_url as "redirectFailUrl", 
        expires_at as "expiresAt", timezone, created_at as "createdAt", updated_at as "updatedAt"
      FROM payment_links
      WHERE token = $1`,
      [token],
    );
    return result.rows[0] || null;
  }

  async markAsUsed(id: string): Promise<void> {
    await pool.query(
      `UPDATE payment_links 
       SET is_used = true 
       WHERE id = $1`,
      [id],
    );
  }

  /**
   * Find payment links that will expire within the given number of hours.
   * Used by the expiration notification job to send advance warnings.
   */
  async findExpiringSoon(hoursAhead: number): Promise<PaymentLink[]> {
    const result = await pool.query(
      `SELECT 
        id, merchant_id as "merchantId", amount, currency, description, token, 
        is_one_time as "isOneTime", is_used as "isUsed", stellar_address as "stellarAddress", 
        redirect_success_url as "redirectSuccessUrl", redirect_fail_url as "redirectFailUrl", 
        expires_at as "expiresAt", timezone, created_at as "createdAt", updated_at as "updatedAt"
      FROM payment_links
      WHERE expires_at IS NOT NULL
        AND expires_at > NOW()
        AND expires_at <= NOW() + ($1 || ' hours')::interval
        AND is_used = false`,
      [String(hoursAhead)],
    );
    return result.rows;
  }

  /**
   * Find payment links that have expired but haven't been used.
   */
  async findExpired(): Promise<PaymentLink[]> {
    const result = await pool.query(
      `SELECT 
        id, merchant_id as "merchantId", amount, currency, description, token, 
        is_one_time as "isOneTime", is_used as "isUsed", stellar_address as "stellarAddress", 
        redirect_success_url as "redirectSuccessUrl", redirect_fail_url as "redirectFailUrl", 
        expires_at as "expiresAt", timezone, created_at as "createdAt", updated_at as "updatedAt"
      FROM payment_links
      WHERE expires_at IS NOT NULL
        AND expires_at < NOW()
        AND is_used = false`,
    );
    return result.rows;
  }

  /**
   * Extend a payment link's expiration by the given number of seconds.
   */
  async extendExpiration(id: string, extensionSeconds: number): Promise<void> {
    await pool.query(
      `UPDATE payment_links 
       SET expires_at = GREATEST(
         expires_at, NOW()
       ) + ($1 || ' seconds')::interval
       WHERE id = $2`,
      [String(extensionSeconds), id],
    );
  }

  /**
   * Record that an expiration notification has been sent for a payment link.
   */
  async recordExpirationNotification(
    paymentLinkId: string,
    notificationType: "warning_24h" | "expired",
  ): Promise<void> {
    await pool.query(
      `INSERT INTO payment_link_expiration_notifications (payment_link_id, notification_type, sent_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (payment_link_id, notification_type) DO UPDATE SET sent_at = NOW()`,
      [paymentLinkId, notificationType],
    );
  }

  /**
   * Check if a notification has already been sent for a payment link.
   */
  async hasExpirationNotificationBeenSent(
    paymentLinkId: string,
    notificationType: "warning_24h" | "expired",
  ): Promise<boolean> {
    const result = await pool.query(
      `SELECT 1 FROM payment_link_expiration_notifications 
       WHERE payment_link_id = $1 AND notification_type = $2`,
      [paymentLinkId, notificationType],
    );
    return result.rows.length > 0;
  }
}
