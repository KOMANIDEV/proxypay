import {
  ActivityTrackingService,
  bucketToIndex,
  computeCohortRetention,
  CohortRow,
} from "../../src/services/activityTrackingService";

describe("computeCohortRetention (pure)", () => {
  it("computes retention rates relative to cohort size", () => {
    const rows: CohortRow[] = [
      { cohort: "2026-01-01", period: "2026-01-01", active_users: 10, size: 10 },
      { cohort: "2026-01-01", period: "2026-01-08", active_users: 5, size: 10 },
      { cohort: "2026-01-01", period: "2026-01-15", active_users: 2, size: 10 },
      { cohort: "2026-01-08", period: "2026-01-08", active_users: 20, size: 20 },
      { cohort: "2026-01-08", period: "2026-01-15", active_users: 8, size: 20 },
    ];

    const report = computeCohortRetention(rows);
    expect(report.cohorts).toHaveLength(2);

    const first = report.cohorts.find((c) => c.cohort === "2026-01-01")!;
    expect(first.size).toBe(10);
    expect(first.retention).toHaveLength(3);
    expect(first.retention[0]).toMatchObject({ periodIndex: 0, rate: 1 });
    expect(first.retention[1]).toMatchObject({
      periodIndex: 7,
      activeUsers: 5,
      rate: 0.5,
    });
    expect(first.retention[2]).toMatchObject({ periodIndex: 14, rate: 0.2 });
  });

  it("rounds rates to 4 decimal places", () => {
    const rows: CohortRow[] = [
      { cohort: "2026-02-01", period: "2026-02-01", active_users: 3, size: 3 },
      { cohort: "2026-02-01", period: "2026-02-08", active_users: 1, size: 3 },
    ];
    const report = computeCohortRetention(rows);
    expect(report.cohorts[0].retention[1].rate).toBe(0.3333);
  });

  it("omits rows in periods before the cohort", () => {
    const rows: CohortRow[] = [
      { cohort: "2026-03-08", period: "2026-03-01", active_users: 5, size: 5 },
      { cohort: "2026-03-08", period: "2026-03-08", active_users: 5, size: 5 },
    ];
    const report = computeCohortRetention(rows);
    expect(report.cohorts[0].retention).toHaveLength(1);
    expect(report.cohorts[0].retention[0].periodIndex).toBe(0);
  });

  it("bucketToIndex orders buckets correctly", () => {
    expect(bucketToIndex("2026-01-01")).toBeLessThan(bucketToIndex("2026-01-08"));
    expect(bucketToIndex("2026-01-31")).toBeLessThan(bucketToIndex("2026-02-01"));
  });
});

describe("ActivityTrackingService.trackActivity", () => {
  it("inserts an event with a per-aggregate sequence number and returns the id", async () => {
    const queryWriteFn = jest.fn(async () => ({
      rows: [{ id: "evt-1" }],
    })) as any;

    const service = new ActivityTrackingService({
      queryWriteFn,
      now: () => new Date("2026-03-27T11:46:00.000Z"),
    });

    const id = await service.trackActivity({
      userId: "user-1",
      eventType: "user.login",
      payload: { plan: "pro" },
      ipAddress: "127.0.0.1",
      userAgent: "test-agent",
    });

    expect(id).toBe("evt-1");
    expect(queryWriteFn).toHaveBeenCalledTimes(1);
    const [sql, params] = queryWriteFn.mock.calls[0];

    expect(sql).toContain("INSERT INTO user_events");
    expect(sql).toContain("COALESCE(MAX(sequence_number), 0) + 1");
    expect(params[1]).toBe("user.login");
    expect(params[2]).toBe("user-1"); // aggregate_id defaults to userId
    expect(params[6]).toBe("test-agent"); // user_agent
    expect(params[9]).toBe("2026-03-27T11:46:00.000Z"); // occurred_at
  });

  it("swallows DB errors and returns null (best-effort)", async () => {
    const queryWriteFn = jest.fn(async () => {
      throw new Error("db down");
    }) as any;
    const logger = { warn: jest.fn() };

    const service = new ActivityTrackingService({ queryWriteFn, logger });
    const id = await service.trackActivity({
      userId: "user-1",
      eventType: "user.login",
    });

    expect(id).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to track event"),
    );
  });
});

describe("ActivityTrackingService aggregations", () => {
  it("getOverview returns headline numbers and top event types", async () => {
    const queryReadFn = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [{ total_events: "100", active_users: "42", logins: "30" }],
      })
      .mockResolvedValueOnce({
        rows: [
          { event_type: "user.login", count: "30" },
          { event_type: "transaction.deposit_initiated", count: "22" },
        ],
      }) as any;

    const service = new ActivityTrackingService({ queryReadFn });
    const overview = await service.getOverview(30);

    expect(overview).toMatchObject({
      days: 30,
      totalEvents: 100,
      activeUsers: 42,
      logins: 30,
    });
    expect(overview.topEventTypes).toEqual([
      { eventType: "user.login", count: 30 },
      { eventType: "transaction.deposit_initiated", count: 22 },
    ]);
  });

  it("getDailyActiveUsers maps dates and counts", async () => {
    const queryReadFn = jest.fn(async () => ({
      rows: [{ day: new Date("2026-03-26T00:00:00.000Z"), active_users: "12" }],
    })) as any;

    const service = new ActivityTrackingService({ queryReadFn });
    const series = await service.getDailyActiveUsers(30);

    expect(series).toEqual([{ date: "2026-03-26", activeUsers: 12 }]);
  });

  it("getUsageTrend buckets events, active users and transaction events", async () => {
    const queryReadFn = jest.fn(async () => ({
      rows: [
        {
          bucket: new Date("2026-03-27T00:00:00.000Z"),
          events: "8",
          active_users: "5",
          transaction_events: "3",
        },
      ],
    })) as any;

    const service = new ActivityTrackingService({ queryReadFn });
    const trend = await service.getUsageTrend(30, "day");

    expect(trend).toEqual([
      {
        bucket: "2026-03-27",
        events: 8,
        activeUsers: 5,
        transactionEvents: 3,
      },
    ]);
    expect(queryReadFn.mock.calls[0][1]).toEqual(["day", expect.any(Date)]);
  });

  it("getCohortRetention runs the cohort SQL and formats a report", async () => {
    const queryReadFn = jest.fn(async () => ({
      rows: [
        { cohort: "2026-01-01", period: "2026-01-01", active_users: 10, size: 10 },
        { cohort: "2026-01-01", period: "2026-01-08", active_users: 5, size: 10 },
      ],
    })) as any;

    const service = new ActivityTrackingService({ queryReadFn });
    const report = await service.getCohortRetention("week");

    expect(report.cohortPeriod).toBe("week");
    expect(queryReadFn.mock.calls[0][1]).toEqual(["week"]);
    expect(report.cohorts[0]).toMatchObject({
      cohort: "2026-01-01",
      size: 10,
    });
    expect(report.cohorts[0].retention[1].rate).toBe(0.5);
  });
});