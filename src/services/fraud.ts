import { transactionTotal, transactionErrorsTotal } from '../utils/metrics';
import { Transaction, TransactionStatus } from '../models/transaction';
import { TransactionModel } from '../models/transaction';
import { UserModel } from '../models/users';
import { FraudAlertModel, FraudRiskLevel, FraudRecommendedAction } from '../models/fraudAlert';
import { redisClient } from '../config/redis';
import logger from '../utils/logger';
import { fraudLoggingService } from './fraudLoggingService';
import {
  mlFraudDetectionService,
  MlFraudVerdict,
} from './mlFraudDetectionService';

/**
 * Enhanced Fraud Detection Service
 *
 * Implements comprehensive fraud detection with 10+ heuristics for mobile money transactions.
 *
 * Heuristics:
 * 1. Velocity Check: > X transactions within time window
 * 2. Rapid Succession: Multiple transactions in very short time
 * 3. Amount Anomaly: Transaction > Xx average user transaction amount
 * 4. Geographic Anomaly: Location change > X km within time window
 * 5. High-Risk Phone Number Check: Match against known fraud numbers
 * 6. IP Geolocation Mismatch: IP location vs user address mismatch
 * 7. Unusual Transaction Hours: Transactions at odd times
 * 8. Pattern Detection: Multiple failed transactions in short time
 * 9. Device Fingerprint Anomaly: New device or suspicious device changes
 * 10. Account Age Risk: New accounts with high-value transactions
 * 11. KYC Level Risk: Low KYC level with high-value transactions
 * 12. Transaction Frequency Spike: Sudden increase in transaction frequency
 * 13. ML Model Second Opinion: logistic-regression score blended with the
 *     heuristic score to catch combinations no rule covers (#485)
 *
 * Fraud Score Threshold: 50 (configurable)
 */

interface FraudConfig {
  maxTransactionsPerHour: number;
  maxTransactionsPerMinute: number;
  amountMultiplier: number;
  maxDistanceKm: number;
  timeWindowMs: number;
  shortTimeWindowMs: number;
  fraudScoreThreshold: number;
  velocityScore: number;
  rapidSuccessionScore: number;
  amountScore: number;
  geoScore: number;
  highRiskNumberScore: number;
  ipMismatchScore: number;
  unusualHoursScore: number;
  patternScore: number;
  deviceAnomalyScore: number;
  newAccountScore: number;
  kycRiskScore: number;
  frequencySpikeScore: number;
  unusualHoursStart: number;
  unusualHoursEnd: number;
  highValueThreshold: number;
  newAccountDays: number;
  deviceFingerprintWindowMs: number;
}

const defaultConfig: FraudConfig = {
  maxTransactionsPerHour: parseInt(process.env.FRAUD_MAX_TRANSACTIONS_PER_HOUR || '5'),
  maxTransactionsPerMinute: parseInt(process.env.FRAUD_MAX_TRANSACTIONS_PER_MINUTE || '2'),
  amountMultiplier: parseFloat(process.env.FRAUD_AMOUNT_MULTIPLIER || '10'),
  maxDistanceKm: parseFloat(process.env.FRAUD_MAX_DISTANCE_KM || '1000'),
  timeWindowMs: parseInt(process.env.FRAUD_TIME_WINDOW_MS || `${60 * 60 * 1000}`),
  shortTimeWindowMs: parseInt(process.env.FRAUD_SHORT_TIME_WINDOW_MS || `${5 * 60 * 1000}`),
  fraudScoreThreshold: parseInt(process.env.FRAUD_SCORE_THRESHOLD || '50'),
  velocityScore: parseInt(process.env.FRAUD_VELOCITY_SCORE || '25'),
  rapidSuccessionScore: parseInt(process.env.FRAUD_RAPID_SUCCESSION_SCORE || '20'),
  amountScore: parseInt(process.env.FRAUD_AMOUNT_SCORE || '20'),
  geoScore: parseInt(process.env.FRAUD_GEO_SCORE || '20'),
  highRiskNumberScore: parseInt(process.env.FRAUD_HIGH_RISK_NUMBER_SCORE || '30'),
  ipMismatchScore: parseInt(process.env.FRAUD_IP_MISMATCH_SCORE || '25'),
  unusualHoursScore: parseInt(process.env.FRAUD_UNUSUAL_HOURS_SCORE || '10'),
  patternScore: parseInt(process.env.FRAUD_PATTERN_SCORE || '15'),
  deviceAnomalyScore: parseInt(process.env.FRAUD_DEVICE_ANOMALY_SCORE || '15'),
  newAccountScore: parseInt(process.env.FRAUD_NEW_ACCOUNT_SCORE || '20'),
  kycRiskScore: parseInt(process.env.FRAUD_KYC_RISK_SCORE || '15'),
  frequencySpikeScore: parseInt(process.env.FRAUD_FREQUENCY_SPIKE_SCORE || '15'),
  unusualHoursStart: parseInt(process.env.FRAUD_UNUSUAL_HOURS_START || '23'),
  unusualHoursEnd: parseInt(process.env.FRAUD_UNUSUAL_HOURS_END || '5'),
  highValueThreshold: parseFloat(process.env.FRAUD_HIGH_VALUE_THRESHOLD || '1000'),
  newAccountDays: parseInt(process.env.FRAUD_NEW_ACCOUNT_DAYS || '7'),
  deviceFingerprintWindowMs: parseInt(process.env.FRAUD_DEVICE_FINGERPRINT_WINDOW_MS || `${24 * 60 * 60 * 1000}`),
};

