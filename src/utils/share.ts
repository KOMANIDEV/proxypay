import crypto from "crypto";

export interface SharePayload {
  id: string;
  exp: number; // unix seconds
}

const DEFAULT_SECRET = "change-this-in-production";

function base64urlEncode(buf: Buffer) {
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64urlDecode(str: string) {
  // add padding
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = 4 - (str.length % 4);
  if (pad !== 4) str = str + "=".repeat(pad);
  return Buffer.from(str, "base64");
}

export function generateShareToken(
  id: string,
  expiresInSeconds = 60 * 60,
): string {
  const secret = process.env.SHARE_LINK_SECRET || DEFAULT_SECRET;
  const payload: SharePayload = {
    id,
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
  };
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = base64urlEncode(Buffer.from(payloadJson, "utf8"));
  const sig = crypto.createHmac("sha256", secret).update(payloadB64).digest();
  const sigB64 = base64urlEncode(sig);
  return `${payloadB64}.${sigB64}`;
}

export function verifyShareToken(token: string): SharePayload {
  const secret = process.env.SHARE_LINK_SECRET || DEFAULT_SECRET;
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("Invalid token format");
  const [payloadB64, sigB64] = parts;

  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(payloadB64)
    .digest();
  const actualSig = base64urlDecode(sigB64);

  // timing safe compare
  const equal =
    expectedSig.length === actualSig.length &&
    crypto.timingSafeEqual(expectedSig, actualSig);

  if (!equal) throw new Error("Invalid token signature");

  const payloadJson = base64urlDecode(payloadB64).toString("utf8");
  const payload = JSON.parse(payloadJson) as SharePayload;

  if (
    !payload ||
    typeof payload.id !== "string" ||
    typeof payload.exp !== "number"
  ) {
    throw new Error("Invalid token payload");
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) throw new Error("Token expired");

  return payload;
}
