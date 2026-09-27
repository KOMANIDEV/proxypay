import { Router, Request, Response } from 'express';
import { WebhookRetryPolicyModel, WebhookRetryPolicyInput } from '../models/webhookRetryPolicy';
import { requireAuth } from '../middleware/auth';
import logger from '../utils/logger';

export const webhookRetryPolicyRoutes = Router();
const policyModel = new WebhookRetryPolicyModel();

/**
 * GET /api/admin/webhook-retry-policies
 * List all webhook retry policies
 */
webhookRetryPolicyRoutes.get('/', requireAuth, async (_req: Request, res: Response) => {
  try {
    const policies = await policyModel.list();
    res.json({ policies });
  } catch (error) {
    logger.error({ err: error }, 'Failed to list webhook retry policies');
    res.status(500).json({ error: 'Failed to list webhook retry policies' });
  }
});

/**
 * GET /api/admin/webhook-retry-policies/:merchantId
 * Get retry policy for a specific merchant
 */
webhookRetryPolicyRoutes.get('/:merchantId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { merchantId } = req.params;
    const policy = await policyModel.findByMerchantId(merchantId);

    if (!policy) {
      res.status(404).json({ error: 'No retry policy found for this merchant' });
      return;
    }

    res.json(policy);
  } catch (error) {
    logger.error({ err: error }, 'Failed to get webhook retry policy');
    res.status(500).json({ error: 'Failed to get webhook retry policy' });
  }
});

/**
 * POST /api/admin/webhook-retry-policies
 * Create or update a webhook retry policy for a merchant
 */
webhookRetryPolicyRoutes.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { merchantId, maxAttempts, baseDelayMs, maxDelayMs, multiplier, jitterFactor, enabled } = req.body;

    if (!merchantId) {
      res.status(400).json({ error: 'merchantId is required' });
      return;
    }

    if (maxAttempts !== undefined && (maxAttempts < 1 || maxAttempts > 10)) {
      res.status(400).json({ error: 'maxAttempts must be between 1 and 10' });
      return;
    }

    if (baseDelayMs !== undefined && baseDelayMs < 100) {
      res.status(400).json({ error: 'baseDelayMs must be at least 100' });
      return;
    }

    if (maxDelayMs !== undefined && maxDelayMs < 1000) {
      res.status(400).json({ error: 'maxDelayMs must be at least 1000' });
      return;
    }

    if (multiplier !== undefined && (multiplier < 1.0 || multiplier > 10.0)) {
      res.status(400).json({ error: 'multiplier must be between 1.0 and 10.0' });
      return;
    }

    if (jitterFactor !== undefined && (jitterFactor < 0 || jitterFactor > 1)) {
      res.status(400).json({ error: 'jitterFactor must be between 0 and 1' });
      return;
    }

    const input: WebhookRetryPolicyInput = {
      merchantId,
      maxAttempts,
      baseDelayMs,
      maxDelayMs,
      multiplier,
      jitterFactor,
      enabled,
    };

    const policy = await policyModel.create(input);

    logger.info({
      merchantId,
      maxAttempts: policy.maxAttempts,
      baseDelayMs: policy.baseDelayMs,
      maxDelayMs: policy.maxDelayMs,
    }, 'Webhook retry policy created/updated');

    res.status(201).json(policy);
  } catch (error) {
    logger.error({ err: error }, 'Failed to create webhook retry policy');
    res.status(500).json({ error: 'Failed to create webhook retry policy' });
  }
});

/**
 * PATCH /api/admin/webhook-retry-policies/:merchantId
 * Update an existing webhook retry policy
 */
webhookRetryPolicyRoutes.patch('/:merchantId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { merchantId } = req.params;
    const { maxAttempts, baseDelayMs, maxDelayMs, multiplier, jitterFactor, enabled } = req.body;

    const policy = await policyModel.update(merchantId, {
      maxAttempts,
      baseDelayMs,
      maxDelayMs,
      multiplier,
      jitterFactor,
      enabled,
    });

    if (!policy) {
      res.status(404).json({ error: 'No retry policy found for this merchant' });
      return;
    }

    logger.info({ merchantId, changes: req.body }, 'Webhook retry policy updated');

    res.json(policy);
  } catch (error) {
    logger.error({ err: error }, 'Failed to update webhook retry policy');
    res.status(500).json({ error: 'Failed to update webhook retry policy' });
  }
});

/**
 * DELETE /api/admin/webhook-retry-policies/:merchantId
 * Delete a webhook retry policy (reverts to defaults)
 */
webhookRetryPolicyRoutes.delete('/:merchantId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { merchantId } = req.params;
    const deleted = await policyModel.delete(merchantId);

    if (!deleted) {
      res.status(404).json({ error: 'No retry policy found for this merchant' });
      return;
    }

    logger.info({ merchantId }, 'Webhook retry policy deleted');

    res.json({ message: 'Retry policy deleted, merchant will use default configuration' });
  } catch (error) {
    logger.error({ err: error }, 'Failed to delete webhook retry policy');
    res.status(500).json({ error: 'Failed to delete webhook retry policy' });
  }
});