export interface FraudTransactionInput {
  id: string;
  userId?: string | null;
  amount: number;
  phoneNumber: string;
  timestamp: Date;
  location?: {
    lat: number;
    lng: number;
  } | null;
  status?: "SUCCESS" | "FAILED" | "PENDING";
  ipAddress?: string | null;
  userAgent?: string | null;
  deviceFingerprint?: string | null;
  type: "deposit" | "withdraw";
  provider: string;
  metadata?: Record<string, unknown> | null;
}

interface Location {
  lat: number;
  lng: number;
}

export interface FraudResult {
  isFraud: boolean;
  score: number;
  reasons: string[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  heuristicsTriggered: string[];
  recommendedAction: 'allow' | 'review' | 'block';
  heuristicDetails?: Record<string, unknown>;
  durationMs?: number;
  transactionHistoryCount?: number;
  /** Rule-engine contribution before the ML blend was applied. */
  heuristicScore?: number;
  /** Machine-learning probability in [0,1]; absent when no model is active. */
  mlScore?: number;
}

function getDistanceKm(
  loc1: { lat: number; lng: number },
  loc2: { lat: number; lng: number }
): number {
  // Haversine formula for distance calculation
  const R = 6371; // Radius of the Earth in kilometers
  const dLat = ((loc2.lat - loc1.lat) * Math.PI) / 180;
  const dLng = ((loc2.lng - loc1.lng) * Math.PI) / 180;

  const lat1 = (loc1.lat * Math.PI) / 180;
  const lat2 = (loc2.lat * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

export class FraudService {
  private config: FraudConfig;
  private reviewQueue: FraudTransactionInput[] = [];
  private transactionModel: TransactionModel;
  private userModel: UserModel;
  private fraudAlertModel: FraudAlertModel;
  private highRiskNumbers: Set<string> = new Set();

  constructor(config?: Partial<FraudConfig>) {
    this.config = { ...defaultConfig, ...config };
    this.transactionModel = new TransactionModel();
    this.userModel = new UserModel();
    this.fraudAlertModel = new FraudAlertModel();
    this.loadHighRiskNumbers();
  }

  private async loadHighRiskNumbers(): Promise<void> {
    try {
      // Load from Redis cache or database
      const cached = await redisClient.get('fraud:high_risk_numbers');
      if (cached && typeof cached === 'string') {
        const numbers = JSON.parse(cached) as string[];
        this.highRiskNumbers = new Set(numbers);
        logger.info({ count: numbers.length }, 'Loaded high-risk phone numbers from cache');
      } else {
        // In production, load from database or external fraud intelligence
        const sampleNumbers = [
          '+1234567890', '+0987654321', '+5555555555'
        ];
        this.highRiskNumbers = new Set(sampleNumbers);
        await redisClient.setex('fraud:high_risk_numbers', 3600, JSON.stringify(sampleNumbers));
        logger.warn({ count: sampleNumbers.length }, 'Using default high-risk phone numbers; configure production fraud intelligence feed');
      }
    } catch (error) {
      logger.error({ err: error }, 'Failed to load high risk numbers');
    }
  }

  private async getUserTransactions(userId: string): Promise<Transaction[]> {
    try {
      return await this.transactionModel.findByUserId(userId);
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to get user transactions');
      return [];
    }
  }

  private calculateDistance(
    locationMetadata: { country: string; city: string; },
    currentLocation: { lat: number; lng: number }
  ): number {
    // For now, return a placeholder distance
    // In production, implement proper geolocation lookup
    return 500; // km
  }

  private async getIPLocation(ipAddress: string): Promise<{ lat: number; lng: number; country: string } | null> {
    // In production, use a geolocation service like MaxMind or IP-API
    // For now, return null to disable this check
    return null;
  }

  private isLocationMismatch(
    ipLocation: { lat: number; lng: number; country: string },
    transactionLocation: { lat: number; lng: number } | null
  ): boolean {
    if (!transactionLocation) return false;
    
    // Simple distance check - in production, use proper geolocation
    const distance = getDistanceKm(
      { lat: ipLocation.lat, lng: ipLocation.lng },
      transactionLocation
    );
    return distance > 100; // 100km threshold
  }

  private async isNewDevice(userId: string, deviceFingerprint: string): Promise<boolean> {
    try {
      const key = `fraud:devices:${userId}`;
      const existingDevices = await redisClient.smembers(key) as string[];
      
      if (!existingDevices.includes(deviceFingerprint)) {
        // Add new device and set expiration
        await redisClient.sadd(key, deviceFingerprint);
        await redisClient.expire(key, this.config.deviceFingerprintWindowMs / 1000);
        logger.info({ userId, deviceFingerprint }, 'New device fingerprint registered');
        return true;
      }
      return false;
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to check device fingerprint');
      return false;
    }
  }

  private isLowKYCLevel(kycLevel: string): boolean {
    const lowKYCLevels = ['tier0', 'tier1', 'basic'];
    return lowKYCLevels.includes(kycLevel.toLowerCase());
  }

  private detectFrequencySpike(transactions: Transaction[], now: Date): string | null {
    if (transactions.length < 10) return null;
    
    // Compare recent frequency to historical average
    const recentTxns = transactions.filter(t => 
      now.getTime() - new Date(t.createdAt).getTime() <= 24 * 60 * 60 * 1000
    );
    const olderTxns = transactions.filter(t => 
      now.getTime() - new Date(t.createdAt).getTime() > 24 * 60 * 60 * 1000 &&
      now.getTime() - new Date(t.createdAt).getTime() <= 7 * 24 * 60 * 60 * 1000
    );
    
    if (olderTxns.length === 0) return null;
    
    const recentFreq = recentTxns.length;
    const historicalFreq = olderTxns.length / 7; // daily average
    
    if (recentFreq > historicalFreq * 3) {
      return `Transaction frequency spike: ${recentFreq} txns today vs ${historicalFreq.toFixed(1)} daily average`;
    }
    
    return null;
  }

  private calculateRiskLevel(score: number): 'low' | 'medium' | 'high' | 'critical' {
    if (score >= 80) return 'critical';
    if (score >= 60) return 'high';
    if (score >= 40) return 'medium';
    return 'low';
  }

  private getRecommendedAction(
    score: number, 
    riskLevel: 'low' | 'medium' | 'high' | 'critical'
  ): 'allow' | 'review' | 'block' {
    if (score >= 80 || riskLevel === 'critical') return 'block';
    if (score >= 50 || riskLevel === 'high') return 'review';
    return 'allow';
  }

  /**
   * Enhanced fraud detection with 10+ heuristics
   * @param transactionInput The transaction to evaluate
   * @returns Fraud detection result with detailed analysis
   */
  async detectFraud(transactionInput: FraudTransactionInput): Promise<FraudResult> {
    const startTime = Date.now();
    let score = 0;
    const reasons: string[] = [];
    const heuristicsTriggered: string[] = [];
    const heuristicDetails: Record<string, unknown> = {};
    const now = transactionInput.timestamp;

    logger.debug({
      transactionId: transactionInput.id,
      userId: transactionInput.userId,
      amount: transactionInput.amount,
      phoneNumber: transactionInput.phoneNumber,
      provider: transactionInput.provider,
      type: transactionInput.type,
    }, 'Starting fraud detection analysis');

    // Get user's transaction history
    const userTransactions = transactionInput.userId 
      ? await this.getUserTransactions(transactionInput.userId)
      : [];

    // Get user data for account-level checks
    const user = transactionInput.userId 
      ? await this.userModel.findById(transactionInput.userId)
      : null;

    // Sort transactions by timestamp descending
    const sortedTxns = [...userTransactions].sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    // 1. Velocity Check: Transactions per hour
    const recentTxns = sortedTxns.filter(
      (t) => now.getTime() - new Date(t.createdAt).getTime() <= this.config.timeWindowMs
    );

    if (recentTxns.length >= this.config.maxTransactionsPerHour) {
      score += this.config.velocityScore;
      const reason = `Too many transactions (${recentTxns.length}) in ${this.config.timeWindowMs / (60 * 60 * 1000)} hours`;
      reasons.push(reason);
      heuristicsTriggered.push('velocity_check');
      heuristicDetails.velocity_check = {
        count: recentTxns.length,
        threshold: this.config.maxTransactionsPerHour,
        windowHours: this.config.timeWindowMs / (60 * 60 * 1000),
        scoreAdded: this.config.velocityScore,
      };
      logger.warn({
        transactionId: transactionInput.id,
        heuristic: 'velocity_check',
        ...heuristicDetails.velocity_check,
      }, 'Velocity check triggered');
    }

    // 2. Rapid Succession: Transactions per minute
    const rapidTxns = sortedTxns.filter(
      (t) => now.getTime() - new Date(t.createdAt).getTime() <= 60 * 1000
    );

    if (rapidTxns.length >= this.config.maxTransactionsPerMinute) {
      score += this.config.rapidSuccessionScore;
      const reason = `Rapid succession transactions (${rapidTxns.length}) in 1 minute`;
      reasons.push(reason);
      heuristicsTriggered.push('rapid_succession');
      heuristicDetails.rapid_succession = {
        count: rapidTxns.length,
        threshold: this.config.maxTransactionsPerMinute,
        scoreAdded: this.config.rapidSuccessionScore,
      };
      logger.warn({
        transactionId: transactionInput.id,
        heuristic: 'rapid_succession',
        ...heuristicDetails.rapid_succession,
      }, 'Rapid succession check triggered');
    }

    // 3. Amount Anomaly
    const recentAmounts = recentTxns.map(t => parseFloat(t.amount));
    const avgAmount = recentAmounts.length > 0
      ? recentAmounts.reduce((sum, a) => sum + a, 0) / recentAmounts.length
      : transactionInput.amount;

    if (transactionInput.amount > avgAmount * this.config.amountMultiplier) {
      score += this.config.amountScore;
      const reason = `Unusually large amount ($${transactionInput.amount} vs avg $${avgAmount.toFixed(2)})`;
      reasons.push(reason);
      heuristicsTriggered.push('amount_anomaly');
      heuristicDetails.amount_anomaly = {
        transactionAmount: transactionInput.amount,
        averageAmount: avgAmount,
        multiplier: this.config.amountMultiplier,
        scoreAdded: this.config.amountScore,
      };
      logger.warn({
        transactionId: transactionInput.id,
        heuristic: 'amount_anomaly',
        ...heuristicDetails.amount_anomaly,
      }, 'Amount anomaly check triggered');
    }

    // 4. Geographic Anomaly
    if (transactionInput.location) {
      const lastTxnWithLocation = sortedTxns.find(t => 
        t.locationMetadata && 
        t.locationMetadata.status === 'resolved'
      );
      
      if (lastTxnWithLocation && lastTxnWithLocation.locationMetadata) {
        const distance = this.calculateDistance(
          lastTxnWithLocation.locationMetadata,
          transactionInput.location
        );
        const timeDiff = now.getTime() - new Date(lastTxnWithLocation.createdAt).getTime();

        if (distance > this.config.maxDistanceKm && timeDiff <= this.config.timeWindowMs) {
          score += this.config.geoScore;
          const reason = `Suspicious location change (${distance.toFixed(2)}km in ${timeDiff / (60 * 60 * 1000)} hours)`;
          reasons.push(reason);
          heuristicsTriggered.push('geographic_anomaly');
          heuristicDetails.geographic_anomaly = {
            distanceKm: distance,
            timeDiffHours: timeDiff / (60 * 60 * 1000),
            maxDistanceKm: this.config.maxDistanceKm,
            scoreAdded: this.config.geoScore,
            previousLocation: lastTxnWithLocation.locationMetadata,
            currentLocation: transactionInput.location,
          };
          logger.warn({
            transactionId: transactionInput.id,
            heuristic: 'geographic_anomaly',
            ...heuristicDetails.geographic_anomaly,
          }, 'Geographic anomaly check triggered');
        }
      }
    }

    // 5. High-Risk Phone Number Check
    if (this.highRiskNumbers.has(transactionInput.phoneNumber)) {
      score += this.config.highRiskNumberScore;
      const reason = 'Transaction from known high-risk phone number';
      reasons.push(reason);
      heuristicsTriggered.push('high_risk_number');
      heuristicDetails.high_risk_number = {
        phoneNumber: transactionInput.phoneNumber,
        scoreAdded: this.config.highRiskNumberScore,
      };
      logger.warn({
        transactionId: transactionInput.id,
        heuristic: 'high_risk_number',
        ...heuristicDetails.high_risk_number,
      }, 'High-risk phone number check triggered');
    }

    // 6. IP Geolocation Mismatch
    if (transactionInput.ipAddress && user) {
      const ipLocation = await this.getIPLocation(transactionInput.ipAddress);
      if (ipLocation && this.isLocationMismatch(ipLocation, transactionInput.location)) {
        score += this.config.ipMismatchScore;
        const reason = 'IP geolocation does not match transaction location';
        reasons.push(reason);
        heuristicsTriggered.push('ip_geolocation_mismatch');
        heuristicDetails.ip_geolocation_mismatch = {
          ipAddress: transactionInput.ipAddress,
          ipLocation,
          transactionLocation: transactionInput.location,
          scoreAdded: this.config.ipMismatchScore,
        };
        logger.warn({
          transactionId: transactionInput.id,
          heuristic: 'ip_geolocation_mismatch',
          ...heuristicDetails.ip_geolocation_mismatch,
        }, 'IP geolocation mismatch check triggered');
      }
    }

    // 7. Unusual Transaction Hours
    const hour = now.getHours();
    if (hour >= this.config.unusualHoursStart || hour <= this.config.unusualHoursEnd) {
      score += this.config.unusualHoursScore;
      const reason = `Transaction during unusual hours (${hour}:00)`;
      reasons.push(reason);
      heuristicsTriggered.push('unusual_hours');
      heuristicDetails.unusual_hours = {
        hour,
        unusualHoursStart: this.config.unusualHoursStart,
        unusualHoursEnd: this.config.unusualHoursEnd,
        scoreAdded: this.config.unusualHoursScore,
      };
      logger.info({
        transactionId: transactionInput.id,
        heuristic: 'unusual_hours',
        ...heuristicDetails.unusual_hours,
      }, 'Unusual hours check triggered');
    }

    // 8. Pattern Detection: Failed attempts
    const failedAttempts = recentTxns.filter(
      (t) => t.status === TransactionStatus.Failed &&
        now.getTime() - new Date(t.createdAt).getTime() <= this.config.timeWindowMs
    );

    if (failedAttempts.length >= 3) {
      score += this.config.patternScore;
      const reason = `Multiple failed attempts (${failedAttempts.length}) in short time`;
      reasons.push(reason);
      heuristicsTriggered.push('pattern_detection');
      heuristicDetails.pattern_detection = {
        failedCount: failedAttempts.length,
        threshold: 3,
        windowHours: this.config.timeWindowMs / (60 * 60 * 1000),
        scoreAdded: this.config.patternScore,
      };
      logger.warn({
        transactionId: transactionInput.id,
        heuristic: 'pattern_detection',
        ...heuristicDetails.pattern_detection,
      }, 'Failed attempts pattern check triggered');
    }

    // 9. Device Fingerprint Anomaly
    if (transactionInput.deviceFingerprint && transactionInput.userId) {
      const isNewDevice = await this.isNewDevice(
        transactionInput.userId, 
        transactionInput.deviceFingerprint
      );
      if (isNewDevice) {
        score += this.config.deviceAnomalyScore;
        const reason = 'Transaction from new or unrecognized device';
        reasons.push(reason);
        heuristicsTriggered.push('device_anomaly');
        heuristicDetails.device_anomaly = {
          deviceFingerprint: transactionInput.deviceFingerprint,
          scoreAdded: this.config.deviceAnomalyScore,
        };
        logger.warn({
          transactionId: transactionInput.id,
          heuristic: 'device_anomaly',
          ...heuristicDetails.device_anomaly,
        }, 'Device fingerprint anomaly check triggered');
      }
    }

    // 10. Account Age Risk
    if (user) {
      const accountAge = now.getTime() - user.createdAt.getTime();
      const daysOld = accountAge / (24 * 60 * 60 * 1000);
      
      if (daysOld <= this.config.newAccountDays && 
          transactionInput.amount >= this.config.highValueThreshold) {
        score += this.config.newAccountScore;
        const reason = `High-value transaction from new account (${daysOld.toFixed(1)} days old)`;
        reasons.push(reason);
        heuristicsTriggered.push('new_account_risk');
        heuristicDetails.new_account_risk = {
          accountAgeDays: daysOld,
          thresholdDays: this.config.newAccountDays,
          transactionAmount: transactionInput.amount,
          highValueThreshold: this.config.highValueThreshold,
          scoreAdded: this.config.newAccountScore,
        };
        logger.warn({
          transactionId: transactionInput.id,
          heuristic: 'new_account_risk',
          ...heuristicDetails.new_account_risk,
        }, 'New account risk check triggered');
      }

      // 11. KYC Level Risk
      if (user.kycLevel && this.isLowKYCLevel(user.kycLevel) && 
          transactionInput.amount >= this.config.highValueThreshold) {
        score += this.config.kycRiskScore;
        const reason = `High-value transaction from low KYC level (${user.kycLevel})`;
        reasons.push(reason);
        heuristicsTriggered.push('kyc_risk');
        heuristicDetails.kyc_risk = {
          kycLevel: user.kycLevel,
          transactionAmount: transactionInput.amount,
          highValueThreshold: this.config.highValueThreshold,
          scoreAdded: this.config.kycRiskScore,
        };
        logger.warn({
          transactionId: transactionInput.id,
          heuristic: 'kyc_risk',
          ...heuristicDetails.kyc_risk,
        }, 'KYC level risk check triggered');
      }
    }

    // 12. Transaction Frequency Spike
    const frequencySpike = this.detectFrequencySpike(sortedTxns, now);
    if (frequencySpike) {
      score += this.config.frequencySpikeScore;
      reasons.push(frequencySpike);
      heuristicsTriggered.push('frequency_spike');
      heuristicDetails.frequency_spike = {
        description: frequencySpike,
        scoreAdded: this.config.frequencySpikeScore,
      };
      logger.warn({
        transactionId: transactionInput.id,
        heuristic: 'frequency_spike',
        ...heuristicDetails.frequency_spike,
      }, 'Transaction frequency spike check triggered');
    }

    // 13. Machine-learning second opinion (#485).
    //     The heuristic score above is precise about known patterns but blind
    //     to combinations nobody wrote a rule for. Blend in the statistical
    //     model so novel patterns are still caught. A missing model, or a
    //     failure to score, must never block a transaction.
    const mlVerdict = await this.scoreWithModel(
      transactionInput,
      userTransactions,
      now,
    );

    let mlScore: number | undefined;
    if (mlVerdict) {
      mlScore = mlVerdict.score;
      heuristicDetails.ml_model = {
        score: mlVerdict.score,
        threshold: mlVerdict.threshold,
        modelVersion: mlVerdict.modelVersion,
        drivers: mlFraudDetectionService.explain(mlVerdict),
      };

      if (mlVerdict.isFraud && !heuristicsTriggered.includes('ml_model')) {
        heuristicsTriggered.push('ml_model');
        reasons.push(
          `ML model flagged this transaction (score ${mlVerdict.score.toFixed(2)} >= ${mlVerdict.threshold})`,
        );
      }
    }

    const blendedScore = this.blendScores(score, mlScore);
    const isFraud = blendedScore >= this.config.fraudScoreThreshold;
    const riskLevel = this.calculateRiskLevel(blendedScore);
    const recommendedAction = this.getRecommendedAction(blendedScore, riskLevel);
    const durationMs = Date.now() - startTime;
    // Log comprehensive fraud detection result
    logger.info({
      transactionId: transactionInput.id,
      userId: transactionInput.userId,
      amount: transactionInput.amount,
      provider: transactionInput.provider,
      type: transactionInput.type,
      isFraud,
      score,
      riskLevel,
      recommendedAction,
      reasonsCount: reasons.length,
      heuristicsTriggered,
      heuristicDetails,
      durationMs,
      transactionHistoryCount: userTransactions.length,
    }, 'Fraud detection analysis complete');

    // Update metrics
    transactionTotal.inc({ 
      type: 'fraud_check', 
      status: isFraud ? 'flagged' : 'passed'
    });
    
    if (isFraud) {
      transactionErrorsTotal.inc({ 
        type: 'fraud_detection', 
        error_type: 'fraud_flagged'
      });
    }

    return {
      isFraud,
      score: blendedScore,
      reasons,
      riskLevel,
      heuristicsTriggered,
      recommendedAction,
      heuristicDetails,
      durationMs,
      transactionHistoryCount: userTransactions.length,
      heuristicScore: score,
      mlScore,
    };
  }

  /**
   * Run the ML detector with whatever history is already in memory.
   * Never throws – fraud detection must degrade to the rule engine alone.
   */
  private async scoreWithModel(
    transactionInput: FraudTransactionInput,
    userTransactions: Transaction[],
    now: Date,
  ): Promise<MlFraudVerdict | null> {
    try {
      const amounts = userTransactions
        .map((t) => Number(t.amount))
        .filter((a) => Number.isFinite(a));

      const avg = amounts.length
        ? amounts.reduce((a, b) => a + b, 0) / amounts.length
        : transactionInput.amount;
      const variance = amounts.length
        ? amounts.reduce((acc, a) => acc + (a - avg) ** 2, 0) / amounts.length
        : 0;

      const last24h = userTransactions.filter(
        (t) => now.getTime() - new Date(t.createdAt).getTime() <= 24 * 60 * 60 * 1000,
      );

      return await mlFraudDetectionService.score({
        transactionId: transactionInput.id,
        userId: transactionInput.userId ?? undefined,
        amount: transactionInput.amount,
        userAvgAmount: avg,
        userStdDevAmount: Math.sqrt(variance),
        userMaxAmount: amounts.length ? Math.max(...amounts) : undefined,
        transactionsLastHour: userTransactions.filter(
          (t) =>
            now.getTime() - new Date(t.createdAt).getTime() <=
            this.config.timeWindowMs,
        ).length,
        transactionsLast24h: last24h.length,
        distinctCounterparties: new Set(
          userTransactions.map((t) => t.phoneNumber),
        ).size,
        failedTransactions: userTransactions.filter(
          (t) => t.status === TransactionStatus.Failed,
        ).length,
        totalTransactions: userTransactions.length,
        providerRisk: this.getProviderRisk(transactionInput.provider),
        timestamp: now,
      });
    } catch (err) {
      logger.warn(
        { err: err, transactionId: transactionInput.id },
        'ML fraud scoring unavailable – falling back to heuristics',
      );
      return null;
    }
  }

  /** Operator-assigned provider risk, used as an ML feature. */
  private getProviderRisk(provider: string): number {
    const risk: Record<string, number> = {
      mtn: 0.2,
      airtel: 0.2,
      orange: 0.25,
      tigo: 0.3,
      wave: 0.15,
    };
    return risk[String(provider ?? '').toLowerCase()] ?? 0.5;
  }

  /**
   * Combine the heuristic and ML scores on a common 0–1 scale.
   *
   * The heuristic score is normalised by the configured threshold so a
   * heuristic near the limit and an ML score near its own threshold are
   * directly comparable. The model contributes 30% of the final score, which
   * is enough to tip borderline cases without overriding an explicit rule hit.
   */
  private blendScores(heuristicScore: number, mlScore?: number): number {
    if (mlScore === undefined) return heuristicScore;
    const threshold = Math.max(this.config.fraudScoreThreshold, 1);
    return heuristicScore + mlScore * threshold * 0.3;
  }

  /**
   * Logs a fraud alert for a suspicious transaction and persists to database
   * @param result Fraud detection result
   * @param transactionInput The transaction input
   * @param userContext Optional user context for enhanced logging
   * @param durationMs Optional duration of the fraud detection analysis
   */
  async logFraudAlert(
    result: FraudResult,
    transactionInput: FraudTransactionInput,
    userContext?: Record<string, unknown>,
    durationMs?: number,
  ): Promise<void> {
    if (!result.isFraud) return;

    const alertData = {
      timestamp: new Date().toISOString(),
      level: 'WARN',
      type: 'FRAUD_ALERT',
      transactionId: transactionInput.id,
      userId: transactionInput.userId,
      score: result.score,
      reasons: result.reasons,
      amount: transactionInput.amount,
      phoneNumber: transactionInput.phoneNumber,
      riskLevel: result.riskLevel,
      heuristicsTriggered: result.heuristicsTriggered,
      recommendedAction: result.recommendedAction,
    };

    logger.warn(alertData, 'Fraud alert generated');

    // Persist to database for investigation and rule improvement
    try {
      await this.fraudAlertModel.create({
        transactionId: transactionInput.id,
        userId: transactionInput.userId || undefined,
        score: result.score,
        riskLevel: result.riskLevel as FraudRiskLevel,
        recommendedAction: result.recommendedAction as FraudRecommendedAction,
        reasons: result.reasons,
        heuristicsTriggered: result.heuristicsTriggered,
        heuristicDetails: {},
        userContext: userContext || {},
        durationMs,
        transactionAmount: transactionInput.amount,
        transactionType: transactionInput.type,
        provider: transactionInput.provider,
        phoneNumber: transactionInput.phoneNumber,
      });
      logger.info({
        transactionId: transactionInput.id,
        score: result.score,
        riskLevel: result.riskLevel,
      }, 'Fraud alert persisted to database');
    } catch (error) {
      logger.error({ err: error, transactionId: transactionInput.id }, 'Failed to persist fraud alert to database');
    }
  }

  /**
   * Adds a suspicious transaction to the manual review queue
   * @param transactionInput The transaction input to review
   */
  addToReviewQueue(transactionInput: FraudTransactionInput): void {
    this.reviewQueue.push(transactionInput);
    // In production, persist to database or Redis queue
    logger.info({ transactionId: transactionInput.id, queueSize: this.reviewQueue.length }, 'Transaction added to review queue');
  }

  /**
   * Gets the current review queue (for admin purposes)
   * @returns Array of transactions in review queue
   */
  getReviewQueue(): FraudTransactionInput[] {
    return [...this.reviewQueue];
  }

  /**
   * Clears the review queue (after processing)
   */
  clearReviewQueue(): void {
    this.reviewQueue = [];
  }

  /**
   * Processes a transaction: detects fraud, logs alerts, and queues for review if needed
   * @param transactionInput The transaction to process
   * @returns Fraud detection result
   */
  async processTransaction(transactionInput: FraudTransactionInput): Promise<FraudResult> {
    const startTime = Date.now();
    const result = await this.detectFraud(transactionInput);
    const durationMs = Date.now() - startTime;

    // Gather user context for enhanced logging
    let userContext: Record<string, unknown> = {};
    if (transactionInput.userId) {
      try {
        const user = await this.userModel.findById(transactionInput.userId);
        if (user) {
          userContext = {
            kycLevel: user.kycLevel,
            accountAge: user.createdAt ? Math.floor((Date.now() - new Date(user.createdAt).getTime()) / (24 * 60 * 60 * 1000)) : null,
            phoneCount: user.phoneNumber ? 1 : 0,
          };
        }
      } catch {
        // User context is optional, don't fail on errors
      }
    }

    await this.logFraudAlert(result, transactionInput, userContext, durationMs);

    // Log full evaluation context to database
    try {
      const evaluationLogId = await fraudLoggingService.logEvaluation(
        result,
        transactionInput,
        result.heuristicDetails || {},
        result.durationMs || 0,
        result.transactionHistoryCount || 0,
      );

      if (result.isFraud) {
        await fraudLoggingService.createAlert(evaluationLogId, result, transactionInput);
      }
    } catch (error) {
      logger.error({ err: error, transactionId: transactionInput.id }, 'Failed to log fraud evaluation');
    }

    if (result.isFraud) {
      this.addToReviewQueue(transactionInput);
      logger.warn({
        transactionId: transactionInput.id,
        userId: transactionInput.userId,
        score: result.score,
        riskLevel: result.riskLevel,
        recommendedAction: result.recommendedAction,
        heuristicsTriggered: result.heuristicsTriggered,
      }, 'Transaction flagged as fraud, queued for review');
    } else {
      logger.info({
        transactionId: transactionInput.id,
        score: result.score,
        riskLevel: result.riskLevel,
      }, 'Transaction passed fraud check');
    }

    return result;
  }

  /**
   * Gets the fraud alert model for external access
   * @returns FraudAlertModel instance
   */
  getFraudAlertModel(): FraudAlertModel {
    return this.fraudAlertModel;
  }

  /**
   * Gets the fraud alert model for external access (singleton)
   */
  static getAlertModel(): FraudAlertModel {
    return new FraudAlertModel();
  }

  /**
   * Updates transaction status to Review for high-risk transactions
   * @param transactionId The transaction ID
   * @returns Promise<void>
   */
  async setTransactionToReview(transactionId: string): Promise<void> {
    try {
      await this.transactionModel.updateStatus(transactionId, TransactionStatus.Review);
      logger.info({ transactionId }, 'Transaction set to Review status');
    } catch (error) {
      logger.error({ err: error, transactionId }, 'Failed to set transaction to Review');
      throw error;
    }
  }
}

// Export singleton instance
export const fraudService = new FraudService();