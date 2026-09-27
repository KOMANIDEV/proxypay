import * as metrics from '../../src/utils/metrics';
import { FraudService, FraudTransactionInput, FraudResult } from '../../src/services/fraud';
import { Transaction, TransactionStatus } from '../../src/models/transaction';
import { redisClient } from '../../src/config/redis';
import logger from '../../src/utils/logger';

describe('FraudService', () => {
  let fraudService: FraudService;
  let lowThresholdService: FraudService;
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
    lowThresholdService = new FraudService({ fraudScoreThreshold: 20 });
    transactionTotalSpy = jest.spyOn(metrics.transactionTotal, 'inc').mockImplementation(() => metrics.transactionTotal);
    transactionErrorsTotalSpy = jest.spyOn(metrics.transactionErrorsTotal, 'inc').mockImplementation(() => metrics.transactionErrorsTotal);
    
    // Mock Redis client methods used by FraudService
    (redisClient as any).get = jest.fn().mockResolvedValue(null);
    (redisClient as any).set = jest.fn().mockResolvedValue('OK');
    (redisClient as any).setex = jest.fn().mockResolvedValue('OK');
    (redisClient as any).smembers = jest.fn().mockResolvedValue(['device-1']); // Return known device to avoid device anomaly
    (redisClient as any).sadd = jest.fn().mockResolvedValue(1);
    (redisClient as any).expire = jest.fn().mockResolvedValue(1);
    
    // Mock internal methods to avoid Redis/database calls
    jest.spyOn(fraudService as any, 'getUserTransactions').mockResolvedValue([]);
    (fraudService as any).userModel = {
      findById: jest.fn().mockResolvedValue(null),
    };
    jest.spyOn(lowThresholdService as any, 'getUserTransactions').mockResolvedValue([]);
    (lowThresholdService as any).userModel = {
      findById: jest.fn().mockResolvedValue(null),
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('detectFraud', () => {
    it('should not flag normal transaction', async () => {
      const transactionInput = createBaseFraudInput();
      
      const result = await fraudService.detectFraud(transactionInput);

      expect(result.isFraud).toBe(false);
      expect(result.score).toBe(0);
      expect(result.reasons).toHaveLength(0);
      expect(transactionTotalSpy).toHaveBeenCalledWith({ type: 'fraud_check', status: 'passed' });
      expect(transactionErrorsTotalSpy).not.toHaveBeenCalled();
    });

    it('should flag velocity anomaly', async () => {
      const userTransactions: Transaction[] = Array.from({ length: 6 }, (_, i) => 
        createBaseTransaction({ id: `txn-${i}`, amount: '100', createdAt: new Date(baseNow.getTime() - i * 5 * 60 * 1000) })
      );
      
      jest.spyOn(lowThresholdService as any, 'getUserTransactions').mockResolvedValue(userTransactions);
      (lowThresholdService as any).userModel = {
        findById: jest.fn().mockResolvedValue(null),
      };
      
      const transactionInput = createBaseFraudInput();
      const result = await lowThresholdService.detectFraud(transactionInput);

      expect(result.isFraud).toBe(true);
      expect(result.score).toBe(25); // velocity check only (25) - 5 min intervals don't trigger rapid_succession
      expect(result.reasons).toHaveLength(1);
      expect(result.reasons[0]).toBe('Too many transactions (6) in 1 hours');
      expect(transactionTotalSpy).toHaveBeenCalledWith({ type: 'fraud_check', status: 'flagged' });
      expect(transactionErrorsTotalSpy).toHaveBeenCalledWith({ type: 'fraud_detection', error_type: 'fraud_flagged' });
    });

    it('should flag amount anomaly', async () => {
      const userTransactions: Transaction[] = [
        createBaseTransaction({ amount: '10', createdAt: new Date(baseNow.getTime() - 30 * 60 * 1000) }),
      ];
      
      jest.spyOn(lowThresholdService as any, 'getUserTransactions').mockResolvedValue(userTransactions);
      (lowThresholdService as any).userModel = {
        findById: jest.fn().mockResolvedValue(null),
      };
      
      const transactionInput = createBaseFraudInput({ amount: 200 });
      const result = await lowThresholdService.detectFraud(transactionInput);

      expect(result.isFraud).toBe(true);
      expect(result.score).toBe(20); // amount anomaly only (20)
      expect(result.reasons.some(r => /Unusually large amount/.test(r))).toBe(true);
    });

    it('does not flag an amount exactly at the anomaly threshold', async () => {
      const service = new FraudService({ fraudScoreThreshold: 100 });
      const userTransactions: Transaction[] = [
        createBaseTransaction({ amount: '10', createdAt: new Date(baseNow.getTime() - 30 * 60 * 1000) }),
      ];
      
      jest.spyOn(service as any, 'getUserTransactions').mockResolvedValue(userTransactions);
      (service as any).userModel = {
        findById: jest.fn().mockResolvedValue(null),
      };
      
      const transactionInput = createBaseFraudInput({ amount: 100 });
      const result = await service.detectFraud(transactionInput);

      expect(result.score).toBe(0);
      expect(result.reasons).toEqual([]);
    });

    it('should flag geographic anomaly', async () => {
      const userTransactions: Transaction[] = [
        createBaseTransaction({
          locationMetadata: { status: 'resolved', country: 'US', city: 'New York' },
          createdAt: new Date(baseNow.getTime() - 30 * 60 * 1000),
        }),
      ];
      
      // Use a service with lower distance threshold to trigger the anomaly
      // The calculateDistance returns 500km as placeholder, so set threshold to 100
      const geoService = new FraudService({ 
        fraudScoreThreshold: 10,
        maxDistanceKm: 100, 
      });
      jest.spyOn(geoService as any, 'getUserTransactions').mockResolvedValue(userTransactions);
      (geoService as any).userModel = {
        findById: jest.fn().mockResolvedValue(null),
      };
      
      const transactionInput = createBaseFraudInput({ location: { lat: 10, lng: 10 } });
      const result = await geoService.detectFraud(transactionInput);

      expect(result.isFraud).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(20); // geo score
      expect(result.reasons[0]).toContain('Suspicious location change');
    });

    it('should flag failed attempts pattern', async () => {
      const lowScoreService = new FraudService({ fraudScoreThreshold: 10 });
      const userTransactions: Transaction[] = Array.from({ length: 3 }, (_, i) => 
        createBaseTransaction({ 
          id: `txn-${i}`, 
          status: TransactionStatus.Failed,
          createdAt: new Date(baseNow.getTime() - i * 10 * 60 * 1000),
        })
      );
      
      jest.spyOn(lowScoreService as any, 'getUserTransactions').mockResolvedValue(userTransactions);
      (lowScoreService as any).userModel = {
        findById: jest.fn().mockResolvedValue(null),
      };
      
      const transactionInput = createBaseFraudInput();
      const result = await lowScoreService.detectFraud(transactionInput);

      expect(result.isFraud).toBe(true);
      expect(result.score).toBe(15);
      expect(result.reasons.some(r => /Multiple failed attempts/.test(r))).toBe(true);
    });

    it('should handle empty transaction history', async () => {
      const transactionInput = createBaseFraudInput();
      const result = await fraudService.detectFraud(transactionInput);

      expect(result.isFraud).toBe(false);
      expect(result.score).toBe(0);
      expect(result.reasons).toEqual([]);
    });

    it('includes transactions exactly on the time-window boundary', async () => {
      const service = new FraudService({ fraudScoreThreshold: 20 });
      const userTransactions: Transaction[] = Array.from({ length: 5 }, (_, i) => 
        createBaseTransaction({ 
          id: `boundary-${i}`, 
          amount: '100',
          createdAt: new Date(baseNow.getTime() - 60 * 60 * 1000 + i * 1000),
        })
      );
      
      jest.spyOn(service as any, 'getUserTransactions').mockResolvedValue(userTransactions);
      (service as any).userModel = {
        findById: jest.fn().mockResolvedValue(null),
      };
      
      const transactionInput = createBaseFraudInput();
      const result = await service.detectFraud(transactionInput);

      expect(result.score).toBe(25); // velocity check only
      expect(result.reasons).toContain('Too many transactions (5) in 1 hours');
    });

    it('ignores old transactions outside the time window', async () => {
      const userTransactions: Transaction[] = Array.from({ length: 6 }, (_, i) => 
        createBaseTransaction({ 
          id: `old-${i}`, 
          amount: '10',
          status: TransactionStatus.Failed,
          createdAt: new Date(baseNow.getTime() - (2 * 60 * 60 * 1000 + i * 60 * 1000)),
        })
      );
      
      jest.spyOn(fraudService as any, 'getUserTransactions').mockResolvedValue(userTransactions);
      (fraudService as any).userModel = {
        findById: jest.fn().mockResolvedValue(null),
      };
      
      const transactionInput = createBaseFraudInput();
      const result = await fraudService.detectFraud(transactionInput);

      expect(result.isFraud).toBe(false);
      expect(result.score).toBe(0);
      expect(result.reasons).toEqual([]);
      expect(result.riskLevel).toBe('low');
      expect(result.heuristicsTriggered).toEqual([]);
      expect(result.recommendedAction).toBe('allow');
    });

    it('uses the most recent location when evaluating geographic anomalies', async () => {
      const userTransactions: Transaction[] = [
        createBaseTransaction({
          id: 'older-far',
          locationMetadata: { status: 'resolved', country: 'US', city: 'Los Angeles' },
          createdAt: new Date(baseNow.getTime() - 50 * 60 * 1000),
        }),
        createBaseTransaction({
          id: 'recent-near',
          locationMetadata: { status: 'resolved', country: 'US', city: 'New York' },
          createdAt: new Date(baseNow.getTime() - 5 * 60 * 1000),
        }),
      ];
      
      jest.spyOn(fraudService as any, 'getUserTransactions').mockResolvedValue(userTransactions);
      (fraudService as any).userModel = {
        findById: jest.fn().mockResolvedValue(null),
      };
      // Mock isNewDevice to return false (known device)
      jest.spyOn(fraudService as any, 'isNewDevice').mockResolvedValue(false);
      
      const transactionInput = createBaseFraudInput({ location: { lat: 0.01, lng: 0.01 } });
      const result = await fraudService.detectFraud(transactionInput);

      expect(result.score).toBe(0);
      expect(result.reasons).toEqual([]);
    });

    it('flags fraud exactly at the configured score threshold', async () => {
      const thresholdService = new FraudService({ fraudScoreThreshold: 40 });
      const userTransactions: Transaction[] = [
        createBaseTransaction({ id: 'txn-a', amount: '10', createdAt: new Date(baseNow.getTime() - 10 * 60 * 1000) }),
        createBaseTransaction({ id: 'txn-b', amount: '10', createdAt: new Date(baseNow.getTime() - 20 * 60 * 1000) }),
        createBaseTransaction({ id: 'txn-c', amount: '10', createdAt: new Date(baseNow.getTime() - 30 * 60 * 1000) }),
        createBaseTransaction({ id: 'txn-d', amount: '10', createdAt: new Date(baseNow.getTime() - 40 * 60 * 1000) }),
        createBaseTransaction({ id: 'txn-e', amount: '10', createdAt: new Date(baseNow.getTime() - 50 * 60 * 1000) }),
      ];
      
      jest.spyOn(thresholdService as any, 'getUserTransactions').mockResolvedValue(userTransactions);
      (thresholdService as any).userModel = {
        findById: jest.fn().mockResolvedValue(null),
      };
      
      const transactionInput = createBaseFraudInput({ amount: 200 });
      const result = await thresholdService.detectFraud(transactionInput);

      expect(result.score).toBeGreaterThanOrEqual(40); // velocity (25) + amount anomaly (20)
      expect(result.isFraud).toBe(true);
    });

    it('should accumulate multiple fraud signals into a combined score', async () => {
      const userTransactions: Transaction[] = [
        createBaseTransaction({ id: 'txn-0', amount: '10', status: TransactionStatus.Failed, createdAt: new Date(baseNow.getTime() - 5 * 60 * 1000) }),
        createBaseTransaction({ id: 'txn-1', amount: '10', status: TransactionStatus.Failed, createdAt: new Date(baseNow.getTime() - 10 * 60 * 1000) }),
        createBaseTransaction({ id: 'txn-2', amount: '10', status: TransactionStatus.Failed, createdAt: new Date(baseNow.getTime() - 15 * 60 * 1000) }),
        createBaseTransaction({ id: 'txn-3', amount: '10', createdAt: new Date(baseNow.getTime() - 20 * 60 * 1000) }),
        createBaseTransaction({ id: 'txn-4', amount: '10', createdAt: new Date(baseNow.getTime() - 25 * 60 * 1000) }),
      ];
      
      // Use a service with lower distance threshold to trigger geographic anomaly
      const multiService = new FraudService({ 
        fraudScoreThreshold: 20,
        maxDistanceKm: 100,
      });
      jest.spyOn(multiService as any, 'getUserTransactions').mockResolvedValue(userTransactions);
      (multiService as any).userModel = {
        findById: jest.fn().mockResolvedValue(null),
      };
      // Mock isNewDevice to return false (known device)
      jest.spyOn(multiService as any, 'isNewDevice').mockResolvedValue(false);
      
      const transactionInput = createBaseFraudInput({ 
        amount: 300, 
        location: { lat: 12, lng: 12 } 
      });
      const result = await multiService.detectFraud(transactionInput);

      expect(result.isFraud).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(60); // velocity + amount + pattern + geo
      expect(result.reasons).toContain('Too many transactions (5) in 1 hours');
      expect(result.reasons).toContain('Unusually large amount ($300 vs avg $10.00)');
      expect(result.reasons.some(r => r.includes('Suspicious location change') || r.includes('Transaction from new or unrecognized device'))).toBe(true);
      expect(result.reasons).toContain('Multiple failed attempts (3) in short time');
    });
  });

  describe('logFraudAlert', () => {
    it('logs only flagged transactions', () => {
      const transactionInput = createBaseFraudInput();
      const loggerSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

      fraudService.logFraudAlert({ isFraud: false, score: 0, reasons: [], riskLevel: 'low', heuristicsTriggered: [], recommendedAction: 'allow' }, transactionInput);
      expect(loggerSpy).not.toHaveBeenCalled();

      fraudService.logFraudAlert(
        { isFraud: true, score: 55, reasons: ['test reason'], riskLevel: 'high', heuristicsTriggered: ['test'], recommendedAction: 'review' },
        transactionInput,
      );

      expect(loggerSpy).toHaveBeenCalledTimes(1);
      expect(loggerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'WARN',
          type: 'FRAUD_ALERT',
          transactionId: 'txn-1',
          userId: 'user-1',
          score: 55,
          reasons: ['test reason'],
        }),
        'Fraud alert generated'
      );
      
      loggerSpy.mockRestore();
    });
  });

  describe('processTransaction', () => {
    it('should process and queue fraudulent transaction', async () => {
      const userTransactions: Transaction[] = Array.from({ length: 6 }, (_, i) => 
        createBaseTransaction({ 
          id: `txn-${i}`, 
          createdAt: new Date(baseNow.getTime() - i * 5 * 60 * 1000),
        })
      );
      
      jest.spyOn(lowThresholdService as any, 'getUserTransactions').mockResolvedValue(userTransactions);
      (lowThresholdService as any).userModel = {
        findById: jest.fn().mockResolvedValue(null),
      };
      
      const transactionInput = createBaseFraudInput({ amount: 1000 });
      const result = await lowThresholdService.processTransaction(transactionInput);

      expect(result.isFraud).toBe(true);
      expect(lowThresholdService.getReviewQueue()).toHaveLength(1);
    });

    it('should not queue non-fraudulent transactions', async () => {
      const transactionInput = createBaseFraudInput({ amount: 100 });
      const result = await fraudService.processTransaction(transactionInput);

      expect(result.isFraud).toBe(false);
      expect(fraudService.getReviewQueue()).toEqual([]);
    });
  });

  describe('review queue', () => {
    it('should manage review queue', () => {
      const loggerSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
      const transactionInput = createBaseFraudInput();

      fraudService.addToReviewQueue(transactionInput);
      expect(fraudService.getReviewQueue()).toHaveLength(1);
      expect(loggerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionId: 'txn-1',
          queueSize: 1,
        }),
        'Transaction added to review queue'
      );

      fraudService.clearReviewQueue();
      expect(fraudService.getReviewQueue()).toHaveLength(0);
      
      loggerSpy.mockRestore();
    });
  });
});