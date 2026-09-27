import { Router } from "express";
import { AssetWizardController } from "../../controllers/admin/assetWizardController";
import { assetWorkflowService } from "../../services/assetWorkflowService";
import {
  AssetConfigurationError,
  AssetCreationRateLimitError,
} from "../../services/assetWorkflowValidation";
import { requireAdmin, logAdminAction } from "../admin";
import { createError } from "../../middleware/errorHandler";
import { ERROR_CODES } from "../../constants/errorCodes";
import { assetIssuanceRateLimiter } from "../../middleware/rateLimit";

const router = Router();
const controller = new AssetWizardController();

router.use(requireAdmin);
router.use(logAdminAction("ASSET_ADMIN"));

/**
 * @openapi
 * /api/admin/assets:
 *   get:
 *     summary: List all anchored assets
 *     tags: [Admin, Assets]
 *     responses:
 *       200:
 *         description: List of assets
 */
router.get("/", controller.listAssets);

/**
 * @openapi
 * /api/admin/assets/issue:
 *   post:
 *     summary: Issue a new anchored asset on Stellar
 *     tags: [Admin, Assets]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [assetCode, limit, name]
 *             properties:
 *               assetCode: { type: string, example: "USDC" }
 *               limit: { type: string, example: "1000000" }
 *               name: { type: string, example: "USD Coin" }
 *               description: { type: string }
 *     responses:
 *       201:
 *         description: Asset issued successfully
 */
// The direct issuance endpoint, which creates a real on-chain asset rather
// than a request for one. It is the most privileged route in this file and was
// the only write path with no limit at all.
router.post("/issue", assetIssuanceRateLimiter, controller.issueAsset);

/**
 * @openapi
 * /api/admin/assets/workflow/requests:
 *   post:
 *     summary: Create asset issuance request
 *     tags: [Admin, Assets]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [assetCode, name, limit, requestedBy]
 *             properties:
 *               assetCode: { type: string }
 *               name: { type: string }
 *               description: { type: string }
 *               limit: { type: string }
 *               requestedBy: { type: string }
 *               issuer:
 *                 type: string
 *                 description: >
 *                   Stellar issuer account (G...). Must be a valid account and,
 *                   when ASSET_ISSUER_WHITELIST is configured, must appear on it.
 *                 example: "GB7IAH7O45YTUK5RYMREWBIEYV2W47H2EL7N4AU4J5Q5QK4T2QK5JFH"
 *     responses:
 *       201:
 *         description: Request created
 */
router.post("/workflow/requests", assetIssuanceRateLimiter, async (req, res, next) => {
  try {
    const { assetCode, name, description, limit, requestedBy, issuer, trustlineConfig } = req.body;
    const request = await assetWorkflowService.createRequest({
      assetCode,
      name,
      description,
      limit,
      requestedBy,
      issuer,
      trustlineConfig,
    });
    res.status(201).json({ success: true, data: request });
  } catch (error) {
    return next(createError(ERROR_CODES.INVALID_INPUT, error instanceof Error ? error.message : "Failed to create request");
  }
});

/**
 * @openapi
 * /api/admin/assets/workflow/requests:
 *   get:
 *     summary: List asset issuance requests
 *     tags: [Admin, Assets]
 *     responses:
 *       200:
 *         description: List of requests
 */
router.get("/workflow/requests", async (req, res, next) => {
  try {
    const { status } = req.query;
    const requests = await assetWorkflowService["requestModel"].findAll(status as any);
    res.json({ success: true, data: requests });
  } catch (error) {
    return next(createError(ERROR_CODES.INTERNAL_ERROR, "Failed to fetch requests");
  }
});

/**
 * @openapi
 * /api/admin/assets/workflow/requests/{id}/submit:
 *   post:
 *     summary: Submit request for approval
 *     tags: [Admin, Assets]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Request submitted
 */
router.post("/workflow/requests/:id/submit", assetIssuanceRateLimiter, async (req, res, next) => {
  try {
    const request = await assetWorkflowService.submitForApproval(req.params.id);
    res.json({ success: true, data: request });
  } catch (error) {
    return next(createError(ERROR_CODES.INVALID_INPUT, error instanceof Error ? error.message : "Failed to submit request");
  }
});

/**
 * @openapi
 * /api/admin/assets/workflow/requests/{id}/approve:
 *   post:
 *     summary: Approve or reject request
 *     tags: [Admin, Assets]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [action, approverId]
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [approve, reject, request_changes]
 *               approverId:
 *                 type: string
 *               notes:
 *                 type: string
 *     responses:
 *       200:
 *         description: Request updated
 */
router.post("/workflow/requests/:id/approve", assetIssuanceRateLimiter, async (req, res, next) => {
  try {
    const { action, approverId, notes } = req.body;
    const request = await assetWorkflowService.approveRequest(req.params.id, approverId, action, notes);
    res.json({ success: true, data: request });
  } catch (error) {
    return next(createError(ERROR_CODES.INVALID_INPUT, error instanceof Error ? error.message : "Failed to process approval");
  }
});

/**
 * @openapi
 * /api/admin/assets/workflow/requests/{id}/trustline:
 *   post:
 *     summary: Configure trustline for asset
 *     tags: [Admin, Assets]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [destinationAccount, limit]
 *             properties:
 *               destinationAccount:
 *                 type: string
 *               limit:
 *                 type: string
 *               autoSetup:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Trustline configured
 */
router.post("/workflow/requests/:id/trustline", assetIssuanceRateLimiter, async (req, res, next) => {
  try {
    const { destinationAccount, limit, autoSetup } = req.body;
    const request = await assetWorkflowService.configureTrustline(req.params.id, { destinationAccount, limit, autoSetup });
    res.json({ success: true, data: request });
  } catch (error) {
    return next(createError(ERROR_CODES.INVALID_INPUT, error instanceof Error ? error.message : "Failed to configure trustline");
  }
});

/**
 * @openapi
 * /api/admin/assets/workflow/validate:
 *   post:
 *     summary: Validate asset configuration
 *     tags: [Admin, Assets]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [assetCode, name, limit]
 *     responses:
 *       200:
 *         description: Validation result
 */
router.post("/workflow/validate", assetIssuanceRateLimiter, async (req, res, next) => {
  try {
    const { assetCode, name, limit } = req.body;
    const validation = assetWorkflowService.validateConfiguration({ assetCode, name, limit });
    res.json({ success: true, data: validation });
  } catch (error) {
    return next(createError(ERROR_CODES.INVALID_INPUT, "Validation failed");
  }
});

export default router;

