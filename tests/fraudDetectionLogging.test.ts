import { fraudLoggingService } from '../src/services/fraudLoggingService';
import { FraudAlertModel } from '../src/models/fraudAlert';
import { FraudResult, FraudTransactionInput } from '../src/services/fraud';

// Mock the database pool
jest.mock('../src/config/database', () => ({
  pool: {
    query: jest.fn(),
  },
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid-1234'),
}));

jest.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { pool } from '../src/config/database';

const mockPool = pool as jest.Mocked<typeof pool>;

describe('FraudDetectionLogging', () => {
  const mockTransaction: FraudTransactionInput = {
    id: 'txn-123',
    userId: 'user-abc',
    amount: 5000,
    phoneNumber: '+1234567890',
    timestamp: new Date('2026-08-26T10:00:00Z'),
    type: 'deposit',
    provider: 'mtn',
    ipAddress: '192.168.1.1',
    userAgent: 'Mozilla/5.0',
    deviceFingerprint: 'fp-123',
  };

  const mockFraudResult: FraudResult = {
    isFraud: true,
    score: 75,
    reasons: ['Velocity check triggered', 'Amount anomaly detected'],
    riskLevel: 'high',
    heuristicsTriggered: ['velocity_check', 'amount_anomaly'],
    recommendedAction: 'review',
  };

  const mockCleanResult: FraudResult = {
    isFraud: false,
    score: 10,
    reasons: [],
    riskLevel: 'low',
    heuristicsTriggered: [],
    recommendedAction: 'allow',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('fraudLoggingService.logEvaluation', () => {
    it('should insert a fraud evaluation log into the database', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ id: 'mock-uuid-1234' }] });

      const logId = await fraudLoggingService.logEvaluation(
        mockFraudResult,
        mockTransaction,
        { velocity_check: { count: 6, threshold: 5 } },
        45,
        12,
      );

      expect(logId).toBe('mock-uuid-1234');
      expect(mockPool.query).toHaveBeenCalledTimes(1);
      const [query, params] = (mockPool.query as jest.Mock).mock.calls[0];
      expect(query).toContain('INSERT INTO fraud_evaluation_logs');
      expect(params).toContain('txn-123');
      expect(params).toContain('user-abc');
      expect(params).toContain(5000);
      expect(params).toContain(true);
      expect(params).toContain(75);
      expect(params).toContain('high');
    });

    it('should handle database errors gracefully', async () => {
      (mockPool.query as jest.Mock).mockRejectedValueOnce(new Error('DB connection lost'));

      const logId = await fraudLoggingService.logEvaluation(
        mockCleanResult,
        mockTransaction,
        {},
        30,
        0,
      );

      expect(logId).toBe('mock-uuid-1234');
      expect(mockPool.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('fraudLoggingService.createAlert', () => {
    it('should create a fraud alert for flagged transactions', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ id: 'mock-uuid-1234' }] });

      const alertId = await fraudLoggingService.createAlert(
        'eval-log-1',
        mockFraudResult,
        mockTransaction,
      );

      expect(alertId).toBe('mock-uuid-1234');
      const [query] = (mockPool.query as jest.Mock).mock.calls[0];
      expect(query).toContain('INSERT INTO fraud_alerts');
    });

    it('should handle database errors when creating alerts', async () => {
      (mockPool.query as jest.Mock).mockRejectedValueOnce(new Error('Constraint violation'));

      const alertId = await fraudLoggingService.createAlert(
        'eval-log-1',
        mockFraudResult,
        mockTransaction,
      );

      expect(alertId).toBeNull();
    });
  });

  describe('fraudLoggingService.getHistory', () => {
    it('should return fraud evaluation history for a user', async () => {
      const mockRows = [
        {
          id: 'log-1',
          transactionId: 'txn-123',
          userId: 'user-abc',
          amount: 5000,
          phoneNumber: '+1234567890',
          provider: 'mtn',
          type: 'deposit',
          status: null,
          ipAddress: '192.168.1.1',
          userAgent: 'Mozilla/5.0',
          deviceFingerprint: 'fp-123',
          isFraud: true,
          score: 75,
          riskLevel: 'high',
          recommendedAction: 'review',
          reasons: JSON.stringify(['Velocity check triggered']),
          heuristicsTriggered: JSON.stringify(['velocity_check']),
          heuristicDetails: JSON.stringify({ velocity_check: { count: 6 } }),
          durationMs: 45,
          transactionHistoryCount: 12,
          createdAt: new Date(),
        },
      ];

      (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: mockRows });

      const history = await fraudLoggingService.getHistory('user-abc', 50, 0);

      expect(history).toHaveLength(1);
      expect(history[0].transactionId).toBe('txn-123');
      expect(history[0].score).toBe(75);
      expect(history[0].reasons).toEqual(['Velocity check triggered']);
      expect(history[0].heuristicsTriggered).toEqual(['velocity_check']);
    });

    it('should return empty array on database error', async () => {
      (mockPool.query as jest.Mock).mockRejectedValueOnce(new Error('DB error'));

      const history = await fraudLoggingService.getHistory('user-abc');

      expect(history).toEqual([]);
    });
  });

  describe('fraudLoggingService.updateAlertFeedback', () => {
    it('should update alert feedback to false_positive', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ id: 'alert-1' }] });

      const success = await fraudLoggingService.updateAlertFeedback(
        'alert-1',
        'false_positive',
        'reviewer-1',
        'Legitimate transaction pattern',
      );

      expect(success).toBe(true);
      const [query, params] = (mockPool.query as jest.Mock).mock.calls[0];
      expect(query).toContain('UPDATE fraud_alerts');
      expect(params).toContain('false_positive');
      expect(params).toContain('reviewer-1');
      expect(params).toContain('Legitimate transaction pattern');
    });

    it('should update alert feedback to confirmed_fraud', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ id: 'alert-1' }] });

      const success = await fraudLoggingService.updateAlertFeedback(
        'alert-1',
        'confirmed_fraud',
        'reviewer-1',
      );

      expect(success).toBe(true);
    });

    it('should return false if alert not found', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      const success = await fraudLoggingService.updateAlertFeedback(
        'nonexistent',
        'false_positive',
        'reviewer-1',
      );

      expect(success).toBe(false);
    });

    it('should return false on database error', async () => {
      (mockPool.query as jest.Mock).mockRejectedValueOnce(new Error('DB error'));

      const success = await fraudLoggingService.updateAlertFeedback(
        'alert-1',
        'false_positive',
        'reviewer-1',
      );

      expect(success).toBe(false);
    });
  });

  describe('FraudAlertModel', () => {
    const alertModel = new FraudAlertModel();

    it('should find alert by id', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{
          id: 'alert-1',
          evaluationLogId: 'log-1',
          transactionId: 'txn-123',
          userId: 'user-abc',
          score: 75,
          riskLevel: 'high',
          recommendedAction: 'review',
          reasons: JSON.stringify(['Velocity check']),
          heuristicsTriggered: JSON.stringify(['velocity_check']),
          status: 'pending_review',
          feedback: null,
          feedbackBy: null,
          feedbackNotes: null,
          feedbackAt: null,
          createdAt: new Date(),
          updatedAt: null,
        }],
      });

      const alert = await alertModel.findById('alert-1');

      expect(alert).not.toBeNull();
      expect(alert!.id).toBe('alert-1');
      expect(alert!.score).toBe(75);
      expect(alert!.reasons).toEqual(['Velocity check']);
    });

    it('should return null if alert not found', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      const alert = await alertModel.findById('nonexistent');
      expect(alert).toBeNull();
    });

    it('should record feedback on an alert', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{
          id: 'alert-1',
          evaluationLogId: 'log-1',
          transactionId: 'txn-123',
          userId: 'user-abc',
          score: 75,
          riskLevel: 'high',
          recommendedAction: 'review',
          reasons: JSON.stringify(['Velocity check']),
          heuristicsTriggered: JSON.stringify(['velocity_check']),
          status: 'dismissed',
          feedback: 'false_positive',
          feedbackBy: 'reviewer-1',
          feedbackNotes: 'Legitimate',
          feedbackAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        }],
      });

      const alert = await alertModel.recordFeedback(
        'alert-1',
        'false_positive',
        'reviewer-1',
        'Legitimate',
      );

      expect(alert).not.toBeNull();
      expect(alert!.status).toBe('dismissed');
      expect(alert!.feedback).toBe('false_positive');
      expect(alert!.feedbackBy).toBe('reviewer-1');
    });

    it('should list alerts with filters', async () => {
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ count: '2' }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'alert-1',
              evaluationLogId: 'log-1',
              transactionId: 'txn-123',
              userId: 'user-abc',
              score: 75,
              riskLevel: 'high',
              recommendedAction: 'review',
              reasons: JSON.stringify([]),
              heuristicsTriggered: JSON.stringify([]),
              status: 'pending_review',
              feedback: null,
              feedbackBy: null,
              feedbackNotes: null,
              feedbackAt: null,
              createdAt: new Date(),
              updatedAt: null,
            },
          ],
        });

      const { alerts, total } = await alertModel.list({ userId: 'user-abc', limit: 10 });

      expect(total).toBe(2);
      expect(alerts).toHaveLength(1);
    });
  });
});
