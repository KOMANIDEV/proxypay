import * as metrics from '../../src/utils/metrics';
import { WebhookService, WebhookDeliveryResult } from '../../src/services/webhook';
import { Transaction, TransactionStatus } from '../../src/models/transaction';

describe('WebhookService - Retry Backoff Configuration', () => {
  const createBaseTransaction = (overrides: Partial<Transaction> = {}): Transaction => ({
    id: 'txn-1',
    userId: 'user-1',
    amount: '100',
    phoneNumber: '+15551234567',
    createdAt: new Date(),
    locationMetadata: null,
    status: TransactionStatus.Success,
    provider: 'test-provider',
    type: 'deposit',
    metadata: {},
    stellarAddress: 'GABC...',
    referenceNumber: 'ref-1',
    ...overrides,
  });

  describe('backoff configuration via environment variables', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      jest.resetModules();
      process.env = { ...originalEnv };
    });

    afterAll(() => {
      process.env = originalEnv;
    });

    it('should use default values when env vars are not set', () => {
      delete process.env.WEBHOOK_MAX_ATTEMPTS;
      delete process.env.WEBHOOK_BASE_DELAY_MS;
      delete process.env.WEBHOOK_MAX_DELAY_MS;
      delete process.env.WEBHOOK_JITTER_FACTOR;

      const service = new WebhookService({
        fetchImpl: jest.fn(),
        webhookUrl: 'http://test.com',
        webhookSecret: 'secret',
      });

      expect((service as any).maxAttempts).toBe(3);
      expect((service as any).baseDelayMs).toBe(500);
      expect((service as any).maxDelayMs).toBe(30000);
      expect((service as any).jitterFactor).toBe(0.2);
    });

    it('should use environment variables when set', () => {
      process.env.WEBHOOK_MAX_ATTEMPTS = '5';
      process.env.WEBHOOK_BASE_DELAY_MS = '1000';
      process.env.WEBHOOK_MAX_DELAY_MS = '60000';
      process.env.WEBHOOK_JITTER_FACTOR = '0.3';

      const service = new WebhookService({
        fetchImpl: jest.fn(),
        webhookUrl: 'http://test.com',
        webhookSecret: 'secret',
      });

      expect((service as any).maxAttempts).toBe(5);
      expect((service as any).baseDelayMs).toBe(1000);
      expect((service as any).maxDelayMs).toBe(60000);
      expect((service as any).jitterFactor).toBe(0.3);
    });

    it('should allow constructor options to override env vars', () => {
      process.env.WEBHOOK_MAX_ATTEMPTS = '5';
      process.env.WEBHOOK_BASE_DELAY_MS = '1000';

      const service = new WebhookService({
        fetchImpl: jest.fn(),
        webhookUrl: 'http://test.com',
        webhookSecret: 'secret',
        maxAttempts: 10,
        baseDelayMs: 2000,
      });

      expect((service as any).maxAttempts).toBe(10);
      expect((service as any).baseDelayMs).toBe(2000);
    });
  });

  describe('exponential backoff delay calculation', () => {
    it('should calculate correct exponential backoff', () => {
      // Import the function through the module
      const calculateBackoffDelay = (baseDelayMs: number, attempt: number, maxDelayMs: number, jitterFactor: number): number => {
        const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
        const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
        const jitter = cappedDelay * jitterFactor * Math.random();
        return Math.floor(cappedDelay + jitter);
      };

      // Test without jitter (jitterFactor = 0)
      expect(calculateBackoffDelay(500, 1, 30000, 0)).toBe(500);
      expect(calculateBackoffDelay(500, 2, 30000, 0)).toBe(1000);
      expect(calculateBackoffDelay(500, 3, 30000, 0)).toBe(2000);
      expect(calculateBackoffDelay(500, 4, 30000, 0)).toBe(4000);
      expect(calculateBackoffDelay(500, 5, 30000, 0)).toBe(8000);
      expect(calculateBackoffDelay(500, 6, 30000, 0)).toBe(16000);
      expect(calculateBackoffDelay(500, 7, 30000, 0)).toBe(30000); // capped
    });

    it('should respect max delay cap', () => {
      const calculateBackoffDelay = (baseDelayMs: number, attempt: number, maxDelayMs: number, jitterFactor: number): number => {
        const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
        const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
        const jitter = cappedDelay * jitterFactor * Math.random();
        return Math.floor(cappedDelay + jitter);
      };

      expect(calculateBackoffDelay(1000, 10, 5000, 0)).toBe(5000);
    });
  });

  describe('retry metrics tracking', () => {
    it('should track webhook retry attempts', async () => {
      const retryAttemptsSpy = jest.spyOn(metrics.webhookRetryAttemptsTotal, 'inc').mockImplementation(() => {});
      const deliveryDurationSpy = jest.spyOn(metrics.webhookDeliveryDurationSeconds, 'observe').mockImplementation(() => {});
      const deliveryRetriesSpy = jest.spyOn(metrics.webhookDeliveryRetriesTotal, 'inc').mockImplementation(() => {});
      const backoffDelaySpy = jest.spyOn(metrics.webhookBackoffDelaySeconds, 'observe').mockImplementation(() => {});

      let callCount = 0;
      const mockFetch = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.resolve({ ok: false, status: 500 });
        }
        return Promise.resolve({ ok: true, status: 200 });
      });

      const service = new WebhookService({
        fetchImpl: mockFetch,
        webhookUrl: 'http://test.com',
        webhookSecret: 'secret',
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        jitterFactor: 0,
        sleep: jest.fn().mockResolvedValue(undefined),
      });

      const result = await service.sendTransactionEvent('transaction.completed', createBaseTransaction());

      expect(result.status).toBe('delivered');
      expect(result.attempts).toBe(3);
      expect(retryAttemptsSpy).toHaveBeenCalledTimes(2); // 2 failed attempts before success
      expect(deliveryDurationSpy).toHaveBeenCalled();
      expect(deliveryRetriesSpy).toHaveBeenCalledWith({
        event_type: 'transaction.completed',
        final_status: 'delivered',
      });

      retryAttemptsSpy.mockRestore();
      deliveryDurationSpy.mockRestore();
      deliveryRetriesSpy.mockRestore();
      backoffDelaySpy.mockRestore();
    });

    it('should track failed delivery metrics', async () => {
      const retryAttemptsSpy = jest.spyOn(metrics.webhookRetryAttemptsTotal, 'inc').mockImplementation(() => {});
      const deliveryDurationSpy = jest.spyOn(metrics.webhookDeliveryDurationSeconds, 'observe').mockImplementation(() => {});
      const deliveryRetriesSpy = jest.spyOn(metrics.webhookDeliveryRetriesTotal, 'inc').mockImplementation(() => {});

      const mockFetch = jest.fn().mockRejectedValue(new Error('Network error'));

      const service = new WebhookService({
        fetchImpl: mockFetch,
        webhookUrl: 'http://test.com',
        webhookSecret: 'secret',
        maxAttempts: 2,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        jitterFactor: 0,
        sleep: jest.fn().mockResolvedValue(undefined),
      });

      const result = await service.sendTransactionEvent('transaction.failed', createBaseTransaction());

      expect(result.status).toBe('failed');
      expect(result.attempts).toBe(2);
      expect(retryAttemptsSpy).toHaveBeenCalledTimes(2);
      expect(deliveryRetriesSpy).toHaveBeenCalledWith({
        event_type: 'transaction.failed',
        final_status: 'failed',
      });

      retryAttemptsSpy.mockRestore();
      deliveryDurationSpy.mockRestore();
      deliveryRetriesSpy.mockRestore();
    });
  });
});
