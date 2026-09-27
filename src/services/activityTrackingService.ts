/**
 * User activity tracking & analytics.
 *
 * Tracks user events into the immutable `user_events` table (see migration
 * `20260730_create_user_events.sql`) and aggregates them for product
 * decisions:
 *
 *   - `trackActivity`      — append an event (auth, transaction, kyc, ...)
 *   - `getOverview`        — dashboard headline numbers
 *   - `getUsageTrend`      — events / active users over time (day/week/month)
 *   - `getDailyActiveUsers`— DAU series
 *   - `getCohortRetention` — behavioral cohort retention analysis
 *
 * Tracking is **best-effort**: a failure to record an event is logged and
 * swallowed so analytics never breaks the primary request path.
 */

import { queryRead, queryWrite } from "../config/database";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActivityGranularity = "day" | "week" | "month";

export interface ActivityEventInput {
  userId: string;
  /** One of the `user_event_type` enum values (e.g. "user.login"). */
  eventType: string;
  /** Aggregate id for sequence numbering. Defaults to `userId`. */
  aggregateId?: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  sessionId?: string;
  correlationId?: string;
  occurredAt?: Date;
}

export interface DailyActiveUsersPoint {
  date: string;
  activeUsers: number;
}

export interface UsageTrendPoint {
  bucket: string;
  events: number;
  activeUsers: number;
  transactionEvents: number;
}

export interface EventCount {
  eventType: string;
  count: number;
}

export interface ActivityOverview {
  days: number;
  totalEvents: number;
  activeUsers: number;
  logins: number;
  topEventTypes: EventCount[];
}

export interface CohortRow {
  cohort: string;
  period: string;
  active_users: string | number;
  size: string | number;
}

export interface CohortRetentionCell {
  period: string;
  /** Offset in periods since the cohort started (0 = first period). */
  periodIndex: number;
  activeUsers: number;
  /** activeUsers / cohortSize, rounded to 4 decimals. */
  rate: number;
}

export interface CohortRetentionReport {
  cohortPeriod: string;
  cohorts: Array<{
    cohort: string;
    size: number;
    retention: CohortRetentionCell[];
  }>;
}

export interface ActivityTrackingDependencies {
  queryWriteFn?: typeof queryWrite;
  queryReadFn?: typeof queryRead;
  now?: () => Date;
  logger?: Pick<Console, "warn">;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Convert an ISO bucket string to a sortable index. Supports:
 *   - `YYYY-MM-DD` (day granularity)
 *   - `YYYY-MM` (month granularity)
 *   - `YYYY-MM-DD` week start dates (week granularity)
 * The index is the number of days/months since the epoch, so retention
 * offsets can be computed by subtracting cohort and period indices.
 */
export function bucketToIndex(bucket: string): number {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(bucket);
  if (!match) return 0;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3] ?? "01");
  return year * 12 * 31 + month * 31 + day;
}

/**
 * Compute the cohort retention matrix from aggregated DB rows.
 *
 * @param rows Rows of `{ cohort, period, active_users, size }` — one per
 *   (cohort, period) pair where the cohort's users were active.
 * @returns A report keyed by cohort with per-period retention rates.
 *   Periods where no users returned are omitted; rates are relative to the
 *   cohort's first-period size.
 */
