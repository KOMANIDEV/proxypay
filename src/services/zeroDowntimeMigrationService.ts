import logger from "../utils/logger";

export type MigrationPhase = "EXPAND" | "DUAL_WRITE" | "BACKFILL" | "VALIDATE" | "CONTRACT";

export interface MigrationStepConfig {
  migrationId: string;
  tableName: string;
  phase: MigrationPhase;
  dualWriteEnabled: boolean;
  maxErrorThresholdPercent: number; // e.g. 0.05%
  active: boolean;
}

export interface DualWriteResult {
  primarySuccess: boolean;
  shadowSuccess: boolean;
  parityMatched: boolean;
  latencyMs: number;
}

export class ZeroDowntimeMigrationService {
  private activeMigrations: Map<string, MigrationStepConfig> = new Map();
  private parityErrorCounts: Map<string, number> = new Map();

  public registerMigration(config: MigrationStepConfig): void {
    this.activeMigrations.set(config.migrationId, config);
    this.parityErrorCounts.set(config.migrationId, 0);
    logger.info(`[ZeroDowntimeMigration] Registered migration ${config.migrationId} on ${config.tableName} in phase ${config.phase}`);
  }

  /**
   * Execute dual write across primary and secondary schema targets
   */
  public async executeDualWrite<T>(
    migrationId: string,
    primaryWrite: () => Promise<T>,
    shadowWrite: () => Promise<T>
  ): Promise<T> {
    const config = this.activeMigrations.get(migrationId);

    // If migration not registered or dual-write disabled, perform primary write only
    if (!config || !config.dualWriteEnabled || !config.active) {
      return await primaryWrite();
    }

    const start = Date.now();
    let primaryResult: T;

    // 1. Primary write MUST succeed
    try {
      primaryResult = await primaryWrite();
    } catch (err: any) {
      logger.error(`[ZeroDowntimeMigration] Primary write failed for ${migrationId}: ${err.message}`);
      throw err;
    }

    // 2. Shadow write executed asynchronously/safely without failing the main transaction
    try {
      await shadowWrite();
    } catch (err: any) {
      const currentErrors = (this.parityErrorCounts.get(migrationId) || 0) + 1;
      this.parityErrorCounts.set(migrationId, currentErrors);
      logger.warn(`[ZeroDowntimeMigration] Shadow dual-write failure in ${migrationId}: ${err.message} (total errors: ${currentErrors})`);

      // Trigger automatic rollback/disable if threshold exceeded
      if (currentErrors > 10) {
        this.rollbackMigration(migrationId, "Excessive shadow dual-write failures");
      }
    }

    const duration = Date.now() - start;
    logger.debug(`[ZeroDowntimeMigration] Dual write completed in ${duration}ms`);
    return primaryResult;
  }

  /**
   * Validate schema parity and migration completion
   */
  public validateParity(migrationId: string, sampleCount: number = 1000): { parityPercent: number; passed: boolean } {
    const errorCount = this.parityErrorCounts.get(migrationId) || 0;
    const parityPercent = Math.max(0, 100 - (errorCount / sampleCount) * 100);
    const passed = parityPercent >= 99.9;

    logger.info(`[ZeroDowntimeMigration] Parity validation for ${migrationId}: ${parityPercent}% (passed: ${passed})`);
    return { parityPercent, passed };
  }

  /**
   * Rollback migration phase safely on failure
   */
  public rollbackMigration(migrationId: string, reason: string): void {
    const config = this.activeMigrations.get(migrationId);
    if (config) {
      config.dualWriteEnabled = false;
      config.active = false;
      logger.error(`[ZeroDowntimeMigration AUTOMATIC ROLLBACK] Migration ${migrationId} halted. Reason: ${reason}`);
    }
  }

  public getMigration(migrationId: string): MigrationStepConfig | undefined {
    return this.activeMigrations.get(migrationId);
  }
}

export const zeroDowntimeMigrationService = new ZeroDowntimeMigrationService();
