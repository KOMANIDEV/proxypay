/**
 * Tests for Stellar Account Merge Dry-Run Service (Issue #421)
 *
 * Covers:
 *  - Pre-merge checks (balances, trustlines, signers, inactivity)
 *  - Eligible and ineligible account scenarios
 *  - Account not found on Horizon
 *  - Invalid public keys
 *  - Source equals destination guard
 *  - Merchant review workflow
 *  - Batch dry-run
 */

import * as StellarSdk from "stellar-sdk";
import {
  runAccountMergeDryRun,
  runBatchDryRun,
  submitForMerchantReview,
  recordMerchantReviewDecision,
  getMerchantReviewRecord,
  getPendingMerchantReviews,
  expireStaleMerchantReviews,
  assertReviewIsFresh,
  AccountMergeDryRunReport,
} from "../../src/services/accountMergeDryRun";
import { queryRead, queryWrite } from "../../src/config/database";

// The review store is Postgres-backed as of #570. The rest of this file mocks
// the Stellar server, so mocking the database here keeps the review tests
// hermetic and lets them assert on the SQL rather than on a Map.
jest.mock("../../src/config/database");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a fresh random Stellar keypair for use in tests. */
function randomKeypair() {
  return StellarSdk.Keypair.random();
}

/** Build a minimal mock Horizon AccountRecord. */
function buildMockAccount(
  keypair: StellarSdk.Keypair,
  overrides: Partial<StellarSdk.Horizon.ServerApi.AccountRecord> = {},
): StellarSdk.Horizon.ServerApi.AccountRecord {
  return {
    id: keypair.publicKey(),
    paging_token: "",
    account_id: keypair.publicKey(),
    sequence: "12345678",
    sequence_bumped_at: new Date().toISOString(),
    subentry_count: 0,
    signers: [{ key: keypair.publicKey(), weight: 1, type: "ed25519_public_key" }],
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: { auth_required: false, auth_revocable: false, auth_immutable: false, auth_clawback_enabled: false },
    balances: [{ asset_type: "native", balance: "10.0000000" } as any],
    data_attr: {},
    effects_url: "",
    offers_url: "",
    operations_url: "",
    payments_url: "",
    trades_url: "",
    last_modified_ledger: 1,
    last_modified_time: new Date().toISOString(),
    _links: {} as any,
    _embedded: { records: [] } as any,
    ...overrides,
  } as unknown as StellarSdk.Horizon.ServerApi.AccountRecord;
}

