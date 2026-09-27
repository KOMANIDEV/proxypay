import { queryRead, queryWrite } from "../config/database";
import { v4 as uuidv4 } from "uuid";
import * as StellarSdk from "stellar-sdk";
import { AssetIssuanceService } from "../services/stellar/issuanceService";
import logger from "../utils/logger";
import {
  AssetConfigurationError,
  AssetConfigurationInput,
  AssetConfigurationValidation,
  AssetCreationRateLimiter,
  AssetCreationRateLimitError,
  validateAssetConfiguration,
} from "./assetWorkflowValidation";

export type AssetWorkflowStatus = "draft" | "pending_approval" | "approved" | "rejected" | "issuing" | "completed" | "failed";
export type ApprovalAction = "approve" | "reject" | "request_changes";

export interface AssetIssuanceRequest {
  id: string;
  assetCode: string;
  name: string;
  description?: string;
  limit: string;
  status: AssetWorkflowStatus;
  requestedBy: string;
  approvedBy?: string;
  approvalNotes?: string;
  metadata: Record<string, any>;
  trustlineConfig?: {
    destinationAccount: string;
    limit: string;
    autoSetup: boolean;
  };
  createdAt: Date;
  updatedAt: Date;
}

export type { AssetConfigurationValidation };

/** PostgreSQL unique-violation. The authority on "this asset code is taken". */
const PG_UNIQUE_VIOLATION = "23505";

/**
 * Is this a valid Stellar account public key?
 *
 * Uses the SDK's own check rather than a regex, because the account id is a
 * base32-encoded CRC-checked payload: a regex can be satisfied by a string the
 * SDK will still reject, and the SDK is what will actually be handed this value
 * when the asset is issued.
 */
export function isValidStellarAccount(account: string): boolean {
  if (!account || typeof account !== "string") return false;
  return StellarSdk.StrKey.isValidEd25519PublicKey(account.trim());
}

/**
 * Issuers this platform is allowed to issue assets under (#571).
 *
 * Built from three sources, in the spirit of "an operator should not have to
 * repeat themselves":
 *
 *   1. `ASSET_ISSUER_WHITELIST` — a comma-separated list of public keys.
 *   2. The platform's own issuer, derived from `STELLAR_ISSUER_SECRET`, since
 *      an operator issuing under their own key obviously needs no permission.
 *   3. Nothing, if neither is set — see below.
 *
 * An unset whitelist is treated as "not configured" rather than "nothing is
 * allowed", so an existing deployment is not broken by adding a check it never
 * opted into. That choice is a real trade-off and worth stating: it means the
 * whitelist protects only the deployments that configure one, and a
 * misconfigured value that parses to nothing therefore disables the protection
 * silently. It logs a warning when it does.
 */
export function allowedIssuers(): Set<string> {
  const configured = new Set<string>();

  const fromEnv = (process.env.ASSET_ISSUER_WHITELIST || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const issuer of fromEnv) {
    if (isValidStellarAccount(issuer)) {
      configured.add(issuer.trim());
    } else {
      logger.warn(
        { issuer },
        "[asset-workflow] ASSET_ISSUER_WHITELIST entry is not a valid Stellar account and was ignored",
      );
    }
  }

  // The platform's own issuer is implicitly allowed. Derived from the secret
  // only to get its public half, and never logged.
  const issuerSecret = (process.env.STELLAR_ISSUER_SECRET || "").trim();
  if (issuerSecret) {
    try {
      configured.add(StellarSdk.Keypair.fromSecret(issuerSecret).publicKey());
    } catch {
      logger.warn(
        "[asset-workflow] STELLAR_ISSUER_SECRET is set but not parseable; its issuer is not on the allowlist",
      );
    }
  }

  return configured;
}

/** Has an issuer allowlist been configured at all? */
export function isIssuerAllowlistConfigured(): boolean {
  return (process.env.ASSET_ISSUER_WHITELIST || "").trim().length > 0;
}

/**
 * May this issuer issue assets through this platform?
 *
 * When no allowlist is configured, any syntactically valid issuer is allowed
 * and the decision is logged, because silently refusing every request in a
 * deployment that never set the variable would look like an outage.
 */
