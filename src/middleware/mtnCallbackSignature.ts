import {
  createProviderCallbackVerifier,
  ProviderCallbackConfig,
} from "./providerCallbackSignature";

/**
 * MTN MoMo Open API callback signature verification.
 *
 * Delegates to the shared provider webhook authenticity framework
 * (`providerCallbackSignature.ts`) so MTN, Airtel and Orange all share a
 * single, monitored verification path. Behavior is unchanged:
 *
 *  - Secret read from `providers.mtn.callbackSecret` (env `MTN_CALLBACK_SECRET`)
 *  - Header from `providers.mtn.callbackSignatureHeader`
 *    (env `MTN_CALLBACK_SIGNATURE_HEADER`, default `X-Callback-Signature`)
 *  - Accepts `sha256=<hex>` prefixed signatures or raw base64 HMAC-SHA256
 */

const MTN_CALLBACK_CONFIG: ProviderCallbackConfig = {
  provider: "mtn",
  secretConfigKey: "providers.mtn.callbackSecret",
  headerConfigKey: "providers.mtn.callbackSignatureHeader",
  defaultHeader: "x-callback-signature",
  altHeaders: ["x-mtn-signature"],
  algorithms: ["sha256"],
  allowPrefixed: true,
  defaultEncoding: "base64",
};

export const verifyMtnCallbackSignature =
  createProviderCallbackVerifier(MTN_CALLBACK_CONFIG);
