import axios from "axios";
import logger from "../utils/logger";
import { TransactionStatus } from "../models/transaction";

export interface StatusNotificationSubscription {
  id: string;
  merchantId: string;
  webhookUrl: string;
  secret: string;
  subscribedStatuses: TransactionStatus[];
  active: boolean;
}

export interface StatusNotificationDelivery {
  id: string;
  subscriptionId: string;
  transactionId: string;
  fromStatus?: TransactionStatus;
  toStatus: TransactionStatus;
  attemptCount: number;
  maxAttempts: number;
  lastAttemptAt?: Date;
  status: "PENDING" | "DELIVERED" | "FAILED";
  responseCode?: number;
  error?: string;
  createdAt: Date;
}

export class TransactionStatusNotificationService {
  private subscriptions: Map<string, StatusNotificationSubscription[]> = new Map();
  private deliveryHistory: StatusNotificationDelivery[] = [];

  /**
   * Register a webhook endpoint for transaction status notifications
   */
  public subscribe(sub: StatusNotificationSubscription): void {
    const list = this.subscriptions.get(sub.merchantId) || [];
    list.push(sub);
    this.subscriptions.set(sub.merchantId, list);
    logger.info(`[StatusNotify] Merchant ${sub.merchantId} registered webhook for statuses: ${sub.subscribedStatuses.join(", ")}`);
  }

  /**
   * Trigger status transition notification dispatch
   */
  public async notifyStatusChange(
    merchantId: string,
    transactionId: string,
    toStatus: TransactionStatus,
    fromStatus?: TransactionStatus,
    metadata?: Record<string, any>
  ): Promise<StatusNotificationDelivery[]> {
    const subs = this.subscriptions.get(merchantId) || [];
    const matchingSubs = subs.filter((s) => s.active && s.subscribedStatuses.includes(toStatus));

    const deliveries: StatusNotificationDelivery[] = [];

    for (const sub of matchingSubs) {
      const delivery: StatusNotificationDelivery = {
        id: `deliv-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        subscriptionId: sub.id,
        transactionId,
        fromStatus,
        toStatus,
        attemptCount: 0,
        maxAttempts: 3,
        status: "PENDING",
        createdAt: new Date(),
      };

      this.deliveryHistory.push(delivery);
      deliveries.push(delivery);

      // Trigger dispatch asynchronously
      this.attemptDispatch(delivery, sub, {
        eventId: delivery.id,
        eventType: "transaction.status_changed",
        transactionId,
        fromStatus,
        toStatus,
        timestamp: new Date().toISOString(),
        metadata,
      }).catch((err) => {
        logger.error(`[StatusNotify] Dispatch error: ${err.message}`);
      });
    }

    return deliveries;
  }

  private async attemptDispatch(
    delivery: StatusNotificationDelivery,
    sub: StatusNotificationSubscription,
    payload: any
  ): Promise<void> {
    delivery.attemptCount++;
    delivery.lastAttemptAt = new Date();

    try {
      const response = await axios.post(sub.webhookUrl, payload, {
        headers: {
          "Content-Type": "application/json",
          "X-ProxyPay-Signature": sub.secret,
          "X-ProxyPay-Delivery": delivery.id,
        },
        timeout: 5000,
      });

      delivery.status = "DELIVERED";
      delivery.responseCode = response.status;
      logger.info(`[StatusNotify] Delivered ${delivery.id} to ${sub.webhookUrl} with status ${response.status}`);
    } catch (err: any) {
      delivery.error = err.message;
      delivery.responseCode = err.response?.status;

      if (delivery.attemptCount < delivery.maxAttempts) {
        delivery.status = "PENDING";
        logger.warn(`[StatusNotify] Delivery ${delivery.id} failed, retry queued (${delivery.attemptCount}/${delivery.maxAttempts})`);
        setTimeout(() => this.attemptDispatch(delivery, sub, payload), 2000 * delivery.attemptCount);
      } else {
        delivery.status = "FAILED";
        logger.error(`[StatusNotify] Delivery ${delivery.id} permanently failed after ${delivery.attemptCount} attempts`);
      }
    }
  }

  public getDeliveryHistory(transactionId?: string): StatusNotificationDelivery[] {
    if (transactionId) {
      return this.deliveryHistory.filter((d) => d.transactionId === transactionId);
    }
    return [...this.deliveryHistory];
  }
}

export const transactionStatusNotificationService = new TransactionStatusNotificationService();
