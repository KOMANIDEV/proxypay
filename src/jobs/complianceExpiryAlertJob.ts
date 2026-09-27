/**
 * #481 – Compliance certification expiry alerts
 *
 * Certification lapses are the compliance failure mode that arrives silently:
 * nobody notices a certificate expiring until an audit does. This job runs
 * daily and escalates certifications inside the reminder window.
 *
 * Two horizons, because one alert is not enough: a "soon" notice gives people
 * time to act, and the "expired" notice closes the loop. Only newly-expiring
 * certificates are escalated per run so a daily schedule cannot produce 30
 * identical reminders.
 */

import { getExpiringCertifications } from "../services/complianceTrainingService";
import { notifySlackAlert } from "../services/loggers";
import logger from "../utils/logger";

/** Inside this horizon: "act before you lapse". */
const WARNING_DAYS = 30;
/** Inside this horizon: "you have lapsed". */
const CRITICAL_DAYS = 7;

export async function runComplianceExpiryAlertJob(): Promise<void> {
  console.info("[compliance-training] Checking certification expiries");

  const expiring = await getExpiringCertifications(WARNING_DAYS);
  if (expiring.length === 0) {
    console.info("[compliance-training] No certifications expiring soon");
    return;
  }

  const critical = expiring.filter((c) => c.daysRemaining <= CRITICAL_DAYS);
  const warning = expiring.filter((c) => c.daysRemaining > CRITICAL_DAYS);

  const buildMessage = (entries: typeof expiring, verb: string) =>
    entries
      .map(
        (c) =>
          `${c.moduleCode} for user ${c.userId} (cert ${c.certificateNumber}) ` +
          `${verb} in ${c.daysRemaining} day(s) on ${c.expiresAt.toISOString()}`,
      )
      .join("\n");

  if (critical.length > 0) {
    console.error(
      `[compliance-training] ${critical.length} certification(s) lapsing within ${CRITICAL_DAYS} days`,
    );
    await notifySlackAlert(
      {
        statusCode: 403,
        method: "COMPLIANCE",
        path: "/compliance/training/expiring",
        timestamp: new Date().toISOString(),
        error: new Error(
          `Compliance certifications lapsing or lapsed:\n${buildMessage(critical, "lapses")}`,
        ),
      },
      { appName: "compliance-training" },
    );
  }

  if (warning.length > 0) {
    logger.info(
      { count: warning.length, withinDays: WARNING_DAYS },
      "[compliance-training] certifications expiring soon",
    );
    await notifySlackAlert(
      {
        statusCode: 200,
        method: "COMPLIANCE",
        path: "/compliance/training/expiring",
        timestamp: new Date().toISOString(),
        error: new Error(
          `Compliance certifications expiring soon:\n${buildMessage(warning, "expires")}`,
        ),
      },
      { appName: "compliance-training" },
    );
  }
}