export function isIssuerAllowed(issuer: string): boolean {
  if (!isIssuerAllowlistConfigured()) {
    logger.warn(
      { issuer },
      "[asset-workflow] no ASSET_ISSUER_WHITELIST configured; accepting any valid issuer",
    );
    return true;
  }
  return allowedIssuers().has(issuer.trim());
}

export class AssetIssuanceRequestModel {
  async create(input: {
    assetCode: string;
    name: string;
    description?: string;
    limit: string;
    requestedBy: string;
    metadata?: Record<string, any>;
    trustlineConfig?: { destinationAccount: string; limit: string; autoSetup: boolean };
    metadata?: Record<string, unknown>;
  }): Promise<AssetIssuanceRequest> {
    const id = uuidv4();

    // A friendly fast path, not the guarantee. Two requests for the same code
    // that arrive together both get past this SELECT; only the unique index in
    // migration 20260830 can actually arbitrate between them. The INSERT below
    // is therefore what decides, and its error is handled rather than allowed to
    // surface as a 500.
    const existing = await this.findByCode(input.assetCode);
    if (existing) {
      throw new Error(`Asset code ${input.assetCode} already exists`);
    }

    try {
      const result = await queryWrite(
        `INSERT INTO asset_issuance_requests (id, asset_code, name, description, limit, status, requested_by, trustline_config, metadata)
         VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8)
         RETURNING *`,
        [
          id,
          input.assetCode,
          input.name,
          input.description || null,
          input.limit,
          input.requestedBy,
          input.trustlineConfig ? JSON.stringify(input.trustlineConfig) : null,
          JSON.stringify(input.metadata || {}),
        ],
      );

      return this.mapRow(result.rows[0]);
    } catch (error) {
      // The concurrent-insert case the SELECT above cannot see. Reported with
      // the same message as the fast path so callers can handle one error
      // instead of two, and logged at warn because it is expected traffic on a
      // busy asset code rather than a fault.
      if ((error as { code?: string })?.code === PG_UNIQUE_VIOLATION) {
        logger.warn(
          { assetCode: input.assetCode },
          "[asset-workflow] Duplicate asset code rejected by unique constraint",
        );
        throw new Error(`Asset code ${input.assetCode} already exists`);
      }
      throw error;
    }
  }

