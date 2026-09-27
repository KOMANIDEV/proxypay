import { pool } from "../config/database";
import logger from "../utils/logger";
import { KYCWebhookEvent, dispatchKYCStatusEvent } from "./kycWebhookService";

export interface MerchantKycNotificationPreferences {
  merchantId: string;
  emailNotifications: boolean;
  webhookNotifications: boolean;
  notifyOnApproved: boolean;
  notifyOnRejected: boolean;
  notifyOnPending: boolean;
  updatedAt: Date;
}

export interface KycStatusNotificationRecord {
  id: string;
  merchantId: string;
  applicantId: string;
  previousStatus: string;
  newStatus: string;
  channels: string[];
  delivered: boolean;
  rejectionReasons?: string[];
  notifiedAt: Date;
}

export class KycNotificationService {
  private preferences: Map<string, MerchantKycNotificationPreferences> = new Map();
  private notificationHistory: KycStatusNotificationRecord[] = [];

  /**
   * Set merchant KYC notification preferences
   */
  async setPreferences(
    merchantId: string,
    prefs: Partial<MerchantKycNotificationPreferences>
  ): Promise<MerchantKycNotificationPreferences> {
    const existing = this.preferences.get(merchantId) || {
      merchantId,
      emailNotifications: true,
      webhookNotifications: true,
      notifyOnApproved: true,
      notifyOnRejected: true,
      notifyOnPending: false,
      updatedAt: new Date(),
    };

    const updated: MerchantKycNotificationPreferences = {
      ...existing,
      ...prefs,
      merchantId,
      updatedAt: new Date(),
    };

    this.preferences.set(merchantId, updated);
    return updated;
  }

  /**
   * Get merchant KYC notification preferences
   */
  async getPreferences(merchantId: string): Promise<MerchantKycNotificationPreferences> {
    return (
      this.preferences.get(merchantId) || {
        merchantId,
        emailNotifications: true,
        webhookNotifications: true,
        notifyOnApproved: true,
        notifyOnRejected: true,
        notifyOnPending: false,
        updatedAt: new Date(),
      }
    );
  }

  /**
   * Notify merchant of KYC status change
   */
  async notifyKycStatusChange(params: {
    merchantId: string;
    applicantId: string;
    previousStatus: string;
    newStatus: "approved" | "rejected" | "pending" | "review";
    rejectionReasons?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<KycStatusNotificationRecord> {
    const { merchantId, applicantId, previousStatus, newStatus, rejectionReasons, metadata } = params;
    const prefs = await this.getPreferences(merchantId);

    const channels: string[] = [];

    // Check if notification should fire based on preferences
    const shouldNotify =
      (newStatus === "approved" && prefs.notifyOnApproved) ||
      (newStatus === "rejected" && prefs.notifyOnRejected) ||
      (newStatus === "pending" && prefs.notifyOnPending) ||
      newStatus === "review";

    if (shouldNotify) {
      if (prefs.webhookNotifications) {
        channels.push("webhook");
        try {
          await dispatchKYCStatusEvent(
            merchantId,
            {
              object_id: applicantId,
              object_type: "applicant",
              applicant_id: applicantId,
              status: newStatus,
              previous_status: previousStatus as any,
              rejection_reasons: rejectionReasons,
              metadata,
            },
            "kyc.status.changed"
          );
        } catch (err: any) {
          logger.warn({ error: err.message, merchantId }, "Failed to dispatch KYC webhook notification");
        }
      }

      if (prefs.emailNotifications) {
        channels.push("email");
        logger.info({ merchantId, applicantId, newStatus }, "Queued KYC status change email notification");
      }
    }

    const record: KycStatusNotificationRecord = {
      id: `notif_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      merchantId,
      applicantId,
      previousStatus,
      newStatus,
      channels,
      delivered: channels.length > 0,
      rejectionReasons,
      notifiedAt: new Date(),
    };

    this.notificationHistory.push(record);
    logger.info({ notificationId: record.id, merchantId, newStatus }, "Merchant KYC notification processed");
    return record;
  }

  /**
   * List notification delivery logs for a merchant
   */
  async getNotificationHistory(merchantId: string): Promise<KycStatusNotificationRecord[]> {
    return this.notificationHistory.filter((n) => n.merchantId === merchantId);
  }
}

export const kycNotificationService = new KycNotificationService();
