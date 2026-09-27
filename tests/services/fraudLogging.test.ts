import * as metrics from '../../src/utils/metrics';
import { FraudService, FraudTransactionInput, FraudResult } from '../../src/services/fraud';
import { Transaction, TransactionStatus } from '../../src/models/transaction';
import { redisClient } from '../../src/config/redis';
import logger from '../../src/utils/logger';

// Mock the FraudAlertModel
jest.mock('../../src/models/fraudAlert', () => {
  const mockCreate = jest.fn().mockResolvedValue({
    id: 'alert-1',
    transactionId: 'txn-1',
    userId: 'user-1',
    score: 55,
    riskLevel: 'high',
    recommendedAction: 'review',
    reasons: ['test reason'],
    heuristicsTriggered: ['test'],
    heuristicDetails: {},
    userContext: {},
    status: 'flagged',
    isFalsePositive: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  return {
    FraudAlertModel: jest.fn().mockImplementation(() => ({
      create: mockCreate,
      findById: jest.fn().mockResolvedValue(null),
      findByTransactionId: jest.fn().mockResolvedValue([]),
      list: jest.fn().mockResolvedValue({ alerts: [], total: 0, flaggedCount: 0 }),
      findByUserId: jest.fn().mockResolvedValue({ alerts: [], total: 0, flaggedCount: 0 }),
      review: jest.fn().mockResolvedValue(null),
      markFalsePositive: jest.fn().mockResolvedValue(null),
      getReviewHistory: jest.fn().mockResolvedValue([]),
      getStatistics: jest.fn().mockResolvedValue({
        totalAlerts: 0,
        flaggedAlerts: 0,
        falsePositives: 0,
        confirmedFraud: 0,
        averageScore: 0,
        riskLevelBreakdown: { low: 0, medium: 0, high: 0, critical: 0 },
      }),
    })),
    __mockCreate: mockCreate,
  };
});

describe('FraudService - Fraud Detection Logging', () => {
  let fraudService: FraudService;
  let transactionTotalSpy: jest.SpyInstance;
  let transactionErrorsTotalSpy: jest.SpyInstance;
  const baseNow = new Date('2026-03-28T10:00:00.000Z');

  const createBaseFraudInput = (overrides: Partial<FraudTransactionInput> = {}): FraudTransactionInput => ({
    id: 'txn-1',
    userId: 'user-1',
    amount: 100,
    phoneNumber: '+15551234567',
    timestamp: baseNow,
    location: { lat: 0, lng: 0 },
    status: 'SUCCESS',
    ipAddress: '192.168.1.1',
    userAgent: 'test-agent',
    deviceFingerprint: 'device-1',
    type: 'deposit',
    provider: 'test-provider',
    metadata: {},
    ...overrides,
  });

  const createBaseTransaction = (overrides: Partial<Transaction> = {}): Transaction => ({
    id: 'txn-1',
    userId: 'user-1',
    amount: '100',
    phoneNumber: '+15551234567',
    createdAt: baseNow,
    locationMetadata: { status: 'resolved', country: 'US', city: 'New York' },
    status: TransactionStatus.Success,
    provider: 'test-provider',
    type: 'deposit',
    metadata: {},
    ...overrides,
  });

  beforeEach(() => {
    fraudService = new FraudService();
    transactionTotalSpy = jest.spyOn(metrics.transactionTotal, 'inc').mockImplementation(() => metrics.transactionTotal);
    transactionErrorsTotalSpy = jest.spyOn(metrics.transactionErrorsTotal, 'inc').mockImplementation(() => metrics.transactionErrorsTotal);

    // Clear mock call counts between tests
    const { __mockCreate } = require('../../src/models/fraudAlert');
    __mockCreate.mockClear();
    __mockCreate.mockResolvedValue({
      id: 'alert-1',
      transactionId: 'txn-1',
      userId: 'user-1',
      score: 55,
      riskLevel: 'high',
      recommendedAction: 'review',
      reasons: ['test reason'],
      heuristicsTriggered: ['test'],
      heuristicDetails: {},
      userContext: {},
      status: 'flagged',
      isFalsePositive: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    (redisClient as any).get = jest.fn().mockResolvedValue(null);
    (redisClient as any).set = jest.fn().mockResolvedValue('OK');
    (redisClient as any).setex = jest.fn().mockResolvedValue('OK');
    (redisClient as any).smembers = jest.fn().mockResolvedValue(['device-1']);
    (redisClient as any).sadd = jest.fn().mockResolvedValue(1);
    (redisClient as any).expire = jest.fn().mockResolvedValue(1);

    jest.spyOn(fraudService as any, 'getUserTransactions').mockResolvedValue([]);
    (fraudService as any).userModel = {
      findById: jest.fn().mockResolvedValue(null),
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('logFraudAlert', () => {
    it('should persist fraud alert to database for flagged transactions', async () => {
      const { FraudAlertModel, __mockCreate } = require('../../src/models/fraudAlert');
      const transactionInput = createBaseFraudInput();
      const fraudResult: FraudResult = {
        isFraud: true,
        score: 55,
        reasons: ['Too many transactions'],
        riskLevel: 'high',
        heuristicsTriggered: ['velocity_check'],
        recommendedAction: 'review',
      };

      await fraudService.logFraudAlert(fraudResult, transactionInput, { kycLevel: 'tier1' }, 150);

      expect(__mockCreate).toHaveBeenCalledWith({
        transactionId: 'txn-1',
        userId: 'user-1',
        score: 55,
        riskLevel: 'high',
        recommendedAction: 'review',
        reasons: ['Too many transactions'],
        heuristicsTriggered: ['velocity_check'],
        heuristicDetails: {},
        userContext: { kycLevel: 'tier1' },
        durationMs: 150,
        transactionAmount: 100,
        transactionType: 'deposit',
        provider: 'test-provider',
        phoneNumber: '+15551234567',
      });
    });

    it('should not persist fraud alert to database for non-flagged transactions', async () => {
      const { FraudAlertModel, __mockCreate } = require('../../src/models/fraudAlert');
      const transactionInput = createBaseFraudInput();
      const fraudResult: FraudResult = {
        isFraud: false,
        score: 0,
        reasons: [],
        riskLevel: 'low',
        heuristicsTriggered: [],
        recommendedAction: 'allow',
      };

      await fraudService.logFraudAlert(fraudResult, transactionInput);

      expect(__mockCreate).not.toHaveBeenCalled();
    });

    it('should handle database persistence errors gracefully', async () => {
      const { FraudAlertModel, __mockCreate } = require('../../src/models/fraudAlert');
      __mockCreate.mockRejectedValueOnce(new Error('Database error'));

      const transactionInput = createBaseFraudInput();
      const fraudResult: FraudResult = {
        isFraud: true,
        score: 80,
        reasons: ['Critical fraud'],
        riskLevel: 'critical',
        heuristicsTriggered: ['velocity_check'],
        recommendedAction: 'block',
      };

      // Should not throw even if database fails
      await expect(
        fraudService.logFraudAlert(fraudResult, transactionInput)
      ).resolves.not.toThrow();
    });
  });

  describe('processTransaction with DB persistence', () => {
    it('should persist fraud alert when transaction is flagged', async () => {
      const { FraudAlertModel, __mockCreate } = require('../../src/models/fraudAlert');
      const userTransactions: Transaction[] = Array.from({ length: 6 }, (_, i) =>
        createBaseTransaction({
          id: `txn-${i}`,
          createdAt: new Date(baseNow.getTime() - i * 5 * 60 * 1000),
        })
      );

      const lowThresholdService = new FraudService({ fraudScoreThreshold: 20 });
      jest.spyOn(lowThresholdService as any, 'getUserTransactions').mockResolvedValue(userTransactions);
      (lowThresholdService as any).userModel = {
        findById: jest.fn().mockResolvedValue(null),
      };

      const transactionInput = createBaseFraudInput({ amount: 1000 });
      const result = await lowThresholdService.processTransaction(transactionInput);

      expect(result.isFraud).toBe(true);
      expect(__mockCreate).toHaveBeenCalled();
    });

    it('should not persist fraud alert when transaction passes', async () => {
      const { FraudAlertModel, __mockCreate } = require('../../src/models/fraudAlert');

      const transactionInput = createBaseFraudInput();
      const result = await fraudService.processTransaction(transactionInput);

      expect(result.isFraud).toBe(false);
      expect(__mockCreate).not.toHaveBeenCalled();
    });

    it('should include user context in persisted alert', async () => {
      const { FraudAlertModel, __mockCreate } = require('../../src/models/fraudAlert');
      const userTransactions: Transaction[] = Array.from({ length: 6 }, (_, i) =>
        createBaseTransaction({
          id: `txn-${i}`,
          createdAt: new Date(baseNow.getTime() - i * 5 * 60 * 1000),
        })
      );

      const lowThresholdService = new FraudService({ fraudScoreThreshold: 20 });
      jest.spyOn(lowThresholdService as any, 'getUserTransactions').mockResolvedValue(userTransactions);
      (lowThresholdService as any).userModel = {
        findById: jest.fn().mockResolvedValue({
          kycLevel: 'tier2',
          createdAt: new Date('2026-03-01'),
          phoneNumber: '+15551234567',
        }),
      };

      const transactionInput = createBaseFraudInput({ amount: 1000 });
      await lowThresholdService.processTransaction(transactionInput);

      expect(__mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          userContext: expect.objectContaining({
            kycLevel: 'tier2',
          }),
        })
      );
    });
  });

  describe('getFraudAlertModel', () => {
    it('should return the fraud alert model instance', () => {
      const model = fraudService.getFraudAlertModel();
      expect(model).toBeDefined();
    });
  });
});
