import { pool } from "../config/database";

export type FraudAlertStatus = 'flagged' | 'reviewed' | 'false_positive' | 'confirmed';
export type FraudRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type FraudRecommendedAction = 'allow' | 'review' | 'block';

export interface FraudAlert {
  id: string;
  transactionId: string;
  userId?: string;
  score: number;
  riskLevel: FraudRiskLevel;
  recommendedAction: FraudRecommendedAction;
  reasons: string[];
  heuristicsTriggered: string[];
  heuristicDetails: Record<string, unknown>;
  userContext: Record<string, unknown>;
  status: FraudAlertStatus;
  reviewedBy?: string;
  reviewNotes?: string;
  reviewedAt?: string;
  isFalsePositive: boolean;
  falsePositiveReason?: string;
  durationMs?: number;
  transactionAmount?: number;
  transactionType?: string;
  provider?: string;
  phoneNumber?: string;
  createdAt: string;
  updatedAt: string;
  // Feedback fields for false positive/confirmed fraud tracking
  feedback?: 'false_positive' | 'confirmed_fraud';
  feedbackBy?: string;
  feedbackNotes?: string;
  feedbackAt?: string;
}

export interface FraudAlertFilter {
  status?: FraudAlertStatus;
  userId?: string;
  riskLevel?: FraudRiskLevel;
  isFalsePositive?: boolean;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
  before?: string;
  after?: string;
}

export interface FraudAlertListResult {
  alerts: FraudAlert[];
  total: number;
  flaggedCount: number;
  hasMore?: boolean;
}

export interface FraudReviewInput {
  status: FraudAlertStatus;
  reviewNotes?: string;
  isFalsePositive?: boolean;
  falsePositiveReason?: string;
}

export interface FraudFeedbackInput {
  feedback: 'false_positive' | 'confirmed_fraud';
  reviewer: string;
  notes?: string;
}

export interface FraudReviewHistoryEntry {
  id: string;
  alertId: string;
  previousStatus: string;
  newStatus: string;
  reviewedBy: string;
  reviewNotes?: string;
  createdAt: string;
}

