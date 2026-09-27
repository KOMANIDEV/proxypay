import logger from "../utils/logger";

export interface ProtocolVersionInfo {
  currentVersion: number;
  minimumSupportedVersion: number;
  maximumSupportedVersion: number;
  upgradedAt?: Date;
  status: "supported" | "deprecated" | "unsupported";
}

export class StellarProtocolVersionManager {
  private currentVersion: number = 20; // Default current protocol version
  private minimumSupportedVersion: number = 19;
  private maximumSupportedVersion: number = 22;
  private versionHistory: Array<{ version: number; upgradedAt: Date; notes?: string }> = [
    { version: 19, upgradedAt: new Date("2023-09-01"), notes: "Initial production baseline" },
    { version: 20, upgradedAt: new Date("2024-02-20"), notes: "Soroban Smart Contracts enabled" },
  ];

  /**
   * Get current protocol version details
   */
  getProtocolVersion(): ProtocolVersionInfo {
    const isSupported =
      this.currentVersion >= this.minimumSupportedVersion &&
      this.currentVersion <= this.maximumSupportedVersion;

    return {
      currentVersion: this.currentVersion,
      minimumSupportedVersion: this.minimumSupportedVersion,
      maximumSupportedVersion: this.maximumSupportedVersion,
      status: isSupported ? "supported" : "unsupported",
    };
  }

  /**
   * Check whether a requested protocol version is compatible
   */
  isVersionCompatible(targetVersion: number): boolean {
    return targetVersion >= this.minimumSupportedVersion && targetVersion <= this.maximumSupportedVersion;
  }

  /**
   * Initiate protocol version upgrade workflow
   */
  async upgradeProtocolVersion(newVersion: number, notes?: string): Promise<ProtocolVersionInfo> {
    if (newVersion <= this.currentVersion) {
      throw new Error(`Target protocol version ${newVersion} must be greater than current version ${this.currentVersion}`);
    }

    if (newVersion > this.maximumSupportedVersion) {
      throw new Error(`Target protocol version ${newVersion} exceeds maximum supported version ${this.maximumSupportedVersion}`);
    }

    logger.info({ previousVersion: this.currentVersion, newVersion }, "Executing Stellar protocol version upgrade");
    this.currentVersion = newVersion;
    this.versionHistory.push({
      version: newVersion,
      upgradedAt: new Date(),
      notes,
    });

    return this.getProtocolVersion();
  }

  /**
   * Feature gate helper: verifies that current protocol supports a given feature
   */
  assertFeatureSupported(featureName: string, minRequiredProtocol: number): void {
    if (this.currentVersion < minRequiredProtocol) {
      throw new Error(
        `Feature '${featureName}' requires Stellar Protocol ${minRequiredProtocol}+, but current protocol is ${this.currentVersion}`
      );
    }
  }

  /**
   * Get protocol upgrade history
   */
  getVersionHistory() {
    return [...this.versionHistory];
  }
}

export const stellarProtocolVersionManager = new StellarProtocolVersionManager();
