import { Request, Response, NextFunction } from "express";
import {
  WebhookRetryPolicyService,
  CreateRetryPolicyInput,
  UpdateRetryPolicyInput,
} from "../services/webhookRetryPolicyService";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";
import logger from "../utils/logger";
import { WebhookCircuitBreakerRegistry } from "../services/webhookCircuitBreaker";

const retryPolicyService = new WebhookRetryPolicyService();

interface AuthRequest extends Request {
  user?: {
    id: string;
    role: string;
    [key: string]: unknown;
  };
}

function requireAdminRole(req: Request): void {
  const user = (req as AuthRequest).user;
  if (!user || (user.role !== "admin" && user.role !== "super-admin")) {
    throw createError(ERROR_CODES.FORBIDDEN, "Admin access required", {
      message: "Admin access required",
    });
  }
}

export async function listRetryPolicies(req: Request, res: Response): Promise<void> {
  requireAdminRole(req);

  const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);
  const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;

  const { policies, total } = await retryPolicyService.list(limit, offset);
  res.json({ policies, total, limit, offset });
}

export async function getRetryPolicy(req: Request, res: Response): Promise<void> {
  requireAdminRole(req);

  const { id } = req.params;
  const policy = await retryPolicyService.getById(id);
  if (!policy) {
    throw createError(ERROR_CODES.NOT_FOUND, "Retry policy not found", {
      message: "Retry policy not found",
    });
  }
  res.json({ policy });
}

export async function createRetryPolicy(req: Request, res: Response): Promise<void> {
  requireAdminRole(req);

  const body = req.body as Record<string, unknown>;

  if (typeof body.merchantId !== "string" || !body.merchantId.trim()) {
    throw createError(ERROR_CODES.INVALID_INPUT, "merchantId is required", {
      message: "merchantId must be a non-empty string",
    });
  }

  const input: CreateRetryPolicyInput = {
    merchantId: body.merchantId,
  };

  if (body.maxAttempts !== undefined) input.maxAttempts = Number(body.maxAttempts);
  if (body.baseDelayMs !== undefined) input.baseDelayMs = Number(body.baseDelayMs);
  if (body.maxDelayMs !== undefined) input.maxDelayMs = Number(body.maxDelayMs);
  if (body.jitterFactor !== undefined) input.jitterFactor = Number(body.jitterFactor);
  if (body.backoffMultiplier !== undefined) input.backoffMultiplier = Number(body.backoffMultiplier);
  if (Array.isArray(body.retryableStatusCodes)) {
    input.retryableStatusCodes = body.retryableStatusCodes.map(Number);
  }

  const policy = await retryPolicyService.create(input);
  logger.info(
    { adminId: (req as AuthRequest).user?.id, merchantId: body.merchantId },
    "Retry policy created via admin",
  );

  res.status(201).json({ policy });
}

export async function updateRetryPolicy(req: Request, res: Response): Promise<void> {
  requireAdminRole(req);

  const { id } = req.params;
  const body = req.body as Record<string, unknown>;

  const input: UpdateRetryPolicyInput = {};
  if (body.maxAttempts !== undefined) input.maxAttempts = Number(body.maxAttempts);
  if (body.baseDelayMs !== undefined) input.baseDelayMs = Number(body.baseDelayMs);
  if (body.maxDelayMs !== undefined) input.maxDelayMs = Number(body.maxDelayMs);
  if (body.jitterFactor !== undefined) input.jitterFactor = Number(body.jitterFactor);
  if (body.backoffMultiplier !== undefined) input.backoffMultiplier = Number(body.backoffMultiplier);
  if (Array.isArray(body.retryableStatusCodes)) {
    input.retryableStatusCodes = body.retryableStatusCodes.map(Number);
  }
  if (body.isActive !== undefined) input.isActive = Boolean(body.isActive);

  const policy = await retryPolicyService.update(id, input);
  if (!policy) {
    throw createError(ERROR_CODES.NOT_FOUND, "Retry policy not found", {
      message: "Retry policy not found",
    });
  }

  logger.info(
    { adminId: (req as AuthRequest).user?.id, policyId: id },
    "Retry policy updated via admin",
  );

  res.json({ policy });
}

export async function deleteRetryPolicy(req: Request, res: Response): Promise<void> {
  requireAdminRole(req);

  const { id } = req.params;
  const deleted = await retryPolicyService.delete(id);
  if (!deleted) {
    throw createError(ERROR_CODES.NOT_FOUND, "Retry policy not found", {
      message: "Retry policy not found",
    });
  }

  logger.info(
    { adminId: (req as AuthRequest).user?.id, policyId: id },
    "Retry policy deleted via admin",
  );

  res.json({ deleted: true });
}

export async function getMerchantRetryMetrics(req: Request, res: Response): Promise<void> {
  requireAdminRole(req);

  const { merchantId } = req.params;
  if (!merchantId) {
    throw createError(ERROR_CODES.INVALID_INPUT, "merchantId is required", {
      message: "merchantId is required",
    });
  }

  const metrics = await retryPolicyService.getRetryMetrics(merchantId);
  res.json(metrics);
}

export async function getOrCreateDefaultsForMerchant(req: Request, res: Response): Promise<void> {
  requireAdminRole(req);

  const { merchantId } = req.params;
  if (!merchantId) {
    throw createError(ERROR_CODES.INVALID_INPUT, "merchantId is required", {
      message: "merchantId is required",
    });
  }

  const policy = await retryPolicyService.getOrCreateDefaults(merchantId);
  res.json({ policy });
}

export async function getWebhookCircuitBreakerState(req: Request, res: Response): Promise<void> {
  requireAdminRole(req);

  const url = typeof req.query.url === "string" ? req.query.url : "";
  if (!url) {
    throw createError(ERROR_CODES.INVALID_INPUT, "url query parameter is required", {
      message: "url query parameter is required",
    });
  }

  const breaker = WebhookCircuitBreakerRegistry.get(url);
  res.json({ url, ...breaker.snapshot() });
}

export async function resetWebhookCircuitBreaker(req: Request, res: Response): Promise<void> {
  requireAdminRole(req);

  const body = req.body as Record<string, unknown>;
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) {
    throw createError(ERROR_CODES.INVALID_INPUT, "url is required", {
      message: "url must be a non-empty string",
    });
  }

  const breaker = WebhookCircuitBreakerRegistry.reset(url);
  if (!breaker) {
    throw createError(ERROR_CODES.NOT_FOUND, "Circuit breaker not found for this webhook URL", {
      message: "No circuit breaker registered for the given webhook URL",
    });
  }

  logger.info(
    { adminId: (req as AuthRequest).user?.id, webhookUrl: url },
    "Webhook circuit breaker manually reset via admin",
  );

  res.json({ reset: true, url, ...breaker.snapshot() });
}
