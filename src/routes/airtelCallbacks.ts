import { Router, Request, Response } from "express";
import { createProviderCallbackVerifier } from "../middleware/providerCallbackSignature";
import { ingestRateLimiter } from "../middleware/ingestRateLimit";

/**
 * Airtel Money callback routes.
 *
 * Airtel Money delivers transaction state updates to our webhook endpoint.
 * Every request is rate-limited and authenticated via HMAC-SHA256 signature
 * verification before any processing happens. The shared secret is read from
 * `providers.airtel.callbackSecret` (env `AIRTEL_CALLBACK_SECRET`).
 */
const router = Router();

// Rate-limit ingest traffic before signature verification and DB writes.
router.use(ingestRateLimiter);

const verifyAirtelCallbackSignature = createProviderCallbackVerifier({
  provider: "airtel",
  secretConfigKey: "providers.airtel.callbackSecret",
  headerConfigKey: "providers.airtel.callbackSignatureHeader",
  defaultHeader: "x-airtel-signature",
  altHeaders: ["x-signature"],
  algorithms: ["sha256"],
  allowPrefixed: true,
  defaultEncoding: "base64",
});

// Signature verification is applied to all incoming Airtel callback requests.
router.use(verifyAirtelCallbackSignature);

router.post("/callback", async (req: Request, res: Response) => {
  // Future callback processing can be added here.
  // Currently the Airtel callback is authenticated and acknowledged.
  res.status(200).json({ status: "accepted" });
});

export default router;
