import { Router, Request, Response } from "express";
import { createProviderCallbackVerifier } from "../middleware/providerCallbackSignature";
import { ingestRateLimiter } from "../middleware/ingestRateLimit";

/**
 * Orange Money callback routes.
 *
 * Orange Money delivers transaction state updates to our webhook endpoint.
 * Every request is rate-limited and authenticated via HMAC-SHA256 signature
 * verification before any processing happens. The shared secret is read from
 * `providers.orange.callbackSecret` (env `ORANGE_CALLBACK_SECRET`).
 */
const router = Router();

// Rate-limit ingest traffic before signature verification and DB writes.
router.use(ingestRateLimiter);

const verifyOrangeCallbackSignature = createProviderCallbackVerifier({
  provider: "orange",
  secretConfigKey: "providers.orange.callbackSecret",
  headerConfigKey: "providers.orange.callbackSignatureHeader",
  defaultHeader: "x-orange-signature",
  algorithms: ["sha256"],
  allowPrefixed: true,
  defaultEncoding: "hex",
});

// Signature verification is applied to all incoming Orange callback requests.
router.use(verifyOrangeCallbackSignature);

router.post("/callback", async (req: Request, res: Response) => {
  // Future callback processing can be added here.
  // Currently the Orange callback is authenticated and acknowledged.
  res.status(200).json({ status: "accepted" });
});

export default router;