export function computeCohortRetention(
  rows: CohortRow[],
): Omit<CohortRetentionReport, "cohortPeriod"> {
  const byCohort = new Map<string, CohortRow[]>();
  for (const row of rows) {
    const list = byCohort.get(row.cohort) ?? [];
    list.push(row);
    byCohort.set(row.cohort, list);
  }

  const cohorts: CohortRetentionReport["cohorts"] = [];
  for (const [cohort, cohortRows] of byCohort) {
    const cohortIndex = bucketToIndex(cohort);
    const size = Number(cohortRows[0]?.size ?? 0);

    const retention: CohortRetentionCell[] = cohortRows
      .map((row) => ({
        period: row.period,
        periodIndex: bucketToIndex(row.period) - cohortIndex,
        activeUsers: Number(row.active_users),
        rate: size > 0 ? Math.round((Number(row.active_users) / size) * 10000) / 10000 : 0,
      }))
      .filter((cell) => cell.periodIndex >= 0)
      .sort((a, b) => a.periodIndex - b.periodIndex);

    cohorts.push({ cohort, size, retention });
  }

  cohorts.sort((a, b) => a.cohort.localeCompare(b.cohort));
  return { cohorts };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const DEFAULT_LOGGER: Pick<Console, "warn"> = { warn: console.warn };

export class ActivityTrackingService {
  private readonly queryWriteFn: typeof queryWrite;
  private readonly queryReadFn: typeof queryRead;
  private readonly now: () => Date;
  private readonly logger: Pick<Console, "warn">;

  constructor(dependencies: ActivityTrackingDependencies = {}) {
    this.queryWriteFn = dependencies.queryWriteFn ?? queryWrite;
    this.queryReadFn = dependencies.queryReadFn ?? queryRead;
    this.now = dependencies.now ?? (() => new Date());
    this.logger = dependencies.logger ?? DEFAULT_LOGGER;
  }

  /**
   * Append an activity event. Best-effort: DB failures are logged and
   * swallowed (returns null) so callers can fire-and-forget.
   *
   * Sequence numbers are allocated per aggregate (max+1) so each aggregate's
   * event stream is strictly ordered and unique.
   *
   * @returns The inserted event id, or null when tracking failed.
   */
  async trackActivity(input: ActivityEventInput): Promise<string | null> {
    const aggregateId = input.aggregateId ?? input.userId;
    const occurredAt = (input.occurredAt ?? this.now()).toISOString();

    try {
      const result = await this.queryWriteFn<{ id: string }>(
        `INSERT INTO user_events (
           user_id, event_type, aggregate_type, aggregate_id, sequence_number,
           payload, metadata, ip_address, user_agent, session_id,
           correlation_id, occurred_at
         )
         SELECT $1, $2, 'user', $3,
                COALESCE(MAX(sequence_number), 0) + 1,
                $4, $5, $6::inet, $7, $8, $9::uuid, $10
         FROM user_events
         WHERE aggregate_id = $3
         RETURNING id`,
        [
          input.userId,
          input.eventType,
          aggregateId,
          JSON.stringify(input.payload ?? {}),
          JSON.stringify(input.metadata ?? {}),
          input.ipAddress ?? null,
          input.userAgent ?? null,
          input.sessionId ?? null,
          input.correlationId ?? null,
          occurredAt,
        ],
      );

      return result.rows[0]?.id ?? null;
    } catch (error) {
      this.logger.warn(
        `[activity] failed to track event=${input.eventType} user=${input.userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /**
   * Dashboard headline numbers for the trailing `days`.
   */
  async getOverview(days = 30): Promise<ActivityOverview> {
    const since = this.now();
    since.setDate(since.getDate() - days);

    const result = await this.queryReadFn<{
      total_events: string;
      active_users: string;
      logins: string;
    }>(
      `SELECT COUNT(*) AS total_events,
              COUNT(DISTINCT user_id) AS active_users,
              COUNT(*) FILTER (WHERE event_type = 'user.login') AS logins
       FROM user_events
       WHERE occurred_at >= $1`,
      [since],
    );

    const topResult = await this.queryReadFn<{
      event_type: string;
      count: string;
    }>(
      `SELECT event_type, COUNT(*) AS count
       FROM user_events
       WHERE occurred_at >= $1
       GROUP BY event_type
       ORDER BY count DESC
       LIMIT 10`,
      [since],
    );

    const row = result.rows[0];
    return {
      days,
      totalEvents: Number(row?.total_events ?? 0),
      activeUsers: Number(row?.active_users ?? 0),
      logins: Number(row?.logins ?? 0),
      topEventTypes: topResult.rows.map((r) => ({
        eventType: r.event_type,
        count: Number(r.count),
      })),
    };
  }

  /**
   * Daily active user series for the trailing `days`.
   */
  async getDailyActiveUsers(days = 30): Promise<DailyActiveUsersPoint[]> {
    const since = this.now();
    since.setDate(since.getDate() - days);

    const result = await this.queryReadFn<{
      day: Date | string;
      active_users: string;
    }>(
      `SELECT date_trunc('day', occurred_at)::date AS day,
              COUNT(DISTINCT user_id) AS active_users
       FROM user_events
       WHERE occurred_at >= $1
       GROUP BY 1
       ORDER BY 1`,
      [since],
    );

    return result.rows.map((r) => ({
      date:
        r.day instanceof Date
          ? r.day.toISOString().slice(0, 10)
          : String(r.day).slice(0, 10),
      activeUsers: Number(r.active_users),
    }));
  }

  /**
   * Event counts broken down by event type within a date range.
   */
  async getEventCounts(
    startDate: Date,
    endDate: Date,
    eventTypes?: string[],
  ): Promise<EventCount[]> {
    const params: unknown[] = [startDate, endDate];
    let typeClause = "";
    if (eventTypes && eventTypes.length > 0) {
      params.push(eventTypes);
      typeClause = ` AND event_type = ANY($${params.length})`;
    }

    const result = await this.queryReadFn<{
      event_type: string;
      count: string;
    }>(
      `SELECT event_type, COUNT(*) AS count
       FROM user_events
       WHERE occurred_at >= $1 AND occurred_at <= $2${typeClause}
       GROUP BY event_type
       ORDER BY count DESC`,
      params,
    );

    return result.rows.map((r) => ({
      eventType: r.event_type,
      count: Number(r.count),
    }));
  }

  /**
   * Usage trend: events, active users and transaction events per bucket
   * (day/week/month) over the trailing `days`.
   */
  async getUsageTrend(
    days = 30,
    granularity: ActivityGranularity = "day",
  ): Promise<UsageTrendPoint[]> {
    const since = this.now();
    since.setDate(since.getDate() - days);

    const result = await this.queryReadFn<{
      bucket: Date | string;
      events: string;
      active_users: string;
      transaction_events: string;
    }>(
      `SELECT date_trunc($1, occurred_at) AS bucket,
              COUNT(*) AS events,
              COUNT(DISTINCT user_id) AS active_users,
              COUNT(*) FILTER (WHERE event_type LIKE 'transaction.%') AS transaction_events
       FROM user_events
       WHERE occurred_at >= $2
       GROUP BY 1
       ORDER BY 1`,
      [granularity, since],
    );

    const formatBucket = (value: Date | string): string => {
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      return String(value).slice(0, 10);
    };

    return result.rows.map((r) => ({
      bucket: formatBucket(r.bucket),
      events: Number(r.events),
      activeUsers: Number(r.active_users),
      transactionEvents: Number(r.transaction_events),
    }));
  }

  /**
   * Behavioral cohort retention. Users are bucketed into cohorts by the
   * period of their first recorded activity; retention is the share of each
   * cohort that returns in every subsequent period.
   */
  async getCohortRetention(
    cohortPeriod: "week" | "month" = "week",
  ): Promise<CohortRetentionReport> {
    const result = await this.queryReadFn<CohortRow>(
      `WITH first_activity AS (
         SELECT user_id, MIN(date_trunc($1, occurred_at)) AS cohort
         FROM user_events
         GROUP BY user_id
       ),
       activity AS (
         SELECT user_id, date_trunc($1, occurred_at) AS period
         FROM user_events
         GROUP BY user_id, date_trunc($1, occurred_at)
       ),
       cohort_sizes AS (
         SELECT cohort, COUNT(*) AS size FROM first_activity GROUP BY cohort
       )
       SELECT to_char(c.cohort, 'YYYY-MM-DD') AS cohort,
              to_char(a.period, 'YYYY-MM-DD') AS period,
              COUNT(DISTINCT a.user_id) AS active_users,
              cs.size
       FROM first_activity c
       JOIN activity a ON a.user_id = c.user_id
       JOIN cohort_sizes cs ON cs.cohort = c.cohort
       GROUP BY c.cohort, a.period, cs.size
       ORDER BY c.cohort, a.period`,
      [cohortPeriod],
    );

    return {
      cohortPeriod,
      ...computeCohortRetention(result.rows),
    };
  }
}

export const activityTrackingService = new ActivityTrackingService();
