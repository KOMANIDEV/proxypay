import {
  runProviderSessionRefreshJob,
  _setAirtelInstance,
  _setOrangeInstance,
} from "../../jobs/providerSessionRefreshJob";
import { AirtelService } from "../../services/mobilemoney/providers/airtel";
import { OrangeProvider } from "../../services/mobilemoney/providers/orange";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ONE_HOUR_MS = 60 * 60 * 1000;
const FIVE_MIN_MS = 5 * 60 * 1000;

/** Creates a partial mock with overridable return values. */
function makeAirtelMock(overrides: {
  sessionInfo?: { expiresAt: number } | null;
  refreshResult?: {
    success: boolean;
    reloggedIn?: boolean;
    error?: unknown;
  };
  refreshError?: Error;
}): jest.Mocked<
  Pick<AirtelService, "getSessionInfo" | "proactivelyRefreshSession">
> & Record<string, unknown> {
  return {
    getSessionInfo: jest.fn().mockReturnValue(
      overrides.sessionInfo !== undefined ? overrides.sessionInfo : null,
    ),
    proactivelyRefreshSession: overrides.refreshError
      ? jest.fn().mockRejectedValue(overrides.refreshError)
      : jest.fn().mockResolvedValue(
          overrides.refreshResult ?? { success: true, reloggedIn: false },
        ),
  };
}

function makeOrangeMock(overrides: {
  sessionInfo?: { expiresAt: number } | null;
  refreshResult?: {
    success: boolean;
    reloggedIn?: boolean;
    error?: unknown;
  };
  refreshError?: Error;
}): jest.Mocked<
  Pick<OrangeProvider, "getSessionInfo" | "proactivelyRefreshSession">
