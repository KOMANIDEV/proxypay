import axios from "axios";
import {
  CurrencyService,
  SUPPORTED_CURRENCIES,
  BASE_CURRENCY,
  type SupportedCurrency,
} from "../../src/services/currency";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApiResponse(rates: Record<string, number>): {
  data: object;
  status: number;
} {
  return {
    status: 200,
    data: {
      result: "success",
      base_code: "USD",
      conversion_rates: rates,
    },
  };
}

const MOCK_RATES: Record<string, number> = {
  USD: 1,
  XAF: 600,
  NGN: 1550,
  KES: 130,
  GHS: 15,
  TZS: 2600,
  ZMW: 27,
  RWF: 1320,
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("CurrencyService", () => {
  let service: CurrencyService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CurrencyService();
  });

  afterEach(() => {
    service.shutdown();
  });

  // -------------------------------------------------------------------------
  // Supported currencies
  // -------------------------------------------------------------------------

  describe("isSupportedCurrency", () => {
    it("returns true for all declared supported currencies", () => {
      for (const currency of SUPPORTED_CURRENCIES) {
        expect(service.isSupportedCurrency(currency)).toBe(true);
      }
    });

    it("returns false for unsupported currencies", () => {
      expect(service.isSupportedCurrency("EUR")).toBe(false);
      expect(service.isSupportedCurrency("JPY")).toBe(false);
      expect(service.isSupportedCurrency("")).toBe(false);
      expect(service.isSupportedCurrency("INVALID")).toBe(false);
    });

    it("covers required African currencies", () => {
      const required: SupportedCurrency[] = ["XAF", "NGN", "KES"];
      for (const c of required) {
        expect(service.isSupportedCurrency(c)).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // initialize() — successful API fetch
  // -------------------------------------------------------------------------

  describe("initialize() with valid API key", () => {
    beforeEach(() => {
      process.env.EXCHANGE_RATE_API_KEY = "test-key-123";
    });

    afterEach(() => {
      delete process.env.EXCHANGE_RATE_API_KEY;
    });

    it("fetches rates from exchangerate-api.com on startup", async () => {
      mockedAxios.get.mockResolvedValueOnce(makeApiResponse(MOCK_RATES));

      await service.initialize();

      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining("test-key-123"),
        expect.objectContaining({ timeout: expect.any(Number) }),
      );
      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining(`/latest/${BASE_CURRENCY}`),
        expect.any(Object),
      );
    });

    it("marks cache as populated and not stale after successful fetch", async () => {
      mockedAxios.get.mockResolvedValueOnce(makeApiResponse(MOCK_RATES));

      await service.initialize();

      const status = service.getStatus();
      expect(status.cachePopulated).toBe(true);
      expect(status.isStale).toBe(false);
      expect(status.usingFallback).toBe(false);
      expect(status.lastUpdated).toBeInstanceOf(Date);
    });

    it("stores all supported currencies in the cache", async () => {
      mockedAxios.get.mockResolvedValueOnce(makeApiResponse(MOCK_RATES));

      await service.initialize();

      const rates = service.getRates();
      for (const currency of SUPPORTED_CURRENCIES) {
        expect(rates[currency]).toBeGreaterThan(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // initialize() — missing API key (fallback)
  // -------------------------------------------------------------------------

  describe("initialize() without API key", () => {
    beforeEach(() => {
      delete process.env.EXCHANGE_RATE_API_KEY;
    });

    it("uses fallback rates when EXCHANGE_RATE_API_KEY is not set", async () => {
      await service.initialize();

      expect(mockedAxios.get).not.toHaveBeenCalled();

      const status = service.getStatus();
      expect(status.usingFallback).toBe(true);
      expect(status.cachePopulated).toBe(true);
    });

    it("fallback rates cover all supported currencies", async () => {
      await service.initialize();

      const rates = service.getRates();
      for (const currency of SUPPORTED_CURRENCIES) {
        expect(typeof rates[currency]).toBe("number");
        expect(rates[currency]).toBeGreaterThan(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // initialize() — API failure / graceful degradation
  // -------------------------------------------------------------------------

  describe("initialize() — API failures handled gracefully", () => {
    beforeEach(() => {
      process.env.EXCHANGE_RATE_API_KEY = "test-key-123";
    });

    afterEach(() => {
      delete process.env.EXCHANGE_RATE_API_KEY;
    });

    it("falls back to static rates when API request fails on first load", async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error("Network error"));

      await service.initialize();

      const status = service.getStatus();
      expect(status.usingFallback).toBe(true);
      expect(status.cachePopulated).toBe(true);
    });

    it("retains stale cached rates when a refresh fails", async () => {
      // First call succeeds
      mockedAxios.get.mockResolvedValueOnce(makeApiResponse(MOCK_RATES));
      await service.initialize();

      // Second call fails
      mockedAxios.get.mockRejectedValueOnce(new Error("Timeout"));
      // Directly invoke the private method via any-cast (integration test need)
      await (
        service as unknown as { fetchRates: () => Promise<void> }
      ).fetchRates();

      const status = service.getStatus();
      // Cache should still be populated from the first successful fetch
      expect(status.cachePopulated).toBe(true);
      expect(status.rates[BASE_CURRENCY]).toBe(1);
    });

    it("handles API error-type response gracefully", async () => {
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: { result: "error", "error-type": "invalid-key" },
      });

      await service.initialize();

      const status = service.getStatus();
      expect(status.usingFallback).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // convert()
  // -------------------------------------------------------------------------

  describe("convert()", () => {
    beforeEach(async () => {
      process.env.EXCHANGE_RATE_API_KEY = "test-key-123";
      mockedAxios.get.mockResolvedValueOnce(makeApiResponse(MOCK_RATES));
      await service.initialize();
    });

    afterEach(() => {
      delete process.env.EXCHANGE_RATE_API_KEY;
    });

    it("returns 1:1 when converting a currency to itself", () => {
      const result = service.convert(100, "USD", "USD");
      expect(result.convertedAmount).toBe(100);
      expect(result.rate).toBe(1);
    });

    it("converts USD to XAF correctly", () => {
      const result = service.convert(1, "USD", "XAF");
      expect(result.convertedAmount).toBe(600);
      expect(result.originalCurrency).toBe("USD");
      expect(result.baseCurrency).toBe("XAF");
    });

    it("converts XAF to USD correctly", () => {
      const result = service.convert(600, "XAF", "USD");
      expect(result.convertedAmount).toBeCloseTo(1, 5);
      expect(result.originalAmount).toBe(600);
      expect(result.originalCurrency).toBe("XAF");
    });

    it("converts NGN to KES correctly", () => {
      // 1550 NGN = 1 USD = 130 KES  →  1 NGN ≈ 0.08387 KES
      const result = service.convert(1550, "NGN", "KES");
      expect(result.convertedAmount).toBeCloseTo(130, 4);
    });

    it("converts zero amount to zero", () => {
      const result = service.convert(0, "KES", "USD");
      expect(result.convertedAmount).toBe(0);
    });

    it("throws for negative amounts", () => {
      expect(() => service.convert(-1, "USD", "NGN")).toThrow(
        "Amount must be non-negative",
      );
    });

    it("throws when a currency has no rate", () => {
      expect(() =>
        service.convert(100, "USD", "EUR" as SupportedCurrency),
      ).toThrow("No exchange rate available for EUR");
    });

    it("includes the computed rate in the result", () => {
      const result = service.convert(100, "USD", "NGN");
      // rate should be ~1550
      expect(result.rate).toBeCloseTo(1550, 0);
    });
  });

  // -------------------------------------------------------------------------
  // convertToBase()
  // -------------------------------------------------------------------------

  describe("convertToBase()", () => {
    beforeEach(async () => {
      process.env.EXCHANGE_RATE_API_KEY = "test-key-123";
      mockedAxios.get.mockResolvedValueOnce(makeApiResponse(MOCK_RATES));
      await service.initialize();
    });

    afterEach(() => {
      delete process.env.EXCHANGE_RATE_API_KEY;
    });

    it("converts XAF to USD as base", () => {
      const result = service.convertToBase(6000, "XAF");
      expect(result.baseCurrency).toBe("USD");
      expect(result.convertedAmount).toBeCloseTo(10, 4);
    });

    it("converts NGN to USD as base", () => {
      const result = service.convertToBase(15500, "NGN");
      expect(result.convertedAmount).toBeCloseTo(10, 4);
    });

    it("is a no-op when currency is already USD", () => {
      const result = service.convertToBase(50, "USD");
      expect(result.convertedAmount).toBe(50);
      expect(result.rate).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // getStatus()
  // -------------------------------------------------------------------------

  describe("getStatus()", () => {
    it("reports cache as unpopulated before initialize()", () => {
      const status = service.getStatus();
      // Before initialize, cache is null so getRates() returns fallback
      expect(status.cachePopulated).toBe(false);
      expect(status.isStale).toBe(true);
      expect(status.lastUpdated).toBeNull();
    });

    it("reports correct status after successful API fetch", async () => {
      process.env.EXCHANGE_RATE_API_KEY = "test-key-123";
      mockedAxios.get.mockResolvedValueOnce(makeApiResponse(MOCK_RATES));
      await service.initialize();

      const status = service.getStatus();
      expect(status.cachePopulated).toBe(true);
      expect(status.usingFallback).toBe(false);
      expect(status.lastUpdated).toBeInstanceOf(Date);

      delete process.env.EXCHANGE_RATE_API_KEY;
    });
  });

  // -------------------------------------------------------------------------
  // shutdown()
  // -------------------------------------------------------------------------

  describe("shutdown()", () => {
    it("clears the refresh timer without throwing", async () => {
      process.env.EXCHANGE_RATE_API_KEY = "test-key-123";
      mockedAxios.get.mockResolvedValueOnce(makeApiResponse(MOCK_RATES));
      await service.initialize();

      expect(() => service.shutdown()).not.toThrow();

      delete process.env.EXCHANGE_RATE_API_KEY;
    });

    it("can be called multiple times safely", () => {
      expect(() => {
        service.shutdown();
        service.shutdown();
      }).not.toThrow();
    });
  });
});
