/**
 * Utility functions for masking Personally Identifiable Information (PII).
 */

/**
 * Masks a phone number by keeping the first 4 characters and last 2 characters.
 * @example +237677123456 -> +237***56
 */
export function maskPhoneNumber(phone: string): string {
  if (!phone) return "";
  const cleaned = phone.trim();
  if (cleaned.length <= 6) return cleaned;
  const prefix = cleaned.slice(0, 4);
  const suffix = cleaned.slice(-2);
  const middleLen = Math.max(0, cleaned.length - prefix.length - suffix.length);
  const stars = "*".repeat(middleLen);
  return `${prefix}${stars}${suffix}`;
}

/**
 * Masks an email address by keeping the first 2 characters of the local part.
 * @example johndoe@example.com -> jo***@example.com
 */
export function maskEmail(email: string): string {
  if (!email) return "";
  const [localPart, domain] = email.split("@");
  if (!domain) return email;
  const maskedLocal =
    localPart.length <= 2 ? `${localPart}***` : `${localPart.slice(0, 2)}***`;
  return `${maskedLocal}@${domain}`;
}

/**
 * Masks a Stellar address by keeping the first 4 and last 4 characters.
 * @example GBAR...ABCD -> GBAR...ABCD
 */
export function maskStellarAddress(address: string): string {
  if (!address) return "";
  if (address.length <= 8) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE_PATTERN = /\+?\d[\d\s-]{7,}\d/g;

/**
 * Masks emails and phone numbers embedded in free-form text (e.g. error
 * messages, log strings) without altering the surrounding text.
 */
export function maskPIIInText(text: string): string {
  if (!text) return text;
  return text
    .replace(EMAIL_PATTERN, (match) => maskEmail(match))
    .replace(PHONE_PATTERN, (match) => maskPhoneNumber(match.replace(/[\s-]/g, "")));
}

/**
 * Recursively masks emails/phone numbers embedded anywhere in a value
 * (objects, arrays, strings) without otherwise altering the text — unlike
 * {@link maskPII}, this never mangles arbitrary strings that don't contain PII.
 * Suitable for logging/serializing free-form error details of unknown shape.
 */
export function maskPIIDeep(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") return maskPIIInText(value);
  if (Array.isArray(value)) return value.map((v) => maskPIIDeep(v));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = maskPIIDeep(v);
    }
    return out;
  }
  return value;
}

/**
 * General purpose masking utility.
 */
export function maskSensitiveData(
  data: string,
  type: "phone" | "email" | "stellar",
): string {
  if (!data) return "";
  switch (type) {
    case "phone":
      return maskPhoneNumber(data);
    case "email":
      return maskEmail(data);
    case "stellar":
      return maskStellarAddress(data);
    default:
      return data;
  }
}

/**
 * Mask PII in a value. If given an object, mask common PII fields recursively.
 * - phone numbers (keys: phone, phoneNumber, msisdn) are masked with maskPhoneNumber
 * - names (keys: name, customerName, firstName, lastName) are masked by keeping first/last char
 */
export function maskPII(value: any): any {
  if (value == null) return value;

  if (typeof value === "string") {
    // Detect phone-like strings (start with + followed by digits, or long digit string)
    const trimmed = value.trim();
    if (/^\+?\d{8,}$/.test(trimmed)) {
      return maskPhoneNumber(trimmed);
    }
    // For generic short strings, mask names by hiding interior letters of words
    return trimmed
      .split(/(\s+)/)
      .map((part) => {
        if (/^\s+$/.test(part)) return part;
        if (part.length <= 2) return "*".repeat(part.length);
        return part[0] + "*".repeat(part.length - 2) + part[part.length - 1];
      })
      .join("");
  }

  if (Array.isArray(value)) {
    return value.map((v) => maskPII(v));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const lk = k.toLowerCase();
      if (v == null) {
        out[k] = v;
        continue;
      }
      if (
        lk === "phone" ||
        lk === "phonenumber" ||
        lk === "msisdn" ||
        lk === "phone_number"
      ) {
        out[k] = typeof v === "string" ? maskPhoneNumber(v) : v;
        continue;
      }
      if (
        lk === "name" ||
        lk === "customername" ||
        lk === "firstname" ||
        lk === "lastname" ||
        lk === "full_name"
      ) {
        out[k] = typeof v === "string" ? maskPII(String(v)) : v;
        continue;
      }
      if (lk === "email" || lk === "emailaddress" || lk === "email_address") {
        out[k] = typeof v === "string" ? maskEmail(v) : v;
        continue;
      }
      if (
        lk === "accountid" ||
        lk === "account_id" ||
        lk === "accountnumber" ||
        lk === "account_number"
      ) {
        out[k] = typeof v === "string" ? maskStellarAddress(v) : v;
        continue;
      }
      // nested payer/payee objects with partyId
      if (
        (lk === "payer" ||
          lk === "payee" ||
          lk === "subscriber" ||
          lk === "payeeinfo") &&
        typeof v === "object"
      ) {
        out[k] = maskPII(v);
        continue;
      }
      // for other keys, recurse
      out[k] = maskPII(v);
    }
    return out;
  }

  // primitives (number, boolean) return as-is
  return value;
}
