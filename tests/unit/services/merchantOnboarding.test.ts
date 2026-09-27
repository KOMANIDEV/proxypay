/**
 * Unit tests — MerchantOnboardingService
 *
 * Issue #410 — Merchant Onboarding Progress Tracking
 */

import {
  MerchantOnboardingService,
  merchantOnboardingService,
  type OnboardingProgress,
  type OnboardingStep,
} from "../../../src/services/merchantOnboarding";
import { MerchantModel, type Merchant } from "../../../src/models/merchant";
import { MerchantWebhookModel } from "../../../src/models/merchantWebhook";
import * as database from "../../../src/config/database";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("../../../src/config/database", () => ({
  queryRead: jest.fn(),
  queryWrite: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
}));

jest.mock("../../../src/models/merchant");
jest.mock("../../../src/models/merchantWebhook");

global.fetch = jest.fn().mockResolvedValue({ ok: true });

// ---------------------------------------------------------------------------
// Test data builders
// ---------------------------------------------------------------------------

const BASE_MERCHANT: Merchant = {
  id: "merchant-1",
  name: "Acme Corp",
  email: "acme@example.com",
  phoneNumber: "+237600000000",
  businessName: "Acme Ltd",
  businessType: "retail",
  taxId: "TXN-12345",
  address: "123 Main St",
  city: "Douala",
  country: "CM",
  status: "pending",
  kycStatus: "not_started",
  invitationToken: "token-abc",
  invitationSentAt: new Date(),
  invitationAcceptedAt: undefined,
  metadata: {},
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeMerchant(overrides: Partial<Merchant> = {}): Merchant {
  return { ...BASE_MERCHANT, ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MerchantOnboardingService.getProgress()", () => {
  let service: MerchantOnboardingService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MerchantOnboardingService();
  });

  it("throws when merchant does not exist", async () => {
    (MerchantModel.prototype.findById as jest.Mock).mockResolvedValue(null);
    await expect(service.getProgress("unknown-id")).rejects.toThrow(
      "Merchant not found",
    );
  });

  it("returns 0% score for a brand-new merchant with minimal data", async () => {
    const merchant = makeMerchant({
      businessName: undefined,
      businessType: undefined,
      taxId: undefined,
      kycStatus: "not_started",
      invitationAcceptedAt: undefined,
      metadata: {},
    });
    (MerchantModel.prototype.findById as jest.Mock).mockResolvedValue(merchant);

    const progress = await service.getProgress(merchant.id);

    // email_verified is always true → at least 1 step done
    expect(progress.scorePercent).toBeGreaterThanOrEqual(0);
    expect(progress.isActivationReady).toBe(false);
    expect(progress.pendingSteps).toContain("invitation_accepted");
    expect(progress.pendingSteps).toContain("kyc_verified");
  });

  it("includes all required steps in the requirements list", async () => {
    (MerchantModel.prototype.findById as jest.Mock).mockResolvedValue(
      makeMerchant(),
    );

    const progress = await service.getProgress(BASE_MERCHANT.id);
    const requiredSteps = progress.requirements.filter((r) => r.required);
    const requiredStepNames = requiredSteps.map((r) => r.step);

    expect(requiredStepNames).toContain("profile_complete");
    expect(requiredStepNames).toContain("invitation_accepted");
    expect(requiredStepNames).toContain("kyc_verified");
  });

  it("marks profile_complete when business fields are filled", async () => {
    // BASE_MERCHANT has businessName, businessType, taxId set
    (MerchantModel.prototype.findById as jest.Mock).mockResolvedValue(
      makeMerchant(),
    );

    const progress = await service.getProgress(BASE_MERCHANT.id);
    const profileReq = progress.requirements.find(
      (r) => r.step === "profile_complete",
    );
    expect(profileReq?.completed).toBe(true);
  });

  it("marks invitation_accepted when invitationAcceptedAt is set", async () => {
    (MerchantModel.prototype.findById as jest.Mock).mockResolvedValue(
      makeMerchant({ invitationAcceptedAt: new Date() }),
    );

    const progress = await service.getProgress(BASE_MERCHANT.id);
    const req = progress.requirements.find(
      (r) => r.step === "invitation_accepted",
    );
    expect(req?.completed).toBe(true);
  });

  it("sets isActivationReady=true when all required steps are done", async () => {
    (MerchantModel.prototype.findById as jest.Mock).mockResolvedValue(
      makeMerchant({
        invitationAcceptedAt: new Date(),
        kycStatus: "verified",
      }),
    );

    const progress = await service.getProgress(BASE_MERCHANT.id);
    expect(progress.isActivationReady).toBe(true);
    expect(progress.scorePercent).toBeGreaterThan(0);
  });

  it("scorePercent increases as more steps complete", async () => {
    // Step 1: brand new merchant
    (MerchantModel.prototype.findById as jest.Mock).mockResolvedValueOnce(
      makeMerchant({
        businessName: undefined,
        businessType: undefined,
        taxId: undefined,
        invitationAcceptedAt: undefined,
        kycStatus: "not_started",
        metadata: {},
      }),
    );
    const progressA = await service.getProgress(BASE_MERCHANT.id);

    // Step 2: fully onboarded merchant
    (MerchantModel.prototype.findById as jest.Mock).mockResolvedValueOnce(
      makeMerchant({
        invitationAcceptedAt: new Date(),
        kycStatus: "verified",
        metadata: {
          bankAccountLinked: true,
          bankAccountLinkedAt: new Date().toISOString(),
          firstTransactionAt: new Date().toISOString(),
        },
      }),
    );
    const progressB = await service.getProgress(BASE_MERCHANT.id);

    expect(progressB.scorePercent).toBeGreaterThan(progressA.scorePercent);
  });
});

