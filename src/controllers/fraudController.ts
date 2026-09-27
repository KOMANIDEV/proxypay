import { Request, Response } from 'express';
import { fraudLoggingService } from '../services/fraudLoggingService';
import { FraudAlertModel } from '../models/fraudAlert';
import logger from '../utils/logger';

const fraudAlertModel = new FraudAlertModel();

/**
 * GET /api/fraud/history/:userId
 * Retrieve fraud evaluation history for a specific user
 */
export const getFraudHistory = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    if (!userId) {
      res.status(400).json({ error: 'userId parameter is required' });
      return;
    }

    const history = await fraudLoggingService.getHistory(userId, limit, offset);

    res.json({
      userId,
      evaluations: history,
      pagination: { limit, offset, count: history.length },
    });
  } catch (error) {
    logger.error({ err: error, userId: req.params.userId }, 'Failed to retrieve fraud history');
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * GET /api/fraud/alerts
 * List all fraud alerts with optional filtering
 */
export const listFraudAlerts = async (req: Request, res: Response): Promise<void> => {
  try {
    const { status, userId, riskLevel, startDate, endDate, limit, offset } = req.query;

    const { alerts, total } = await fraudAlertModel.list({
      status: status as any,
      userId: userId as string,
      riskLevel: riskLevel as string,
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
      limit: parseInt(limit as string) || 50,
      offset: parseInt(offset as string) || 0,
    });

    res.json({
      alerts,
      total,
      pagination: {
        limit: parseInt(limit as string) || 50,
        offset: parseInt(offset as string) || 0,
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to list fraud alerts');
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * GET /api/fraud/alerts/:alertId
 * Get a specific fraud alert with full details
 */
export const getFraudAlert = async (req: Request, res: Response): Promise<void> => {
  try {
    const { alertId } = req.params;

    const alert = await fraudAlertModel.findById(alertId);
    if (!alert) {
      res.status(404).json({ error: 'Fraud alert not found' });
      return;
    }

    res.json({ alert });
  } catch (error) {
    logger.error({ err: error, alertId: req.params.alertId }, 'Failed to retrieve fraud alert');
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * POST /api/fraud/feedback
 * Submit feedback on a fraud alert (false positive or confirmed fraud)
 */
export const submitFeedback = async (req: Request, res: Response): Promise<void> => {
  try {
    const { alertId, feedback, feedbackBy, notes } = req.body;

    if (!alertId || !feedback || !feedbackBy) {
      res.status(400).json({
        error: 'Missing required fields',
        required: ['alertId', 'feedback', 'feedbackBy'],
      });
      return;
    }

    if (feedback !== 'false_positive' && feedback !== 'confirmed_fraud') {
      res.status(400).json({
        error: 'Invalid feedback value',
        message: 'feedback must be either "false_positive" or "confirmed_fraud"',
      });
      return;
    }

    const updatedAlert = await fraudAlertModel.recordFeedback(
      alertId,
      feedback,
      feedbackBy,
      notes,
    );

    if (!updatedAlert) {
      res.status(404).json({ error: 'Fraud alert not found' });
      return;
    }

    logger.info({ alertId, feedback, feedbackBy }, 'Fraud alert feedback submitted');

    res.json({
      message: 'Feedback recorded successfully',
      alert: updatedAlert,
    });
  } catch (error) {
    logger.error({ err: error, body: req.body }, 'Failed to submit fraud feedback');
    res.status(500).json({ error: 'Internal server error' });
  }
};