/** Build a minimal mock Horizon.Server. */
function buildMockServer(options: {
  sourceAccount?: StellarSdk.Horizon.ServerApi.AccountRecord | null;
  destAccount?: StellarSdk.Horizon.ServerApi.AccountRecord | null;
  lastActivityAt?: Date | null;
}) {
  const mockTxResponse = options.lastActivityAt
    ? {
        records: [
          {
            created_at: options.lastActivityAt.toISOString(),
          },
        ],
      }
    : { records: [] };

  const txCallFn = jest.fn().mockResolvedValue(mockTxResponse);
  const mockTxBuilder = {
    forAccount: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    call: txCallFn,
  };

  const loadAccountFn = jest.fn(async (key: string) => {
    if (key === options.sourceAccount?.account_id) {
      if (!options.sourceAccount) throw { response: { status: 404 } };
      return options.sourceAccount;
    }
    if (options.destAccount && key === options.destAccount.account_id) {
      return options.destAccount;
    }
    throw { response: { status: 404 } };
  });

  return {
    loadAccount: loadAccountFn,
    transactions: jest.fn().mockReturnValue(mockTxBuilder),
  } as unknown as StellarSdk.Horizon.Server;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Account Merge Dry-Run Service (Issue #421)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // runAccountMergeDryRun — eligible scenarios
  // -------------------------------------------------------------------------

  describe("runAccountMergeDryRun — eligible account", () => {
    it("marks an inactive, clean account as eligible", async () => {
      const source = randomKeypair();
      const dest = randomKeypair();

      const sourceAccount = buildMockAccount(source);
      const server = buildMockServer({
        sourceAccount,
        destAccount: buildMockAccount(dest),
        // Account was last active 60 days ago — well past the 30-day cutoff
        lastActivityAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      });

      const report = await runAccountMergeDryRun(
        source.publicKey(),
        dest.publicKey(),
        30,
        server,
      );

      expect(report.eligible).toBe(true);
      expect(report.accountFound).toBe(true);
      expect(parseFloat(report.reclaimableXLM)).toBeGreaterThan(0);
      expect(report.checks.every((c) => c.passed || c.name === "destination_exists")).toBe(true);
    });

    it("includes all expected fields in the report", async () => {
      const source = randomKeypair();
      const dest = randomKeypair();

      const server = buildMockServer({
        sourceAccount: buildMockAccount(source),
        destAccount: buildMockAccount(dest),
        lastActivityAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      });

      const report = await runAccountMergeDryRun(
        source.publicKey(),
        dest.publicKey(),
        30,
        server,
      );

      expect(report).toHaveProperty("sourcePublicKey", source.publicKey());
      expect(report).toHaveProperty("destinationPublicKey", dest.publicKey());
      expect(report).toHaveProperty("eligible");
      expect(report).toHaveProperty("summary");
      expect(report).toHaveProperty("reclaimableXLM");
      expect(report).toHaveProperty("subentryCount");
      expect(report).toHaveProperty("trustlines");
      expect(report).toHaveProperty("signers");
      expect(report).toHaveProperty("sequenceNumber");
      expect(report).toHaveProperty("lastActivityAt");
      expect(report).toHaveProperty("checks");
      expect(report).toHaveProperty("accountFound");
      expect(report).toHaveProperty("generatedAt");
    });
  });

  // -------------------------------------------------------------------------
  // runAccountMergeDryRun — ineligible scenarios
  // -------------------------------------------------------------------------

  describe("runAccountMergeDryRun — ineligible account", () => {
    it("rejects a recently active account", async () => {
      const source = randomKeypair();
      const dest = randomKeypair();

      const server = buildMockServer({
        sourceAccount: buildMockAccount(source),
        destAccount: buildMockAccount(dest),
        // Account was active just 5 days ago — inside the 30-day inactivity window
        lastActivityAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      });

      const report = await runAccountMergeDryRun(
        source.publicKey(),
        dest.publicKey(),
        30,
        server,
      );

      expect(report.eligible).toBe(false);
      const inactivityCheck = report.checks.find(
        (c) => c.name === "inactivity_requirement",
      );
      expect(inactivityCheck?.passed).toBe(false);
    });

    it("rejects an account with non-native balances", async () => {
      const source = randomKeypair();
      const dest = randomKeypair();

      const sourceWithAssets = buildMockAccount(source, {
        balances: [
          { asset_type: "native", balance: "10.0000000" } as any,
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
            balance: "50.0000000",
            limit: "1000.0000000",
            is_authorized: true,
          } as any,
        ],
        subentry_count: 1,
      });

      const server = buildMockServer({
        sourceAccount: sourceWithAssets,
        lastActivityAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      });

      const report = await runAccountMergeDryRun(
        source.publicKey(),
        dest.publicKey(),
        30,
        server,
      );

      expect(report.eligible).toBe(false);
      const trustlineCheck = report.checks.find(
        (c) => c.name === "no_non_native_balances",
      );
      expect(trustlineCheck?.passed).toBe(false);
    });

    it("rejects an account with subentries", async () => {
      const source = randomKeypair();
      const dest = randomKeypair();

      const sourceWithSubentries = buildMockAccount(source, {
        subentry_count: 3,
      });

      const server = buildMockServer({
        sourceAccount: sourceWithSubentries,
        lastActivityAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      });

      const report = await runAccountMergeDryRun(
        source.publicKey(),
        dest.publicKey(),
        30,
        server,
      );

      expect(report.eligible).toBe(false);
      const subentryCheck = report.checks.find(
        (c) => c.name === "no_subentries",
      );
      expect(subentryCheck?.passed).toBe(false);
    });

    it("rejects an account with insufficient XLM balance", async () => {
      const source = randomKeypair();
      const dest = randomKeypair();

      const lowBalanceAccount = buildMockAccount(source, {
        balances: [{ asset_type: "native", balance: "0.0000100" } as any],
      });

      const server = buildMockServer({
        sourceAccount: lowBalanceAccount,
        lastActivityAt: null,
      });

      const report = await runAccountMergeDryRun(
        source.publicKey(),
        dest.publicKey(),
        30,
        server,
      );

      expect(report.eligible).toBe(false);
      const balanceCheck = report.checks.find(
        (c) => c.name === "sufficient_balance",
      );
      expect(balanceCheck?.passed).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // runAccountMergeDryRun — error cases
  // -------------------------------------------------------------------------

  describe("runAccountMergeDryRun — error cases", () => {
    it("returns accountFound=false when account is not on Horizon", async () => {
      const source = randomKeypair();
      const dest = randomKeypair();

      const server = buildMockServer({
        sourceAccount: null,
        lastActivityAt: null,
      });

      const report = await runAccountMergeDryRun(
        source.publicKey(),
        dest.publicKey(),
        30,
        server,
      );

      expect(report.accountFound).toBe(false);
      expect(report.eligible).toBe(false);
      expect(report.checks.some((c) => c.name === "account_exists" && !c.passed)).toBe(true);
    });

    it("returns eligible=false for invalid source public key", async () => {
      const dest = randomKeypair();
      const server = buildMockServer({ lastActivityAt: null });

      const report = await runAccountMergeDryRun(
        "INVALID_KEY",
        dest.publicKey(),
        30,
        server,
      );

      expect(report.eligible).toBe(false);
      expect(report.checks[0].name).toBe("valid_source_key");
      expect(report.checks[0].passed).toBe(false);
    });

    it("returns eligible=false when source equals destination", async () => {
      const kp = randomKeypair();
      const server = buildMockServer({ lastActivityAt: null });

      const report = await runAccountMergeDryRun(
        kp.publicKey(),
        kp.publicKey(),
        30,
        server,
      );

      expect(report.eligible).toBe(false);
      expect(report.checks.some((c) => c.name === "source_not_destination" && !c.passed)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // runBatchDryRun
  // -------------------------------------------------------------------------

  describe("runBatchDryRun", () => {
    it("processes multiple accounts and returns aggregate result", async () => {
      const source1 = randomKeypair();
      const source2 = randomKeypair();
      const dest = randomKeypair();

      // source1 — eligible
      const s1Account = buildMockAccount(source1);
      // source2 — ineligible (recently active)
      const s2Account = buildMockAccount(source2);

      const server = {
        loadAccount: jest.fn(async (key: string) => {
          if (key === source1.publicKey()) return s1Account;
          if (key === source2.publicKey()) return s2Account;
          if (key === dest.publicKey()) return buildMockAccount(dest);
          throw { response: { status: 404 } };
        }),
        transactions: jest.fn((key?: string) => ({
          forAccount: jest.fn().mockReturnThis(),
          order: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          call: jest.fn().mockResolvedValue({
            records: key === source2.publicKey()
              ? [{ created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() }]
              : [{ created_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString() }],
          }),
        })),
      } as unknown as StellarSdk.Horizon.Server;

      const result = await runBatchDryRun(
        [
          { sourcePublicKey: source1.publicKey(), destinationPublicKey: dest.publicKey() },
          { sourcePublicKey: source2.publicKey(), destinationPublicKey: dest.publicKey() },
        ],
        server,
      );

      expect(result.totalAccounts).toBe(2);
      expect(result.reports).toHaveLength(2);
      expect(typeof result.totalReclaimableXLM).toBe("string");
    });
  });

  // -------------------------------------------------------------------------
  // Merchant review workflow
  // -------------------------------------------------------------------------

  describe("Merchant review workflow", () => {
    function makeDummyReport(sourcePublicKey: string): AccountMergeDryRunReport {
      return {
        sourcePublicKey,
        destinationPublicKey: randomKeypair().publicKey(),
        eligible: true,
        summary: "Account is eligible",
        reclaimableXLM: "9.99999",
        subentryCount: 0,
        trustlines: [],
        signers: [],
        sequenceNumber: "12345",
        lastActivityAt: null,
        checks: [],
        accountFound: true,
        generatedAt: new Date().toISOString(),
      };
    }

    // A row shaped like the one the INSERT ... RETURNING produces.
    const storedRow = (overrides: Record<string, any> = {}) => ({
      id: "11111111-1111-1111-1111-111111111111",
      source_public_key: "GAAAA",
      dry_run_report: {},
      status: "pending",
      review_requested_at: new Date(),
      reviewed_at: null,
      reviewed_by: null,
      review_notes: null,
      reclaimable_xlm: "0",
      ...overrides,
    });

    it("creates a pending review record", async () => {
      const report = makeDummyReport(randomKeypair().publicKey());
      (queryWrite as jest.Mock).mockResolvedValue({
        rows: [storedRow({ dry_run_report: report, source_public_key: report.sourcePublicKey })],
      });

      const record = await submitForMerchantReview(report);

      expect(record.id).toBeDefined();
      expect(record.approved).toBeNull();
      expect(record.reviewedAt).toBeNull();
      // Round-tripped through JSONB, so the parsed report is compared by value.
      expect(record.dryRunReport).toEqual(report);
    });

    it("stores the report as JSON and carries the reclaimable amount for the queue", async () => {
      const report = makeDummyReport(randomKeypair().publicKey());
      (queryWrite as jest.Mock).mockResolvedValue({ rows: [storedRow()] });

      await submitForMerchantReview(report);

      const [sql, params] = (queryWrite as jest.Mock).mock.calls[0];
      expect(sql).toContain("INSERT INTO account_merge_reviews");
      expect(JSON.parse(params[1]).sourcePublicKey).toBe(report.sourcePublicKey);
      // A denormalised column so the pending queue can be sorted by value
      // without parsing JSONB on every read.
      expect(params[3]).toBe(report.reclaimableXLM);
    });

    it("approves a review record", async () => {
      const report = makeDummyReport(randomKeypair().publicKey());
      (queryWrite as jest.Mock)
        .mockResolvedValueOnce({ rows: [storedRow()] })
        .mockResolvedValueOnce({
          rows: [
            storedRow({
              status: "approved",
              reviewed_by: "admin-1",
              review_notes: "Looks good, proceed",
              reviewed_at: new Date(),
            }),
          ],
        });

      const record = await submitForMerchantReview(report);
      const reviewed = await recordMerchantReviewDecision(
        record.id,
        true,
        "admin-1",
        "Looks good, proceed",
      );

      expect(reviewed.approved).toBe(true);
      expect(reviewed.reviewedBy).toBe("admin-1");
      expect(reviewed.reviewNotes).toBe("Looks good, proceed");
      expect(reviewed.reviewedAt).toBeInstanceOf(Date);
    });

    it("rejects a review record", async () => {
      (queryWrite as jest.Mock)
        .mockResolvedValueOnce({ rows: [storedRow()] })
        .mockResolvedValueOnce({
          rows: [storedRow({ status: "rejected", reviewed_by: "admin-2", reviewed_at: new Date() })],
        });

      const record = await submitForMerchantReview(makeDummyReport(randomKeypair().publicKey()));
      const reviewed = await recordMerchantReviewDecision(record.id, false, "admin-2");

      expect(reviewed.approved).toBe(false);
      expect(reviewed.reviewedBy).toBe("admin-2");
    });

    it("decides a review in a single guarded UPDATE", async () => {
      // The 'pending' guard belongs in the WHERE clause, not in JavaScript, or
      // two reviewers deciding at once would both see 'pending' and the second
      // write would silently overwrite the first reviewer.
      (queryWrite as jest.Mock)
        .mockResolvedValueOnce({ rows: [storedRow()] })
        .mockResolvedValueOnce({ rows: [storedRow({ status: "approved" })] });

      const record = await submitForMerchantReview(makeDummyReport(randomKeypair().publicKey()));
      await recordMerchantReviewDecision(record.id, true, "admin-1");

      const [sql] = (queryWrite as jest.Mock).mock.calls[1];
      expect(sql).toContain("UPDATE account_merge_reviews");
      expect(sql).toContain("AND status = 'pending'");
    });

    it("throws when reviewing a non-existent record", async () => {
      (queryWrite as jest.Mock).mockResolvedValue({ rows: [] });
      (queryRead as jest.Mock).mockResolvedValue({ rows: [] });

      await expect(recordMerchantReviewDecision("non-existent-id", true, "admin")).rejects.toThrow(
        "not found",
      );
    });

    it("refuses to overwrite a decision that has already been made", async () => {
      (queryWrite as jest.Mock)
        .mockResolvedValueOnce({ rows: [storedRow()] })
        .mockResolvedValueOnce({ rows: [] });
      (queryRead as jest.Mock).mockResolvedValue({
        rows: [{ status: "approved", reviewed_by: "admin-1", reviewed_at: new Date() }],
      });

      const record = await submitForMerchantReview(makeDummyReport(randomKeypair().publicKey()));

      // A conflict, not a silent overwrite: the second reviewer needs to know
      // that someone else already approved this.
      await expect(
        recordMerchantReviewDecision(record.id, false, "admin-2"),
      ).rejects.toThrow(/already approved by admin-1/);
    });

    it("rejects a second pending review of the same account", async () => {
      (queryWrite as jest.Mock).mockRejectedValue(
        Object.assign(new Error("duplicate key"), { code: "23505" }),
      );

      await expect(
        submitForMerchantReview(makeDummyReport(randomKeypair().publicKey())),
      ).rejects.toThrow(/pending review already exists/);
    });

    it("lets an unrelated database error through unchanged", async () => {
      (queryWrite as jest.Mock).mockRejectedValue(new Error("connection terminated"));

      await expect(
        submitForMerchantReview(makeDummyReport(randomKeypair().publicKey())),
      ).rejects.toThrow("connection terminated");
    });

    it("lists pending reviews", async () => {
      (queryRead as jest.Mock).mockResolvedValue({
        rows: [
          storedRow({ id: "r1", status: "pending" }),
          storedRow({ id: "r2", status: "pending" }),
        ],
      });

      const pending = await getPendingMerchantReviews();
      expect(pending.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
      expect(pending.every((r) => r.approved === null)).toBe(true);
    });

    it("only ever queries for pending reviews, newest first", async () => {
      (queryRead as jest.Mock).mockResolvedValue({ rows: [] });

      await getPendingMerchantReviews();

      const [sql] = (queryRead as jest.Mock).mock.calls[0];
      expect(sql).toContain("WHERE status = 'pending'");
      expect(sql).toContain("ORDER BY review_requested_at DESC");
    });

    it("retrieves a review record by ID", async () => {
      (queryRead as jest.Mock).mockResolvedValue({ rows: [storedRow({ id: "r1" })] });

      const fetched = await getMerchantReviewRecord("r1");
      expect(fetched).toBeDefined();
      expect(fetched?.id).toBe("r1");
    });

    it("returns undefined for unknown review ID", async () => {
      (queryRead as jest.Mock).mockResolvedValue({ rows: [] });

      expect(await getMerchantReviewRecord("unknown")).toBeUndefined();
    });

    it("refuses a decision on a review that has expired", async () => {
      // The UPDATE guards on status, but a review can be pending AND stale if
      // nobody has run the sweep. This is what stops an approval of week-old
      // numbers from going through.
      (queryRead as jest.Mock).mockResolvedValue({
        rows: [{ review_requested_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) }],
      });

      await expect(assertReviewIsFresh("r1")).rejects.toThrow(/must be re-run/);
    });

    it("accepts a decision on a review inside its TTL", async () => {
      (queryRead as jest.Mock).mockResolvedValue({
        rows: [{ review_requested_at: new Date(Date.now() - 60 * 60 * 1000) }],
      });

      await expect(assertReviewIsFresh("r1")).resolves.toBeUndefined();
    });

    it("expires stale reviews without deleting them", async () => {
      (queryWrite as jest.Mock).mockResolvedValue({ rows: [{ id: "r1" }, { id: "r2" }] });

      const count = await expireStaleMerchantReviews(7);

      expect(count).toBe(2);
      const [sql] = (queryWrite as jest.Mock).mock.calls[0];
      expect(sql).toContain("SET status = 'expired'");
      expect(sql).toContain("AND status = 'pending'");
      // An expired review is still the record of a review that went stale,
      // which is not the same as a review that was never made.
      expect(sql).not.toContain("DELETE");
    });
  });
});