export class FraudAlertModel {
  async create(alert: {
    transactionId: string;
    userId?: string;
    score: number;
    riskLevel: FraudRiskLevel;
    recommendedAction: FraudRecommendedAction;
    reasons: string[];
    heuristicsTriggered: string[];
    heuristicDetails: Record<string, unknown>;
    userContext: Record<string, unknown>;
    durationMs?: number;
    transactionAmount?: number;
    transactionType?: string;
    provider?: string;
    phoneNumber?: string;
  }): Promise<FraudAlert> {
    const query = `
      INSERT INTO fraud_alerts (
        transaction_id, user_id, score, risk_level, recommended_action,
        reasons, heuristics_triggered, heuristic_details, user_context,
        duration_ms, transaction_amount, transaction_type, provider, phone_number
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING
        id,
        transaction_id AS "transactionId",
        user_id AS "userId",
        score,
        risk_level AS "riskLevel",
        recommended_action AS "recommendedAction",
        reasons,
        heuristics_triggered AS "heuristicsTriggered",
        heuristic_details AS "heuristicDetails",
        user_context AS "userContext",
        status,
        reviewed_by AS "reviewedBy",
        review_notes AS "reviewNotes",
        reviewed_at AS "reviewedAt",
        is_false_positive AS "isFalsePositive",
        false_positive_reason AS "falsePositiveReason",
        duration_ms AS "durationMs",
        transaction_amount AS "transactionAmount",
        transaction_type AS "transactionType",
        provider,
        phone_number AS "phoneNumber",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;

    const result = await pool.query(query, [
      alert.transactionId,
      alert.userId || null,
      alert.score,
      alert.riskLevel,
      alert.recommendedAction,
      alert.reasons,
      alert.heuristicsTriggered,
      JSON.stringify(alert.heuristicDetails),
      JSON.stringify(alert.userContext),
      alert.durationMs || null,
      alert.transactionAmount || null,
      alert.transactionType || null,
      alert.provider || null,
      alert.phoneNumber || null,
    ]);

    return this.mapRow(result.rows[0]);
  }

  async findById(id: string): Promise<FraudAlert | null> {
    const query = `
      SELECT
        id,
        transaction_id AS "transactionId",
        user_id AS "userId",
        score,
        risk_level AS "riskLevel",
        recommended_action AS "recommendedAction",
        reasons,
        heuristics_triggered AS "heuristicsTriggered",
        heuristic_details AS "heuristicDetails",
        user_context AS "userContext",
        status,
        reviewed_by AS "reviewedBy",
        review_notes AS "reviewNotes",
        reviewed_at AS "reviewedAt",
        is_false_positive AS "isFalsePositive",
        false_positive_reason AS "falsePositiveReason",
        duration_ms AS "durationMs",
        transaction_amount AS "transactionAmount",
        transaction_type AS "transactionType",
        provider,
        phone_number AS "phoneNumber",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM fraud_alerts
      WHERE id = $1
    `;

    const result = await pool.query(query, [id]);
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  async findByTransactionId(transactionId: string): Promise<FraudAlert[]> {
    const query = `
      SELECT
        id,
        transaction_id AS "transactionId",
        user_id AS "userId",
        score,
        risk_level AS "riskLevel",
        recommended_action AS "recommendedAction",
        reasons,
        heuristics_triggered AS "heuristicsTriggered",
        heuristic_details AS "heuristicDetails",
        user_context AS "userContext",
        status,
        reviewed_by AS "reviewedBy",
        review_notes AS "reviewNotes",
        reviewed_at AS "reviewedAt",
        is_false_positive AS "isFalsePositive",
        false_positive_reason AS "falsePositiveReason",
        duration_ms AS "durationMs",
        transaction_amount AS "transactionAmount",
        transaction_type AS "transactionType",
        provider,
        phone_number AS "phoneNumber",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM fraud_alerts
      WHERE transaction_id = $1
      ORDER BY created_at DESC
    `;

    const result = await pool.query(query, [transactionId]);
    return result.rows.map((row) => this.mapRow(row));
  }

  async list(filter: FraudAlertFilter = {}): Promise<FraudAlertListResult> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (filter.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(filter.status);
    }

    if (filter.userId) {
      conditions.push(`user_id = $${paramIndex++}`);
      params.push(filter.userId);
    }

    if (filter.riskLevel) {
      conditions.push(`risk_level = $${paramIndex++}`);
      params.push(filter.riskLevel);
    }

    if (filter.isFalsePositive !== undefined) {
      conditions.push(`is_false_positive = $${paramIndex++}`);
      params.push(filter.isFalsePositive);
    }

    if (filter.startDate) {
      conditions.push(`created_at >= $${paramIndex++}`);
      params.push(filter.startDate);
    }

    if (filter.endDate) {
      conditions.push(`created_at <= $${paramIndex++}`);
      params.push(filter.endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countQuery = `SELECT COUNT(*) as count FROM fraud_alerts ${whereClause}`;
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].count, 10);

    const flaggedQuery = `
      SELECT COUNT(*) as count
      FROM fraud_alerts
      ${whereClause ? whereClause + " AND" : "WHERE"} status = 'flagged'
    `;
    const flaggedResult = await pool.query(flaggedQuery, params);
    const flaggedCount = parseInt(flaggedResult.rows[0].count, 10);

    let cursorTime: Date | null = null;
    let cursorId: string | null = null;
    let isReversed = false;

    if (filter.after) {
      const decoded = Buffer.from(filter.after, "base64").toString("utf8");
      const [timeStr, idStr] = decoded.split("|");
      if (timeStr && idStr) {
        const parsedTime = new Date(timeStr);
        if (!isNaN(parsedTime.getTime())) {
          cursorTime = parsedTime;
          cursorId = idStr;
        }
      }
    } else if (filter.before) {
      const decoded = Buffer.from(filter.before, "base64").toString("utf8");
      const [timeStr, idStr] = decoded.split("|");
      if (timeStr && idStr) {
        const parsedTime = new Date(timeStr);
        if (!isNaN(parsedTime.getTime())) {
          cursorTime = parsedTime;
          cursorId = idStr;
          isReversed = true;
        }
      }
    }

    const alertsConditions = [...conditions];
    const alertsParams = [...params];
    let alertsParamIndex = paramIndex;

    if (cursorTime && cursorId) {
      if (isReversed) {
        alertsConditions.push(
          `(created_at > $${alertsParamIndex} OR (created_at = $${alertsParamIndex} AND id > $${alertsParamIndex + 1}))`
        );
      } else {
        alertsConditions.push(
          `(created_at < $${alertsParamIndex} OR (created_at = $${alertsParamIndex} AND id < $${alertsParamIndex + 1}))`
        );
      }
      alertsParams.push(cursorTime);
      alertsParams.push(cursorId);
      alertsParamIndex += 2;
    }

    const alertsWhereClause =
      alertsConditions.length > 0 ? `WHERE ${alertsConditions.join(" AND ")}` : "";

    const limit = filter.limit ?? 50;
    const isCursorPagination = !!(filter.before || filter.after);
    const sortOrder = isReversed ? "ASC" : "DESC";

    const selectColumns = `
      id,
      transaction_id AS "transactionId",
      user_id AS "userId",
      score,
      risk_level AS "riskLevel",
      recommended_action AS "recommendedAction",
      reasons,
      heuristics_triggered AS "heuristicsTriggered",
      heuristic_details AS "heuristicDetails",
      user_context AS "userContext",
      status,
      reviewed_by AS "reviewedBy",
      review_notes AS "reviewNotes",
      reviewed_at AS "reviewedAt",
      is_false_positive AS "isFalsePositive",
      false_positive_reason AS "falsePositiveReason",
      duration_ms AS "durationMs",
      transaction_amount AS "transactionAmount",
      transaction_type AS "transactionType",
      provider,
      phone_number AS "phoneNumber",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    `;

    let alertsQuery = "";
    let alertsResult;

    if (isCursorPagination) {
      alertsQuery = `
        SELECT ${selectColumns}
        FROM fraud_alerts
        ${alertsWhereClause}
        ORDER BY created_at ${sortOrder}, id ${sortOrder}
        LIMIT $${alertsParamIndex++}
      `;
      alertsResult = await pool.query(alertsQuery, [...alertsParams, limit + 1]);
    } else {
      const offset = filter.offset ?? 0;
      alertsQuery = `
        SELECT ${selectColumns}
        FROM fraud_alerts
        ${alertsWhereClause}
        ORDER BY created_at DESC, id DESC
        LIMIT $${alertsParamIndex++} OFFSET $${alertsParamIndex++}
      `;
      alertsResult = await pool.query(alertsQuery, [...alertsParams, limit, offset]);
    }

    let alerts = alertsResult.rows.map((row) => this.mapRow(row));
    let hasMore = false;

    if (isCursorPagination) {
      if (alerts.length > limit) {
        hasMore = true;
        alerts = alerts.slice(0, limit);
      }
      if (isReversed) {
        alerts.reverse();
      }
    } else {
      const offset = filter.offset ?? 0;
      hasMore = offset + limit < total;
    }

    return { alerts, total, flaggedCount, hasMore };
  }

  async findByUserId(userId: string, limit = 50, offset = 0): Promise<FraudAlertListResult> {
    return this.list({ userId, limit, offset });
  }

  async review(
    alertId: string,
    input: FraudReviewInput,
    reviewerId: string,
  ): Promise<FraudAlert | null> {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const currentQuery = `
        SELECT status FROM fraud_alerts WHERE id = $1 FOR UPDATE
      `;
      const currentResult = await client.query(currentQuery, [alertId]);

      if (currentResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return null;
      }

      const previousStatus = currentResult.rows[0].status;

      const updateQuery = `
        UPDATE fraud_alerts
        SET
          status = $1,
          reviewed_by = $2,
          review_notes = $3,
          reviewed_at = CURRENT_TIMESTAMP,
          is_false_positive = $4,
          false_positive_reason = $5,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $6
        RETURNING
          id,
          transaction_id AS "transactionId",
          user_id AS "userId",
          score,
          risk_level AS "riskLevel",
          recommended_action AS "recommendedAction",
          reasons,
          heuristics_triggered AS "heuristicsTriggered",
          heuristic_details AS "heuristicDetails",
          user_context AS "userContext",
          status,
          reviewed_by AS "reviewedBy",
          review_notes AS "reviewNotes",
          reviewed_at AS "reviewedAt",
          is_false_positive AS "isFalsePositive",
          false_positive_reason AS "falsePositiveReason",
          duration_ms AS "durationMs",
          transaction_amount AS "transactionAmount",
          transaction_type AS "transactionType",
          provider,
          phone_number AS "phoneNumber",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `;

      const updateResult = await client.query(updateQuery, [
        input.status,
        reviewerId,
        input.reviewNotes || null,
        input.isFalsePositive || false,
        input.falsePositiveReason || null,
        alertId,
      ]);

      const historyQuery = `
        INSERT INTO fraud_alert_review_history (
          alert_id, previous_status, new_status, reviewed_by, review_notes
        )
        VALUES ($1, $2, $3, $4, $5)
      `;

      await client.query(historyQuery, [
        alertId,
        previousStatus,
        input.status,
        reviewerId,
        input.reviewNotes || null,
      ]);

      await client.query("COMMIT");

      return this.mapRow(updateResult.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markFalsePositive(
    alertId: string,
    reason: string,
    reviewerId: string,
  ): Promise<FraudAlert | null> {
    return this.review(alertId, {
      status: 'false_positive',
      isFalsePositive: true,
      falsePositiveReason: reason,
      reviewNotes: `Marked as false positive: ${reason}`,
    }, reviewerId);
  }

  /**
   * Record feedback on a fraud alert (simplified interface for false positive/confirmed fraud)
   * This method provides a simplified interface for marking alerts as false positive or confirmed fraud
   */
  async recordFeedback(
    alertId: string,
    feedback: 'false_positive' | 'confirmed_fraud',
    reviewer: string,
    notes?: string,
  ): Promise<FraudAlert | null> {
    const status = feedback === 'false_positive' ? 'false_positive' : 'confirmed';
    const isFalsePositive = feedback === 'false_positive';
    const falsePositiveReason = isFalsePositive ? notes : undefined;
    const reviewNotes = notes ? `Feedback: ${feedback}. ${notes}` : `Feedback: ${feedback}`;

    try {
      const query = `
        UPDATE fraud_alerts
        SET
          status = $1,
          reviewed_by = $2,
          review_notes = $3,
          reviewed_at = CURRENT_TIMESTAMP,
          is_false_positive = $4,
          false_positive_reason = $5,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $6
        RETURNING
          id,
          transaction_id AS "transactionId",
          user_id AS "userId",
          score,
          risk_level AS "riskLevel",
          recommended_action AS "recommendedAction",
          reasons,
          heuristics_triggered AS "heuristicsTriggered",
          heuristic_details AS "heuristicDetails",
          user_context AS "userContext",
          status,
          reviewed_by AS "reviewedBy",
          review_notes AS "reviewNotes",
          reviewed_at AS "reviewedAt",
          is_false_positive AS "isFalsePositive",
          false_positive_reason AS "falsePositiveReason",
          duration_ms AS "durationMs",
          transaction_amount AS "transactionAmount",
          transaction_type AS "transactionType",
          provider,
          phone_number AS "phoneNumber",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `;

      const result = await pool.query(query, [
        status,
        reviewer,
        reviewNotes,
        isFalsePositive,
        falsePositiveReason || null,
        alertId,
      ]);

      if (result.rows.length === 0) {
        return null;
      }

      // Also record in review history (best effort, don't fail if it fails)
      try {
        const historyQuery = `
          INSERT INTO fraud_alert_review_history (
            alert_id, previous_status, new_status, reviewed_by, review_notes
          )
          VALUES ($1, $2, $3, $4, $5)
        `;
        // Get previous status - use a separate query that won't fail the main operation
        let previousStatus = 'flagged';
        try {
          const prevQuery = `SELECT status FROM fraud_alerts WHERE id = $1`;
          const prevResult = await pool.query(prevQuery, [alertId]);
          if (prevResult.rows.length > 0) {
            previousStatus = prevResult.rows[0].status;
          }
        } catch {
          // Ignore error, use default
        }
        
        await pool.query(historyQuery, [
          alertId,
          previousStatus,
          status,
          reviewer,
          reviewNotes,
        ]);
      } catch (historyError) {
        // Don't fail the feedback if history recording fails
        console.warn('Failed to record review history:', historyError);
      }

      return this.mapRow(result.rows[0]);
    } catch (error) {
      console.error('Failed to record feedback:', error);
      return null;
    }
  }

  async getReviewHistory(alertId: string): Promise<FraudReviewHistoryEntry[]> {
    const query = `
      SELECT
        id,
        alert_id AS "alertId",
        previous_status AS "previousStatus",
        new_status AS "newStatus",
        reviewed_by AS "reviewedBy",
        review_notes AS "reviewNotes",
        created_at AS "createdAt"
      FROM fraud_alert_review_history
      WHERE alert_id = $1
      ORDER BY created_at DESC
    `;

    const result = await pool.query(query, [alertId]);
    return result.rows.map((row) => ({
      id: row.id,
      alertId: row.alertId,
      previousStatus: row.previousStatus,
      newStatus: row.newStatus,
      reviewedBy: row.reviewedBy,
      reviewNotes: row.reviewNotes,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async getStatistics(): Promise<{
    totalAlerts: number;
    flaggedAlerts: number;
    falsePositives: number;
    confirmedFraud: number;
    averageScore: number;
    riskLevelBreakdown: Record<FraudRiskLevel, number>;
  }> {
    const query = `
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'flagged') as flagged,
        COUNT(*) FILTER (WHERE is_false_positive = TRUE) as false_positives,
        COUNT(*) FILTER (WHERE status = 'confirmed') as confirmed,
        COALESCE(AVG(score), 0) as avg_score,
        COUNT(*) FILTER (WHERE risk_level = 'low') as low,
        COUNT(*) FILTER (WHERE risk_level = 'medium') as medium,
        COUNT(*) FILTER (WHERE risk_level = 'high') as high_risk,
        COUNT(*) FILTER (WHERE risk_level = 'critical') as critical
      FROM fraud_alerts
    `;

    const result = await pool.query(query);
    const row = result.rows[0];

    return {
      totalAlerts: parseInt(row.total, 10),
      flaggedAlerts: parseInt(row.flagged, 10),
      falsePositives: parseInt(row.false_positives, 10),
      confirmedFraud: parseInt(row.confirmed, 10),
      averageScore: parseFloat(row.avg_score),
      riskLevelBreakdown: {
        low: parseInt(row.low, 10),
        medium: parseInt(row.medium, 10),
        high: parseInt(row.high_risk, 10),
        critical: parseInt(row.critical, 10),
      },
    };
  }

  private mapRow(row: any): FraudAlert {
    // Handle both real database column names (snake_case from SQL aliases) and test mock column names (camelCase)
    const createdAt = row.createdAt || row.created_at;
    const updatedAt = row.updatedAt || row.updated_at;
    const reviewedBy = row.reviewedBy || row.reviewed_by || row.feedbackBy || row.feedback_by;
    const reviewNotes = row.reviewNotes || row.review_notes || row.feedbackNotes || row.feedback_notes;
    const reviewedAt = row.reviewedAt || row.reviewed_at || row.feedbackAt || row.feedback_at;
    const isFalsePositive = row.isFalsePositive ?? row.is_false_positive ?? (row.feedback === 'false_positive');
    const falsePositiveReason = row.falsePositiveReason || row.false_positive_reason || (row.feedback === 'false_positive' ? row.feedbackNotes || row.feedback_notes : undefined);
    const durationMs = row.durationMs || row.duration_ms;
    const transactionAmount = row.transactionAmount || row.transaction_amount;
    const transactionType = row.transactionType || row.transaction_type;
    const phoneNumber = row.phoneNumber || row.phone_number;

    const parseJsonField = (field: any): any => {
      if (typeof field === 'string') {
        try {
          return JSON.parse(field);
        } catch {
          return field;
        }
      }
      return field;
    };

    // Map feedback fields
    const feedback = row.feedback || (row.isFalsePositive || row.is_false_positive ? 'false_positive' : undefined);
    const feedbackBy = row.feedbackBy || row.feedback_by || row.reviewedBy || row.reviewed_by;
    const feedbackNotes = row.feedbackNotes || row.feedback_notes || row.reviewNotes || row.review_notes;
    const feedbackAt = row.feedbackAt || row.feedback_at || row.reviewedAt || row.reviewed_at;

    return {
      id: row.id,
      transactionId: row.transactionId || row.transaction_id,
      userId: row.userId || row.user_id || undefined,
      score: row.score,
      riskLevel: row.riskLevel || row.risk_level,
      recommendedAction: row.recommendedAction || row.recommended_action,
      reasons: parseJsonField(row.reasons) || [],
      heuristicsTriggered: parseJsonField(row.heuristicsTriggered || row.heuristics_triggered) || [],
      heuristicDetails: parseJsonField(row.heuristicDetails || row.heuristic_details) || {},
      userContext: parseJsonField(row.userContext || row.user_context) || {},
      status: row.status,
      reviewedBy: reviewedBy || undefined,
      reviewNotes: reviewNotes || undefined,
      reviewedAt: reviewedAt ? (reviewedAt instanceof Date ? reviewedAt.toISOString() : reviewedAt) : undefined,
      isFalsePositive,
      falsePositiveReason: falsePositiveReason || undefined,
      durationMs: durationMs || undefined,
      transactionAmount: transactionAmount ? parseFloat(transactionAmount) : undefined,
      transactionType: transactionType || undefined,
      provider: row.provider || undefined,
      phoneNumber: phoneNumber || undefined,
      createdAt: createdAt instanceof Date ? createdAt.toISOString() : createdAt,
      updatedAt: updatedAt instanceof Date ? updatedAt.toISOString() : updatedAt,
      feedback,
      feedbackBy,
      feedbackNotes,
      feedbackAt: feedbackAt ? (feedbackAt instanceof Date ? feedbackAt.toISOString() : feedbackAt) : undefined,
    };
  }
}
