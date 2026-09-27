import { Request, Response, NextFunction } from "express";
import { pool } from "../config/database";
import { createHash } from "crypto";
import logger from "../utils/logger";

// Number of distinct new-device fingerprints seen for a user within the
// mismatch window before additional verification (e.g. step-up 2FA) is required.
const FINGERPRINT_MISMATCH_THRESHOLD = Number(
  process.env.FINGERPRINT_MISMATCH_THRESHOLD ?? 3,
);
const FINGERPRINT_MISMATCH_WINDOW = process.env.FINGERPRINT_MISMATCH_WINDOW_INTERVAL || "24 hours";

export function hashString(value: string | null | undefined): string {
  const v = value ?? "";
  return createHash("sha256").update(v, "utf8").digest("hex");
}

// Utility to extract fingerprint from headers/params and return a hashed value
export function extractFingerprint(req: Request): string {
  const userAgent = Array.isArray(req.headers["user-agent"])
    ? req.headers["user-agent"][0]
    : (req.headers["user-agent"] ?? "");
  const acceptLanguage = Array.isArray(req.headers["accept-language"])
    ? req.headers["accept-language"][0]
    : (req.headers["accept-language"] ?? "");
  const deviceId =
    (Array.isArray(req.headers["x-device-id"])
      ? req.headers["x-device-id"][0]
      : req.headers["x-device-id"]) ||
    (req.query?.deviceId as string) ||
    "";
  const ip = req.ip || req.socket?.remoteAddress || "";
  const tlsCipher = (req.socket as unknown as { getCipher?: () => { name: string } })?.getCipher?.()
    ?.name || "";

  // Hash the combined fingerprint parts to avoid storing raw UA / IP / language
  const raw = `${userAgent}|${acceptLanguage}|${deviceId}|${ip}|${tlsCipher}`;
  return hashString(raw);
}

export interface DeviceFingerprintCheck {
  fingerprint: string;
  isNewDevice: boolean;
  requiresAdditionalVerification: boolean;
}

/**
 * Records the current request's device fingerprint for a user and flags
 * whether it is new and/or part of a burst of mismatches that warrants
 * additional verification (e.g. step-up 2FA on login).
 */
export async function checkDeviceFingerprint(
  req: Request,
  userId: string,
): Promise<DeviceFingerprintCheck> {
  const fingerprint = extractFingerprint(req);

  const result = await pool.query(
    "SELECT 1 FROM device_fingerprints WHERE user_id = $1 AND fingerprint = $2",
    [userId, fingerprint],
  );

  if (result.rows.length > 0) {
    return { fingerprint, isNewDevice: false, requiresAdditionalVerification: false };
  }

  // New device detected
  await pool.query(
    "INSERT INTO device_fingerprints (user_id, fingerprint) VALUES ($1, $2)",
    [userId, fingerprint],
  );
  logger.warn({ userId, fingerprint }, "New device fingerprint detected for user");

  const recentMismatches = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::int AS count FROM device_fingerprints
     WHERE user_id = $1 AND created_at >= NOW() - $2::interval`,
    [userId, FINGERPRINT_MISMATCH_WINDOW],
  );
  const mismatchCount = Number(recentMismatches.rows[0]?.count ?? 0);
  const requiresAdditionalVerification = mismatchCount >= FINGERPRINT_MISMATCH_THRESHOLD;

  if (requiresAdditionalVerification) {
    logger.warn(
      { userId, mismatchCount },
      "Repeated device fingerprint mismatches detected - additional verification required",
    );
  }

  return { fingerprint, isNewDevice: true, requiresAdditionalVerification };
}

// Middleware to collect and compare device fingerprints
export async function fingerprintMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const userId = (req.body as any)?.userId || (req as any).user?.id; // Adjust as per your auth
  if (!userId) return next();

  const check = await checkDeviceFingerprint(req, userId);
  req.isNewDevice = check.isNewDevice;
  req.requiresAdditionalVerification = check.requiresAdditionalVerification;
  next();
}