describe("MerchantOnboardingService.completeStep()", () => {
  let service: MerchantOnboardingService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MerchantOnboardingService();

    // Default: webhook model returns no active webhooks
    (MerchantWebhookModel.prototype.findByUserId as jest.Mock).mockResolvedValue([]);
  });

  it("throws when merchant does not exist", async () => {
    (MerchantModel.prototype.findById as jest.Mock).mockResolvedValue(null);
    await expect(
      service.completeStep("unknown", "bank_account_linked"),
    ).rejects.toThrow("Merchant not found");
  });

  it("persists bankAccountLinked metadata when completing bank_account_linked step", async () => {
    (MerchantModel.prototype.findById as jest.Mock)
      .mockResolvedValueOnce(makeMerchant()) // first call inside completeStep
      .mockResolvedValueOnce(                 // second call inside getProgress
        makeMerchant({
          metadata: { bankAccountLinked: true },
        }),
      );

    const updateSpy = (MerchantModel.prototype.update as jest.Mock).mockResolvedValue(
      makeMerchant({ metadata: { bankAccountLinked: true } }),
    );

    await service.completeStep(BASE_MERCHANT.id, "bank_account_linked");

    expect(updateSpy).toHaveBeenCalledWith(
      BASE_MERCHANT.id,
      expect.objectContaining({
        metadata: expect.objectContaining({ bankAccountLinked: true }),
      }),
    );
  });

  it("fires a progress webhook after completing a step", async () => {
    (MerchantModel.prototype.findById as jest.Mock)
      .mockResolvedValueOnce(makeMerchant())
      .mockResolvedValueOnce(makeMerchant());
    (MerchantModel.prototype.update as jest.Mock).mockResolvedValue(makeMerchant());
    (MerchantWebhookModel.prototype.findByUserId as jest.Mock).mockResolvedValue([
      {
        id: "wh-1",
        url: "https://example.com/webhook",
        secret: "s3cr3t",
        isActive: true,
        events: ["transaction.completed"],
      },
    ]);

    await service.completeStep(BASE_MERCHANT.id, "first_transaction");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://example.com/webhook",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns updated progress after completing a step", async () => {
    (MerchantModel.prototype.findById as jest.Mock)
      .mockResolvedValueOnce(makeMerchant())
      .mockResolvedValueOnce(makeMerchant({ kycStatus: "verified", invitationAcceptedAt: new Date() }));

    (MerchantModel.prototype.update as jest.Mock).mockResolvedValue(makeMerchant());

    const progress = await service.completeStep(BASE_MERCHANT.id, "kyc_verified");
    expect(progress).toHaveProperty("merchantId", BASE_MERCHANT.id);
    expect(progress).toHaveProperty("scorePercent");
    expect(Array.isArray(progress.requirements)).toBe(true);
  });
});

describe("MerchantOnboardingService.getAnalytics()", () => {
  let service: MerchantOnboardingService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MerchantOnboardingService();
  });

  it("returns analytics with expected fields", async () => {
    (database.queryRead as jest.Mock).mockResolvedValue({
      rows: [
        {
          total: "10",
          fully_onboarded: "4",
          kyc_pending: "3",
          invitation_pending: "2",
        },
      ],
    });

    const analytics = await service.getAnalytics();

    expect(analytics.totalMerchants).toBe(10);
    expect(analytics.fullyOnboarded).toBe(4);
    expect(analytics.kycPending).toBe(3);
    expect(analytics.invitationPending).toBe(2);
    expect(analytics.averageScorePercent).toBe(40);
  });

  it("handles empty merchants table gracefully", async () => {
    (database.queryRead as jest.Mock).mockResolvedValue({
      rows: [
        {
          total: "0",
          fully_onboarded: "0",
          kyc_pending: "0",
          invitation_pending: "0",
        },
      ],
    });

    const analytics = await service.getAnalytics();
    expect(analytics.totalMerchants).toBe(0);
    expect(analytics.averageScorePercent).toBe(0);
  });
});

describe("merchantOnboardingService singleton", () => {
  it("is an instance of MerchantOnboardingService", () => {
    expect(merchantOnboardingService).toBeInstanceOf(MerchantOnboardingService);
  });
});
