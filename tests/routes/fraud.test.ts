import request from 'supertest';
import express from 'express';
import { fraudRoutes } from '../../src/routes/fraud';

// Mock the FraudAlertModel
jest.mock('../../src/models/fraudAlert', () => {
  return {
    FraudAlertModel: jest.fn().mockImplementation(() => ({
      create: jest.fn().mockResolvedValue({
        id: 'alert-1',
        transactionId: 'txn-1',
        userId: 'user-1',
        score: 55,
        riskLevel: 'high',
        recommendedAction: 'review',
        reasons: ['test'],
        heuristicsTriggered: ['test'],
        heuristicDetails: {},
        userContext: {},
        status: 'flagged',
        isFalsePositive: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      findById: jest.fn().mockResolvedValue({
        id: 'alert-1',
        transactionId: 'txn-1',
        userId: 'user-1',
        score: 55,
        riskLevel: 'high',
        recommendedAction: 'review',
        reasons: ['test'],
        heuristicsTriggered: ['test'],
        heuristicDetails: {},
        userContext: {},
        status: 'flagged',
        isFalsePositive: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      findByTransactionId: jest.fn().mockResolvedValue([]),
      list: jest.fn().mockResolvedValue({
        alerts: [],
        total: 0,
        flaggedCount: 0,
      }),
      findByUserId: jest.fn().mockResolvedValue({
        alerts: [],
        total: 0,
        flaggedCount: 0,
      }),
      review: jest.fn().mockResolvedValue({
        id: 'alert-1',
        status: 'reviewed',
        reviewedBy: 'admin',
        reviewedAt: new Date().toISOString(),
      }),
      markFalsePositive: jest.fn().mockResolvedValue({
        id: 'alert-1',
        status: 'false_positive',
        isFalsePositive: true,
        falsePositiveReason: 'Test reason',
      }),
      getReviewHistory: jest.fn().mockResolvedValue([]),
      getStatistics: jest.fn().mockResolvedValue({
        totalAlerts: 10,
        flaggedAlerts: 3,
        falsePositives: 1,
        confirmedFraud: 2,
        averageScore: 45,
        riskLevelBreakdown: { low: 5, medium: 3, high: 1, critical: 1 },
      }),
    })),
  };
});

// Mock auth middleware
jest.mock('../../src/middleware/auth', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'admin-user' };
    next();
  },
}));

// Mock fraud service
jest.mock('../../src/services/fraud', () => ({
  fraudService: {
    getReviewQueue: jest.fn().mockReturnValue([]),
  },
}));

describe('Fraud Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/fraud', fraudRoutes);
  });

  describe('GET /api/fraud/history/:userId', () => {
    it('should return fraud history for a user', async () => {
      const response = await request(app)
        .get('/api/fraud/history/user-1')
        .expect(200);

      expect(response.body).toHaveProperty('alerts');
      expect(response.body).toHaveProperty('total');
      expect(response.body).toHaveProperty('flaggedCount');
    });
  });

  describe('GET /api/fraud/alerts', () => {
    it('should return list of fraud alerts', async () => {
      const response = await request(app)
        .get('/api/fraud/alerts')
        .expect(200);

      expect(response.body).toHaveProperty('alerts');
      expect(response.body).toHaveProperty('total');
      expect(response.body).toHaveProperty('flaggedCount');
    });
  });

  describe('GET /api/fraud/alerts/:alertId', () => {
    it('should return a specific fraud alert', async () => {
      const response = await request(app)
        .get('/api/fraud/alerts/alert-1')
        .expect(200);

      expect(response.body).toHaveProperty('id');
      expect(response.body.id).toBe('alert-1');
    });
  });

  describe('POST /api/fraud/alerts/:alertId/review', () => {
    it('should review a fraud alert', async () => {
      const response = await request(app)
        .post('/api/fraud/alerts/alert-1/review')
        .send({
          status: 'reviewed',
          reviewNotes: 'Reviewed and approved',
        })
        .expect(200);

      expect(response.body).toHaveProperty('status');
    });

    it('should return 400 if status is missing', async () => {
      await request(app)
        .post('/api/fraud/alerts/alert-1/review')
        .send({ reviewNotes: 'No status' })
        .expect(400);
    });
  });

  describe('POST /api/fraud/alerts/:alertId/false-positive', () => {
    it('should mark alert as false positive', async () => {
      const response = await request(app)
        .post('/api/fraud/alerts/alert-1/false-positive')
        .send({ reason: 'Legitimate transaction' })
        .expect(200);

      expect(response.body).toHaveProperty('status');
      expect(response.body.status).toBe('false_positive');
    });

    it('should return 400 if reason is missing', async () => {
      await request(app)
        .post('/api/fraud/alerts/alert-1/false-positive')
        .send({})
        .expect(400);
    });
  });

  describe('GET /api/fraud/alerts/:alertId/history', () => {
    it('should return review history for an alert', async () => {
      const response = await request(app)
        .get('/api/fraud/alerts/alert-1/history')
        .expect(200);

      expect(response.body).toHaveProperty('history');
    });
  });

  describe('GET /api/fraud/statistics', () => {
    it('should return fraud statistics', async () => {
      const response = await request(app)
        .get('/api/fraud/statistics')
        .expect(200);

      expect(response.body).toHaveProperty('totalAlerts');
      expect(response.body).toHaveProperty('flaggedAlerts');
      expect(response.body).toHaveProperty('falsePositives');
      expect(response.body).toHaveProperty('averageScore');
      expect(response.body).toHaveProperty('riskLevelBreakdown');
    });
  });

  describe('GET /api/fraud/review-queue', () => {
    it('should return the review queue', async () => {
      const response = await request(app)
        .get('/api/fraud/review-queue')
        .expect(200);

      expect(response.body).toHaveProperty('queue');
      expect(response.body).toHaveProperty('count');
    });
  });

  describe('GET /api/fraud/transactions/:transactionId', () => {
    it('should return fraud alerts for a transaction', async () => {
      const response = await request(app)
        .get('/api/fraud/transactions/txn-1')
        .expect(200);

      expect(response.body).toHaveProperty('alerts');
    });
  });
});
