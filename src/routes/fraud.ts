import { Router, Request, Response } from 'express';
import { FraudAlertModel, FraudAlertFilter, FraudReviewInput } from '../models/fraudAlert';
import { fraudService } from '../services/fraud';
import { requireAuth } from '../middleware/auth';
import logger from '../utils/logger';

export const fraudRoutes = Router();
const fraudAlertModel = new FraudAlertModel();

/**
 * GET /api/fraud/history/:userId
 * Retrieve fraud history for a specific user
 */
fraudRoutes.get('/history/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const { limit = '50', offset = '0' } = req.query;

    const result = await fraudAlertModel.findByUserId(
      userId,
      parseInt(limit as string),
      parseInt(offset as string),
    );

    res.json({
      alerts: result.alerts,
      total: result.total,
      flaggedCount: result.flaggedCount,
      hasMore: result.hasMore,
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get fraud history');
    res.status(500).json({ error: 'Failed to retrieve fraud history' });
  }
});

/**
 * GET /api/fraud/alerts
 * List all fraud alerts with filtering
 */
fraudRoutes.get('/alerts', requireAuth, async (req: Request, res: Response) => {
  try {
    const filter: FraudAlertFilter = {
      status: req.query.status as any,
      userId: req.query.userId as string,
      riskLevel: req.query.riskLevel as any,
      isFalsePositive: req.query.isFalsePositive === 'true' ? true : req.query.isFalsePositive === 'false' ? false : undefined,
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
      before: req.query.before as string,
      after: req.query.after as string,
    };

    if (req.query.startDate) {
      filter.startDate = new Date(req.query.startDate as string);
    }
    if (req.query.endDate) {
      filter.endDate = new Date(req.query.endDate as string);
    }

    const result = await fraudAlertModel.list(filter);

    res.json({
      alerts: result.alerts,
      total: result.total,
      flaggedCount: result.flaggedCount,
      hasMore: result.hasMore,
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to list fraud alerts');
    res.status(500).json({ error: 'Failed to list fraud alerts' });
  }
});

/**
 * GET /api/fraud/alerts/:alertId
 * Get a specific fraud alert by ID
 */
fraudRoutes.get('/alerts/:alertId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { alertId } = req.params;
    const alert = await fraudAlertModel.findById(alertId);

    if (!alert) {
      res.status(404).json({ error: 'Fraud alert not found' });
      return;
    }

    res.json(alert);
  } catch (error) {
    logger.error({ err: error }, 'Failed to get fraud alert');
    res.status(500).json({ error: 'Failed to retrieve fraud alert' });
  }
});

/**
 * GET /api/fraud/transactions/:transactionId
 * Get fraud alerts for a specific transaction
 */
fraudRoutes.get('/transactions/:transactionId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { transactionId } = req.params;
    const alerts = await fraudAlertModel.findByTransactionId(transactionId);

    res.json({ alerts });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get fraud alerts for transaction');
    res.status(500).json({ error: 'Failed to retrieve fraud alerts for transaction' });
  }
});

/**
 * POST /api/fraud/alerts/:alertId/review
 * Review a fraud alert
 */
fraudRoutes.post('/alerts/:alertId/review', requireAuth, async (req: Request, res: Response) => {
  try {
    const { alertId } = req.params;
    const { status, reviewNotes, isFalsePositive, falsePositiveReason } = req.body;
    const reviewerId = req.user?.id || 'system';

    if (!status) {
      res.status(400).json({ error: 'Status is required' });
      return;
    }

    const input: FraudReviewInput = {
      status,
      reviewNotes,
      isFalsePositive,
      falsePositiveReason,
    };

    const updatedAlert = await fraudAlertModel.review(alertId, input, reviewerId);

    if (!updatedAlert) {
      res.status(404).json({ error: 'Fraud alert not found' });
      return;
    }

    logger.info({
      alertId,
      reviewerId,
      status,
      isFalsePositive,
    }, 'Fraud alert reviewed');

    res.json(updatedAlert);
  } catch (error) {
    logger.error({ err: error }, 'Failed to review fraud alert');
    res.status(500).json({ error: 'Failed to review fraud alert' });
  }
});

/**
 * POST /api/fraud/alerts/:alertId/false-positive
 * Mark a fraud alert as a false positive
 */
fraudRoutes.post('/alerts/:alertId/false-positive', requireAuth, async (req: Request, res: Response) => {
  try {
    const { alertId } = req.params;
    const { reason } = req.body;
    const reviewerId = req.user?.id || 'system';

    if (!reason) {
      res.status(400).json({ error: 'Reason is required to mark as false positive' });
      return;
    }

    const updatedAlert = await fraudAlertModel.markFalsePositive(alertId, reason, reviewerId);

    if (!updatedAlert) {
      res.status(404).json({ error: 'Fraud alert not found' });
      return;
    }

    logger.info({
      alertId,
      reviewerId,
      reason,
    }, 'Fraud alert marked as false positive');

    res.json(updatedAlert);
  } catch (error) {
    logger.error({ err: error }, 'Failed to mark fraud alert as false positive');
    res.status(500).json({ error: 'Failed to mark fraud alert as false positive' });
  }
});

/**
 * GET /api/fraud/alerts/:alertId/history
 * Get review history for a fraud alert
 */
fraudRoutes.get('/alerts/:alertId/history', requireAuth, async (req: Request, res: Response) => {
  try {
    const { alertId } = req.params;
    const history = await fraudAlertModel.getReviewHistory(alertId);

    res.json({ history });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get fraud alert review history');
    res.status(500).json({ error: 'Failed to retrieve fraud alert review history' });
  }
});

/**
 * GET /api/fraud/statistics
 * Get fraud detection statistics
 */
fraudRoutes.get('/statistics', requireAuth, async (_req: Request, res: Response) => {
  try {
    const stats = await fraudAlertModel.getStatistics();

    res.json(stats);
  } catch (error) {
    logger.error({ err: error }, 'Failed to get fraud statistics');
    res.status(500).json({ error: 'Failed to retrieve fraud statistics' });
  }
});

/**
 * GET /api/fraud/review-queue
 * Get current in-memory review queue
 */
fraudRoutes.get('/review-queue', requireAuth, async (_req: Request, res: Response) => {
  try {
    const queue = fraudService.getReviewQueue();

    res.json({
      queue,
      count: queue.length,
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get review queue');
    res.status(500).json({ error: 'Failed to retrieve review queue' });
  }
});
