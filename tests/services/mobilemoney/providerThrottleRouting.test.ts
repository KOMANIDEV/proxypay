const enqueueProviderCall = jest.fn();

jest.mock("../../../src/services/mobilemoney/providerThrottle", () => ({
  enqueueProviderCall,
}));

jest.mock("../../../src/services/mobilemoney/mobileMoneyService_impl.js", () => {
  class BaseMobileMoneyService {
    constructor(public providers?: Map<string, unknown>) {}

    initiatePayment() {
      return Promise.resolve({ provider: "base" });
    }

    sendPayout() {
      return Promise.resolve({ provider: "base" });
    }

    sendBatchPayout() {
      return Promise.resolve({ provider: "base" });
    }
  }

  return { MobileMoneyService: BaseMobileMoneyService };
});

import { MobileMoneyService } from "../../../src/services/mobilemoney/mobileMoneyService";

describe("MobileMoneyService provider throttling", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "production";
    enqueueProviderCall.mockReset();
    enqueueProviderCall.mockResolvedValue({ success: true });
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("queues MTN payments", async () => {
    const service = new MobileMoneyService();

    await service.initiatePayment("mtn", "+237670000000", "10");

    expect(enqueueProviderCall).toHaveBeenCalledWith({
      operation: "payment",
      provider: "mtn",
      phoneNumber: "+237670000000",
      amount: "10",
    });
  });

  it("queues Airtel payouts and batch payouts", async () => {
    const service = new MobileMoneyService();

    await service.sendPayout("airtel", "+254700000000", "20");
    await service.sendBatchPayout("airtel", [
      { referenceId: "ref-1", phoneNumber: "+254700000000", amount: "20" },
    ]);

    expect(enqueueProviderCall).toHaveBeenNthCalledWith(1, {
      operation: "payout",
      provider: "airtel",
      phoneNumber: "+254700000000",
      amount: "20",
    });
    expect(enqueueProviderCall).toHaveBeenNthCalledWith(2, {
      operation: "batchPayout",
      provider: "airtel",
      items: [
        { referenceId: "ref-1", phoneNumber: "+254700000000", amount: "20" },
      ],
    });
  });

  it("does not queue injected providers or non-MTN/Airtel providers", async () => {
    const injected = new Map<string, unknown>();
    const injectedService = new MobileMoneyService(injected as never);
    const orangeService = new MobileMoneyService();

    await injectedService.initiatePayment("mtn", "+237670000000", "10");
    await orangeService.sendPayout("orange", "+237670000000", "10");

    expect(enqueueProviderCall).not.toHaveBeenCalled();
  });
});