  async findById(id: string): Promise<AssetIssuanceRequest | null> {
    const result = await queryRead("SELECT * FROM asset_issuance_requests WHERE id = $1", [id]);
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findByCode(assetCode: string): Promise<AssetIssuanceRequest | null> {
    const result = await queryRead("SELECT * FROM asset_issuance_requests WHERE asset_code = $1", [assetCode]);
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findAll(status?: AssetWorkflowStatus): Promise<AssetIssuanceRequest[]> {
    let query = "SELECT * FROM asset_issuance_requests";
    if (status) {
      query += ` WHERE status = $1`;
      const result = await queryRead(query, [status]);
      return result.rows.map((r) => this.mapRow(r));
    }
    const result = await queryRead(query);
    return result.rows.map((r) => this.mapRow(r));
  }

  async updateStatus(id: string, status: AssetWorkflowStatus, approvedBy?: string, approvalNotes?: string): Promise<void> {
    await queryWrite(
      `UPDATE asset_issuance_requests SET status = $1, approved_by = $2, approval_notes = $3, updated_at = NOW() WHERE id = $4`,
      [status, approvedBy || null, approvalNotes || null, id],
    );
  }

  async updateTrustlineConfig(id: string, config: { destinationAccount: string; limit: string; autoSetup: boolean }): Promise<void> {
    await queryWrite(
      `UPDATE asset_issuance_requests SET trustline_config = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(config), id],
    );
  }

  private mapRow(row: any): AssetIssuanceRequest {
    return {
      id: row.id,
      assetCode: row.asset_code,
      name: row.name,
      description: row.description,
      limit: row.limit,
      status: row.status,
      requestedBy: row.requested_by,
      approvedBy: row.approved_by,
      approvalNotes: row.approval_notes,
      metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
      trustlineConfig: row.trustline_config ? (typeof row.trustline_config === "string" ? JSON.parse(row.trustline_config) : row.trustline_config) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export class AssetWorkflowService {
  private requestModel = new AssetIssuanceRequestModel();
  private issuanceService = new AssetIssuanceService();
  private creationLimiter = new AssetCreationRateLimiter();

  /** Swappable for tests (deterministic clock / raised limits). */
  setCreationRateLimiter(limiter: AssetCreationRateLimiter): void {
    this.creationLimiter = limiter;
  }

  async createRequest(input: {
    assetCode: string;
    name: string;
    description?: string;
    limit: string;
    requestedBy: string;
    issuer?: string;
    trustlineConfig?: { destinationAccount: string; limit: string; autoSetup: boolean };
  }): Promise<AssetIssuanceRequest> {
    // The issuer is validated here rather than at approval time. An asset
    // request is a promise to a requester, and finding out at approval that the
    // issuer was never allowed is a week of someone's time spent for nothing.
    const validation = this.validateConfiguration({
      assetCode: input.assetCode,
      name: input.name,
      limit: input.limit,
      issuer: input.issuer,
      distributionAccount: input.trustlineConfig?.destinationAccount,
    });
    if (!validation.isValid) {
      throw new AssetConfigurationError(validation.errors, validation.warnings);
    }

    // The issuer is persisted in the existing metadata JSONB rather than in a
    // new column: it is provenance for the request, not something the workflow
    // queries on, and a nullable column that is only ever read by id is a
    // column that will drift out of sync with reality.
    const request = await this.requestModel.create({
      assetCode: input.assetCode,
      name: input.name,
      description: input.description,
      limit: input.limit,
      requestedBy: input.requestedBy,
      trustlineConfig: input.trustlineConfig,
      metadata: { issuer: input.issuer ?? null },
    });
    logger.info({ requestId: request.id, assetCode: input.assetCode }, "[asset-workflow] Request created");

    return request;
  }

  /**
   * Duplicate business-rule check (issue #571).
   *
   * Exact duplicates are rejected by the persistence layer too, but doing it
   * here gives a typed error and covers case-insensitive collisions such as
   * `usdco` vs `USDCO`, which the exact-match lookup misses.
   */
  private async findDuplicateAssetCode(
    assetCode: string,
  ): Promise<{ id: string; assetCode: string; exact: boolean } | null> {
    const exact = await this.requestModel.findByCode(assetCode);
    if (exact) {
      return { id: exact.id, assetCode: exact.assetCode, exact: true };
    }
    const all = await this.requestModel.findAll();
    const collision = all.find(
      (request) => request.assetCode.toUpperCase() === assetCode.toUpperCase(),
    );
    return collision
      ? { id: collision.id, assetCode: collision.assetCode, exact: false }
      : null;
  }

  async approveRequest(id: string, approverId: string, action: ApprovalAction, notes?: string): Promise<AssetIssuanceRequest> {
    const request = await this.requestModel.findById(id);
    if (!request) {
      throw new Error("Asset issuance request not found");
    }

    if (request.status !== "pending_approval") {
      throw new Error(`Cannot ${action} request in status: ${request.status}`);
    }

    if (action === "approve") {
      await this.requestModel.updateStatus(id, "approved", approverId, notes);
      await this.issueAsset(request);
    } else if (action === "reject") {
      await this.requestModel.updateStatus(id, "rejected", approverId, notes);
    } else {
      await this.requestModel.updateStatus(id, "draft", approverId, notes);
    }

    const updated = await this.requestModel.findById(id);
    logger.info({ requestId: id, action, approverId }, "[asset-workflow] Request updated");
    return updated!;
  }

  async submitForApproval(id: string): Promise<AssetIssuanceRequest> {
    const request = await this.requestModel.findById(id);
    if (!request) {
      throw new Error("Asset issuance request not found");
    }

    if (request.status !== "draft") {
      throw new Error(`Cannot submit request in status: ${request.status}`);
    }

    await this.requestModel.updateStatus(id, "pending_approval");
    logger.info({ requestId: id }, "[asset-workflow] Request submitted for approval");
    return (await this.requestModel.findById(id))!;
  }

  async configureTrustline(id: string, config: { destinationAccount: string; limit: string; autoSetup: boolean }): Promise<AssetIssuanceRequest> {
    const request = await this.requestModel.findById(id);
    if (!request) {
      throw new Error("Asset issuance request not found");
    }

    // The destination account is only persisted by this method, so this is the
    // first and last point at which a bad one can be caught. `autoSetup` is
    // checked as well as the plain save, because an invalid account saved now
    // is an invalid account submitted on-chain later by whoever runs the job.
    if (!isValidStellarAccount(config.destinationAccount)) {
      throw new Error(
        "Invalid asset configuration: Distribution account must be a valid Stellar account (G... public key)",
      );
    }

    if (!config.autoSetup) {
      await this.requestModel.updateTrustlineConfig(id, config);
      return (await this.requestModel.findById(id))!;
    }

    await this.setupTrustlineAutomatically(request.assetCode, config.destinationAccount, config.limit);
    await this.requestModel.updateTrustlineConfig(id, config);
    const updated = await this.requestModel.findById(id);
    logger.info({ requestId: id, destinationAccount: config.destinationAccount }, "[asset-workflow] Trustline configured");
    return updated!;
  }

  private async issueAsset(request: AssetIssuanceRequest): Promise<void> {
    await this.requestModel.updateStatus(request.id, "issuing");
    try {
      const setupResult = await this.issuanceService.setupAnchoredAsset(request.assetCode, request.limit);
      await this.requestModel.updateStatus(request.id, "completed");
      logger.info({ requestId: request.id, assetCode: request.assetCode }, "[asset-workflow] Asset issued successfully");
    } catch (error) {
      await this.requestModel.updateStatus(request.id, "failed");
      logger.error({ error, requestId: request.id }, "[asset-workflow] Asset issuance failed");
      throw error;
    }
  }

  private async setupTrustlineAutomatically(assetCode: string, destinationAccount: string, limit: string): Promise<void> {
    logger.info({ assetCode, destinationAccount, limit }, "[asset-workflow] Setting up trustline automatically");
  }

  /**
   * Validate an asset configuration before a request is created (#571).
   *
   * The three account checks exist because every one of them is a way to issue
   * an asset that nobody can trade. A malformed Stellar key is rejected by the
   * SDK at the moment of submission, hours or days after the request was
   * approved and somebody was told the work was done; a syntactically valid key
   * that is not ours is worse still, because the request succeeds and the
   * asset simply never appears.
   *
   * `issuer` and `distributionAccount` are optional rather than required so
   * that existing callers of this method keep working. Omitting them skips
   * those checks — which is why `createRequest` passes them explicitly.
   */
  validateConfiguration(config: {
    assetCode: string;
    name: string;
    limit: string;
    issuer?: string;
    distributionAccount?: string;
  }): AssetConfigurationValidation {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Stellar caps an asset code at 12 characters. The floor of 3 is ours, not
    // Stellar's: a 1-2 character code cannot be told apart from a typo at a
    // glance and there is no real asset code that short.
    if (!config.assetCode || config.assetCode.length < 3 || config.assetCode.length > 12) {
      errors.push("Asset code must be between 3 and 12 characters");
    }
    if (!/^[a-zA-Z0-9]+$/.test(config.assetCode || "")) {
      errors.push("Asset code must be alphanumeric");
    }
    if (!config.name || config.name.trim().length < 1) {
      errors.push("Asset name is required");
    }
    const limitNum = parseFloat(config.limit);
    if (isNaN(limitNum) || limitNum <= 0) {
      errors.push("Limit must be a positive number");
    }
    if (limitNum > 1000000000) {
      warnings.push("Limit is very high, please verify");
    }

    if (config.issuer !== undefined && !isValidStellarAccount(config.issuer)) {
      errors.push("Issuer must be a valid Stellar account (G... public key)");
    } else if (config.issuer && !isIssuerAllowed(config.issuer)) {
      // Reported as an error, not a warning. A non-whitelisted issuer is a
      // request to issue an asset this platform is not supposed to be issuing,
      // and approving it would be a mistake rather than a risk to be weighed.
      errors.push("Issuer is not on the configured issuer allowlist");
    }

    if (
      config.distributionAccount !== undefined &&
      !isValidStellarAccount(config.distributionAccount)
    ) {
      errors.push("Distribution account must be a valid Stellar account (G... public key)");
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  async getPendingApprovals(): Promise<AssetIssuanceRequest[]> {
    return this.requestModel.findAll("pending_approval");
  }
}

export const assetWorkflowService = new AssetWorkflowService();
