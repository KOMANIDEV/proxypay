import logger from "../utils/logger";

export type EncryptionStatus = "encrypted" | "masked" | "plaintext";

export interface FieldEncryptionMetadata {
  fieldName: string;
  entity: string;
  status: EncryptionStatus;
  algorithm: string;
  keyVersion?: string;
  description: string;
}

export interface PiiDetectionResult {
  detected: boolean;
  fieldCandidate?: string;
  piiType?: "SSN" | "CREDIT_CARD" | "EMAIL" | "PHONE" | "IBAN";
  riskLevel: "HIGH" | "MEDIUM" | "LOW";
}

export class PiiTransparencyService {
  private static readonly ENCRYPTED_FIELDS_CATALOG: FieldEncryptionMetadata[] = [
    { fieldName: "tax_id", entity: "merchant", status: "encrypted", algorithm: "AES-256-GCM", keyVersion: "v2", description: "Tax identification or SSN" },
    { fieldName: "bank_account_number", entity: "merchant", status: "encrypted", algorithm: "AES-256-GCM", keyVersion: "v2", description: "Direct bank account number" },
    { fieldName: "routing_number", entity: "merchant", status: "encrypted", algorithm: "AES-256-GCM", keyVersion: "v2", description: "Bank routing transit number" },
    { fieldName: "phone_number", entity: "user", status: "encrypted", algorithm: "Deterministic AES-256", keyVersion: "v1", description: "E.164 phone number" },
    { fieldName: "email", entity: "user", status: "encrypted", algorithm: "Deterministic AES-256", keyVersion: "v1", description: "User email address" },
    { fieldName: "date_of_birth", entity: "user", status: "encrypted", algorithm: "AES-256-GCM", keyVersion: "v2", description: "Date of birth" },
    { fieldName: "recipient_account", entity: "transaction", status: "encrypted", algorithm: "AES-256-GCM", keyVersion: "v2", description: "Target recipient financial identifier" }
  ];

  /**
   * Returns documented list of all encrypted fields in the platform.
   */
  public getEncryptedFieldsCatalog(): FieldEncryptionMetadata[] {
    return [...PiiTransparencyService.ENCRYPTED_FIELDS_CATALOG];
  }

  /**
   * Generates encryption status indicators for UI representation.
   */
  public getEncryptionIndicators(entity: string, data: Record<string, any>): Record<string, FieldEncryptionMetadata> {
    const indicators: Record<string, FieldEncryptionMetadata> = {};
    for (const catalogEntry of PiiTransparencyService.ENCRYPTED_FIELDS_CATALOG) {
      if (catalogEntry.entity === entity && catalogEntry.fieldName in data) {
        indicators[catalogEntry.fieldName] = { ...catalogEntry };
      }
    }
    return indicators;
  }

  /**
   * Automatically inspects unknown or unclassified payloads to detect potential PII leakage.
   */
  public detectPiiFields(payload: Record<string, any>): PiiDetectionResult[] {
    const results: PiiDetectionResult[] = [];

    const patterns = {
      SSN: /^\d{3}-\d{2}-\d{4}$/,
      CREDIT_CARD: /^(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})$/,
      EMAIL: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
      PHONE: /^\+?[1-9]\d{1,14}$/,
      IBAN: /^[A-Z]{2}[0-9]{2}[A-Z0-9]{4}[0-9]{7}([A-Z0-9]?){0,16}$/
    };

    for (const [key, value] of Object.entries(payload)) {
      if (typeof value !== "string") continue;
      const cleanVal = value.trim();

      if (patterns.SSN.test(cleanVal)) {
        results.push({ detected: true, fieldCandidate: key, piiType: "SSN", riskLevel: "HIGH" });
      } else if (patterns.CREDIT_CARD.test(cleanVal.replace(/[\s-]/g, ""))) {
        results.push({ detected: true, fieldCandidate: key, piiType: "CREDIT_CARD", riskLevel: "HIGH" });
      } else if (patterns.IBAN.test(cleanVal.replace(/\s/g, ""))) {
        results.push({ detected: true, fieldCandidate: key, piiType: "IBAN", riskLevel: "HIGH" });
      } else if (patterns.EMAIL.test(cleanVal)) {
        results.push({ detected: true, fieldCandidate: key, piiType: "EMAIL", riskLevel: "MEDIUM" });
      } else if (patterns.PHONE.test(cleanVal.replace(/[\s()-]/g, ""))) {
        results.push({ detected: true, fieldCandidate: key, piiType: "PHONE", riskLevel: "MEDIUM" });
      }
    }

    if (results.length > 0) {
      logger.warn(`[PiiTransparency] Auto-detected ${results.length} sensitive PII fields in request payload`);
    }

    return results;
  }

  /**
   * Mask sensitive PII for safe display in UI
   */
  public maskValue(value: string, type: "SSN" | "CREDIT_CARD" | "EMAIL" | "PHONE" | "GENERAL"): string {
    if (!value || value.length < 4) return "****";
    switch (type) {
      case "EMAIL": {
        const [user, domain] = value.split("@");
        if (!domain) return "****";
        const maskedUser = user.length > 2 ? user[0] + "***" + user[user.length - 1] : user[0] + "***";
        return `${maskedUser}@${domain}`;
      }
      case "SSN":
      case "CREDIT_CARD":
      case "PHONE":
      default:
        return "*".repeat(value.length - 4) + value.slice(-4);
    }
  }
}

export const piiTransparencyService = new PiiTransparencyService();