> & Record<string, unknown> {
  return {
    getSessionInfo: jest.fn().mockReturnValue(
      overrides.sessionInfo !== undefined ? overrides.sessionInfo : null,
    ),
    proactivelyRefreshSession: overrides.refreshError
      ? jest.fn().mockRejectedValue(overrides.refreshError)
      : jest.fn().mockResolvedValue(
          overrides.refreshResult ?? { success: true, reloggedIn: false },
        ),
  };
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  _setAirtelInstance(null);
  _setOrangeInstance(null);
  jest.useRealTimers();
  jest.clearAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("runProviderSessionRefreshJob", () => {
  describe("skip logic", () => {
    it("skips Airtel when getSessionInfo returns null (not in web mode)", async () => {
      const airtel = makeAirtelMock({ sessionInfo: null });
      const orange = makeOrangeMock({ sessionInfo: null });

      _setAirtelInstance(airtel as unknown as AirtelService);
      _setOrangeInstance(orange as unknown as OrangeProvider);

      const result = await runProviderSessionRefreshJob();

      expect(result.outcomes).toHaveLength(2);
      const airtelOutcome = result.outcomes.find((o) => o.provider === "airtel")!;
      expect(airtelOutcome.skipped).toBe(true);
      expect(airtelOutcome.refreshed).toBe(false);
      expect(airtelOutcome.attempts).toBe(0);
      expect(airtel.proactivelyRefreshSession).not.toHaveBeenCalled();
    });

    it("skips Orange when getSessionInfo returns null (not in web mode)", async () => {
      const airtel = makeAirtelMock({ sessionInfo: null });
      const orange = makeOrangeMock({ sessionInfo: null });

      _setAirtelInstance(airtel as unknown as AirtelService);
      _setOrangeInstance(orange as unknown as OrangeProvider);

      const result = await runProviderSessionRefreshJob();

      const orangeOutcome = result.outcomes.find((o) => o.provider === "orange")!;
      expect(orangeOutcome.skipped).toBe(true);
      expect(orange.proactivelyRefreshSession).not.toHaveBeenCalled();
    });

    it("skips refresh when session has more than 1 hour remaining", async () => {
      const expiresAt = Date.now() + ONE_HOUR_MS + FIVE_MIN_MS; // 65 mins left
      const airtel = makeAirtelMock({ sessionInfo: { expiresAt } });
      const orange = makeOrangeMock({ sessionInfo: null });

      _setAirtelInstance(airtel as unknown as AirtelService);
      _setOrangeInstance(orange as unknown as OrangeProvider);

      const result = await runProviderSessionRefreshJob();

      const airtelOutcome = result.outcomes.find((o) => o.provider === "airtel")!;
      expect(airtelOutcome.skipped).toBe(true);
      expect(airtelOutcome.refreshed).toBe(false);
      expect(airtel.proactivelyRefreshSession).not.toHaveBeenCalled();
    });
  });

  describe("proactive refresh — success paths", () => {
    it("refreshes Airtel when session is within 1 hour of expiry", async () => {
      const expiresAt = Date.now() + ONE_HOUR_MS - FIVE_MIN_MS; // 55 mins left
      const airtel = makeAirtelMock({
        sessionInfo: { expiresAt },
        refreshResult: { success: true, reloggedIn: false },
      });
      const orange = makeOrangeMock({ sessionInfo: null });

      _setAirtelInstance(airtel as unknown as AirtelService);
      _setOrangeInstance(orange as unknown as OrangeProvider);

      const result = await runProviderSessionRefreshJob();

      const airtelOutcome = result.outcomes.find((o) => o.provider === "airtel")!;
      expect(airtelOutcome.skipped).toBe(false);
      expect(airtelOutcome.refreshed).toBe(true);
      expect(airtelOutcome.reloggedIn).toBe(false);
      expect(airtelOutcome.attempts).toBe(1);
      expect(airtel.proactivelyRefreshSession).toHaveBeenCalledTimes(1);
    });

    it("refreshes Orange when session is about to expire (< 10 minutes)", async () => {
      const expiresAt = Date.now() + 8 * 60 * 1000; // 8 minutes left
      const orange = makeOrangeMock({
        sessionInfo: { expiresAt },
        refreshResult: { success: true, reloggedIn: false },
      });
      const airtel = makeAirtelMock({ sessionInfo: null });

      _setAirtelInstance(airtel as unknown as AirtelService);
      _setOrangeInstance(orange as unknown as OrangeProvider);

      const result = await runProviderSessionRefreshJob();

      const orangeOutcome = result.outcomes.find((o) => o.provider === "orange")!;
      expect(orangeOutcome.refreshed).toBe(true);
      expect(orangeOutcome.skipped).toBe(false);
      expect(orange.proactivelyRefreshSession).toHaveBeenCalledTimes(1);
    });

    it("records reloggedIn=true when provider performed a full re-login", async () => {
      const expiresAt = Date.now() + 30 * 60 * 1000; // 30 minutes left
      const airtel = makeAirtelMock({
        sessionInfo: { expiresAt },
        refreshResult: { success: true, reloggedIn: true },
      });
      const orange = makeOrangeMock({ sessionInfo: null });

      _setAirtelInstance(airtel as unknown as AirtelService);
      _setOrangeInstance(orange as unknown as OrangeProvider);

      const result = await runProviderSessionRefreshJob();

      const airtelOutcome = result.outcomes.find((o) => o.provider === "airtel")!;
      expect(airtelOutcome.refreshed).toBe(true);
      expect(airtelOutcome.reloggedIn).toBe(true);
    });

    it("processes both providers concurrently and returns outcomes for both", async () => {
      const now = Date.now();
      const airtel = makeAirtelMock({
        sessionInfo: { expiresAt: now + 30 * 60 * 1000 },
        refreshResult: { success: true, reloggedIn: false },
      });
      const orange = makeOrangeMock({
        sessionInfo: { expiresAt: now + 20 * 60 * 1000 },
        refreshResult: { success: true, reloggedIn: false },
      });

      _setAirtelInstance(airtel as unknown as AirtelService);
      _setOrangeInstance(orange as unknown as OrangeProvider);

      const result = await runProviderSessionRefreshJob();

      expect(result.outcomes).toHaveLength(2);
      expect(result.outcomes.every((o) => o.refreshed)).toBe(true);
      expect(airtel.proactivelyRefreshSession).toHaveBeenCalledTimes(1);
      expect(orange.proactivelyRefreshSession).toHaveBeenCalledTimes(1);
    });

    it("returns a checkedAt ISO timestamp", async () => {
      _setAirtelInstance(makeAirtelMock({ sessionInfo: null }) as unknown as AirtelService);
      _setOrangeInstance(makeOrangeMock({ sessionInfo: null }) as unknown as OrangeProvider);

      const result = await runProviderSessionRefreshJob();

      expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(() => new Date(result.checkedAt)).not.toThrow();
    });
  });

  describe("retry logic", () => {
    it("retries on failure and succeeds on the second attempt", async () => {
      jest.useRealTimers(); // real timers needed so back-off delays resolve

      const expiresAt = Date.now() + 30 * 60 * 1000;
      const refreshFn = jest
        .fn()
        .mockResolvedValueOnce({ success: false, error: new Error("temporary failure") })
        .mockResolvedValueOnce({ success: true, reloggedIn: false });

      const airtel = {
        getSessionInfo: jest.fn().mockReturnValue({ expiresAt }),
        proactivelyRefreshSession: refreshFn,
      };
      const orange = makeOrangeMock({ sessionInfo: null });

      _setAirtelInstance(airtel as unknown as AirtelService);
      _setOrangeInstance(orange as unknown as OrangeProvider);

      const result = await runProviderSessionRefreshJob();

      const airtelOutcome = result.outcomes.find((o) => o.provider === "airtel")!;
      expect(airtelOutcome.refreshed).toBe(true);
      expect(airtelOutcome.attempts).toBe(2);
      expect(refreshFn).toHaveBeenCalledTimes(2);
    }, 20_000);

    it("retries on thrown exception and succeeds on the second attempt", async () => {
      jest.useRealTimers();

      const expiresAt = Date.now() + 30 * 60 * 1000;
      const refreshFn = jest
        .fn()
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValueOnce({ success: true, reloggedIn: true });

      const airtel = {
        getSessionInfo: jest.fn().mockReturnValue({ expiresAt }),
        proactivelyRefreshSession: refreshFn,
      };
      const orange = makeOrangeMock({ sessionInfo: null });

      _setAirtelInstance(airtel as unknown as AirtelService);
      _setOrangeInstance(orange as unknown as OrangeProvider);

      const result = await runProviderSessionRefreshJob();

      const airtelOutcome = result.outcomes.find((o) => o.provider === "airtel")!;
      expect(airtelOutcome.refreshed).toBe(true);
      expect(airtelOutcome.reloggedIn).toBe(true);
      expect(airtelOutcome.attempts).toBe(2);
    }, 20_000);

    it("marks outcome as failed after all attempts are exhausted", async () => {
      jest.useRealTimers();

      const expiresAt = Date.now() + 30 * 60 * 1000;
      const persistentError = new Error("persistent auth failure");
      const refreshFn = jest.fn().mockRejectedValue(persistentError);

      const airtel = {
        getSessionInfo: jest.fn().mockReturnValue({ expiresAt }),
        proactivelyRefreshSession: refreshFn,
      };
      const orange = makeOrangeMock({ sessionInfo: null });

      _setAirtelInstance(airtel as unknown as AirtelService);
      _setOrangeInstance(orange as unknown as OrangeProvider);

      const result = await runProviderSessionRefreshJob();

      const airtelOutcome = result.outcomes.find((o) => o.provider === "airtel")!;
      expect(airtelOutcome.refreshed).toBe(false);
      expect(airtelOutcome.skipped).toBe(false);
      expect(airtelOutcome.error).toBe(persistentError);
      // Default MAX_REFRESH_ATTEMPTS is 3
      expect(airtelOutcome.attempts).toBe(3);
      expect(refreshFn).toHaveBeenCalledTimes(3);
    }, 60_000);

    it("does not let one provider failure block the other provider", async () => {
      jest.useRealTimers();

      const now = Date.now();
      const airtel = {
        getSessionInfo: jest.fn().mockReturnValue({ expiresAt: now + 30 * 60 * 1000 }),
        proactivelyRefreshSession: jest.fn().mockRejectedValue(new Error("airtel down")),
      };
      const orange = {
        getSessionInfo: jest.fn().mockReturnValue({ expiresAt: now + 20 * 60 * 1000 }),
        proactivelyRefreshSession: jest.fn().mockResolvedValue({ success: true }),
      };

      _setAirtelInstance(airtel as unknown as AirtelService);
      _setOrangeInstance(orange as unknown as OrangeProvider);

      const result = await runProviderSessionRefreshJob();

      const airtelOutcome = result.outcomes.find((o) => o.provider === "airtel")!;
      const orangeOutcome = result.outcomes.find((o) => o.provider === "orange")!;

      expect(airtelOutcome.refreshed).toBe(false);
      expect(orangeOutcome.refreshed).toBe(true);
    }, 60_000);
  });

  describe("fallback to re-login", () => {
    it("reflects reloggedIn=true when proactivelyRefreshSession falls back to login", async () => {
      const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes left
      const orange = makeOrangeMock({
        sessionInfo: { expiresAt },
        // Provider internally fell back to re-login
        refreshResult: { success: true, reloggedIn: true },
      });
      const airtel = makeAirtelMock({ sessionInfo: null });

      _setAirtelInstance(airtel as unknown as AirtelService);
      _setOrangeInstance(orange as unknown as OrangeProvider);

      const result = await runProviderSessionRefreshJob();

      const orangeOutcome = result.outcomes.find((o) => o.provider === "orange")!;
      expect(orangeOutcome.refreshed).toBe(true);
      expect(orangeOutcome.reloggedIn).toBe(true);
    });
  });
});

// ─── AirtelService.proactivelyRefreshSession unit tests ───────────────────────

describe("AirtelService.proactivelyRefreshSession", () => {
  it("returns success:true and skips refresh when mode is not web", async () => {
    // Direct mode — no web session involved.
    const service = new AirtelService({ mode: "direct" });
    const result = await service.proactivelyRefreshSession();
    expect(result.success).toBe(true);
    expect(result.reloggedIn).toBeUndefined();
  });
});

// ─── OrangeProvider.proactivelyRefreshSession unit tests ──────────────────────

describe("OrangeProvider.proactivelyRefreshSession", () => {
  it("returns success:true and skips refresh when mode is not web", async () => {
    // Direct mode — no web session involved.
    const provider = new OrangeProvider({ mode: "direct" });
    const result = await provider.proactivelyRefreshSession();
    expect(result.success).toBe(true);
    expect(result.reloggedIn).toBeUndefined();
  });
});

// ─── AirtelService.getSessionInfo unit tests ──────────────────────────────────

describe("AirtelService.getSessionInfo", () => {
  it("returns null when not in web mode", () => {
    const service = new AirtelService({ mode: "direct" });
    expect(service.getSessionInfo()).toBeNull();
  });

  it("returns null when in web mode but no session is cached", () => {
    const service = new AirtelService({
      mode: "web",
      webBaseUrl: "https://airtel.example.com",
      username: "user",
      password: "pass",
    });
    expect(service.getSessionInfo()).toBeNull();
  });
});

// ─── OrangeProvider.getSessionInfo unit tests ─────────────────────────────────

describe("OrangeProvider.getSessionInfo", () => {
  it("returns null when not in web mode", () => {
    const provider = new OrangeProvider({ mode: "direct" });
    expect(provider.getSessionInfo()).toBeNull();
  });

  it("returns null when in web mode but no session is cached", () => {
    const provider = new OrangeProvider({
      mode: "web",
      webBaseUrl: "https://orange.example.com",
      username: "user",
      password: "pass",
    });
    expect(provider.getSessionInfo()).toBeNull();
  });
});
