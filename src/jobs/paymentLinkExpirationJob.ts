import { PaymentLinkModel, PaymentLink } from "../models/paymentLink";
import { NotificationRouter } from "../services/notificationRouter";
import { UserModel } from "../models/users";
import { paymentLinkExpirationNotificationsTotal } from "../utils/metrics";

/**
 * Payment Link Expiration Notification Job
 * Schedule: Every hour (configurable via PAYMENT_LINK_EXPIRATION_CRON)
 *
 * Sends notifications to merchants about:
 * - Payment links expiring within 24 hours (warning)
 * - Payment links that have just expired
 */

// ── Configuration ─────────────────────────────────────────────────────────────

function getWarningHoursAhead(): number {
  const hours = parseInt(process.env.PAYMENT_LINK_WARNING_HOURS ?? "24", 10);
  return isNaN(hours) ? 24 : hours;
}

// ── Core logic ────────────────────────────────────────────────────────────────

async function sendExpiringWarning(
  link: PaymentLink,
  notificationRouter: NotificationRouter,
  paymentLinkModel: PaymentLinkModel,
): Promise<void> {
  // Check if warning was already sent
  const alreadySent = await paymentLinkModel.hasExpirationNotificationBeenSent(
    link.id,
    "warning_24h",
  );
  if (alreadySent) return;

  // Find the merchant to notify
  const merchantModel = new UserModel();
  const merchant = await merchantModel.findById(link.merchantId);
  if (!merchant) return;

  const expiresAt = new Date(link.expiresAt!);
  const hoursRemaining = Math.round(
    (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60),
  );

  await notificationRouter.routeNotification({
    userId: link.merchantId,
    severity: "medium",
    category: "payment_link",
    title: "Payment Link Expiring Soon",
    message: `Your payment link for ${link.amount} ${link.currency} will expire in ${hoursRemaining} hours. Extend the expiration or create a new link to avoid payment failures.`,
    data: {
      paymentLinkId: link.id,
      token: link.token,
      amount: link.amount,
      currency: link.currency,
      expiresAt: expiresAt.toISOString(),
      hoursRemaining,
    },
  });

  await paymentLinkModel.recordExpirationNotification(link.id, "warning_24h");
  paymentLinkExpirationNotificationsTotal.inc({ notification_type: "warning_24h" });
}

async function sendExpiredNotification(
  link: PaymentLink,
  notificationRouter: NotificationRouter,
  paymentLinkModel: PaymentLinkModel,
): Promise<void> {
  // Check if expired notification was already sent
  const alreadySent = await paymentLinkModel.hasExpirationNotificationBeenSent(
    link.id,
    "expired",
  );
  if (alreadySent) return;

  // Find the merchant to notify
  const merchantModel = new UserModel();
  const merchant = await merchantModel.findById(link.merchantId);
  if (!merchant) return;

  await notificationRouter.routeNotification({
    userId: link.merchantId,
    severity: "high",
    category: "payment_link",
    title: "Payment Link Expired",
    message: `Your payment link for ${link.amount} ${link.currency} has expired. Create a new payment link to continue accepting payments.`,
    data: {
      paymentLinkId: link.id,
      token: link.token,
      amount: link.amount,
      currency: link.currency,
      expiresAt: new Date(link.expiresAt!).toISOString(),
    },
  });

  await paymentLinkModel.recordExpirationNotification(link.id, "expired");
  paymentLinkExpirationNotificationsTotal.inc({ notification_type: "expired" });
}

// ── Job entry point ───────────────────────────────────────────────────────────

export async function runPaymentLinkExpirationJob(): Promise<void> {
  const paymentLinkModel = new PaymentLinkModel();
  const notificationRouter = new NotificationRouter(new UserModel());
  const warningHours = getWarningHoursAhead();

  console.log(
    `[payment-link-expiration] Checking for links expiring within ${warningHours} hours`,
  );

  // 1. Find and notify about links expiring soon (24h warning)
  const expiringSoon = await paymentLinkModel.findExpiringSoon(warningHours);
  console.log(
    `[payment-link-expiration] Found ${expiringSoon.length} links expiring soon`,
  );

  for (const link of expiringSoon) {
    try {
      await sendExpiringWarning(link, notificationRouter, paymentLinkModel);
    } catch (err) {
      console.error(
        `[payment-link-expiration] Failed to send warning for link ${link.id}:`,
        err,
      );
    }
  }

  // 2. Find and notify about links that have expired
  const expired = await paymentLinkModel.findExpired();
  console.log(
    `[payment-link-expiration] Found ${expired.length} expired links`,
  );

  for (const link of expired) {
    try {
      await sendExpiredNotification(link, notificationRouter, paymentLinkModel);
    } catch (err) {
      console.error(
        `[payment-link-expiration] Failed to send expired notification for link ${link.id}:`,
        err,
      );
    }
  }

  console.log("[payment-link-expiration] Job complete");
}
