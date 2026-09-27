import crypto from "crypto";
import logger from "../utils/logger";

export interface SignatureKeyVersion {
  version: number;
  secret: string;
  createdAt: Date;
  expiresAt: Date;
  status: "ACTIVE" | "ROTATING" | "DEPRECATED" | "REVOKED";
}

export interface ProviderCallbackConfig {
  providerId: string;
  activeVersion: number;
  keys: SignatureKeyVersion[];
  rotationIntervalDays: number;
  gracePeriodHours: number;
}

export class ProviderCallbackSignatureService {
  private providerConfigs: Map<string, ProviderCallbackConfig> = new Map();

  constructor() {
    // Seed initial key for providers
    this.registerProvider("momo-mtn", 90, 48);
    this.registerProvider("stellar-anchor", 60, 24);
  }

  public registerProvider(providerId: string, rotationIntervalDays: number = 90, gracePeriodHours: number = 24): ProviderCallbackConfig {
    const initialKey: SignatureKeyVersion = {
      version: 1,
      secret: crypto.randomBytes(32).toString("hex"),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + rotationIntervalDays * 24 * 60 * 60 * 1000),
      status: "ACTIVE",
    };

    const config: ProviderCallbackConfig = {
      providerId,
      activeVersion: 1,
      keys: [initialKey],
      rotationIntervalDays,
      gracePeriodHours,
    };

    this.providerConfigs.set(providerId, config);
    return config;
  }

  /**
   * Rotate signature secret with zero-downtime grace period.
   * Keeps previous active key in "ROTATING" status during gracePeriodHours.
   */
  public rotateSignature(providerId: string): SignatureKeyVersion {
    const config = this.providerConfigs.get(providerId);
    if (!config) throw new Error(`Provider ${providerId} not found`);

    const currentKey = config.keys.find((k) => k.version === config.activeVersion);
    if (currentKey) {
      currentKey.status = "ROTATING";
      currentKey.expiresAt = new Date(Date.now() + config.gracePeriodHours * 60 * 60 * 1000);
    }

    const nextVersion = config.activeVersion + 1;
    const newKey: SignatureKeyVersion = {
      version: nextVersion,
      secret: crypto.randomBytes(32).toString("hex"),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + config.rotationIntervalDays * 24 * 60 * 60 * 1000),
      status: "ACTIVE",
    };

    config.keys.push(newKey);
    config.activeVersion = nextVersion;

    logger.info(`[SignatureRotation] Provider ${providerId} rotated to signature version v${nextVersion}`);
    return newKey;
  }

  /**
   * Compute signature for an outgoing callback using the current active key.
   */
  public signCallback(providerId: string, payload: string): { signature: string; version: number } {
    const config = this.providerConfigs.get(providerId);
    if (!config) throw new Error(`Provider ${providerId} not found`);

    const activeKey = config.keys.find((k) => k.version === config.activeVersion);
    if (!activeKey) throw new Error(`No active signature key found for ${providerId}`);

    const hmac = crypto.createHmac("sha256", activeKey.secret);
    hmac.update(payload);
    const signature = hmac.digest("hex");

    return { signature, version: activeKey.version };
  }

  /**
   * Verify callback signature with zero-downtime support (accepts current or valid grace-period keys).
   */
  public verifyCallback(providerId: string, payload: string, signature: string, versionHint?: number): boolean {
    const config = this.providerConfigs.get(providerId);
    if (!config) return false;

    const now = new Date();
    // Candidates are either the hinted version or any ACTIVE/ROTATING key that hasn't expired
    const candidateKeys = config.keys.filter((k) => {
      if (versionHint && k.version !== versionHint) return false;
      return (k.status === "ACTIVE" || k.status === "ROTATING") && k.expiresAt > now;
    });

    for (const key of candidateKeys) {
      const hmac = crypto.createHmac("sha256", key.secret);
      hmac.update(payload);
      const expected = hmac.digest("hex");

      if (crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) {
        return true;
      }
    }

    logger.warn(`[SignatureRotation] Callback signature verification failed for provider ${providerId}`);
    return false;
  }

  public getProviderKeys(providerId: string): SignatureKeyVersion[] {
    const config = this.providerConfigs.get(providerId);
    return config ? [...config.keys] : [];
  }
}

export const providerCallbackSignatureService = new ProviderCallbackSignatureService();
