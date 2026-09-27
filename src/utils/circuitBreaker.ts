import CircuitBreaker, { CircuitBreakerOptions } from "opossum";
import {
  providerCircuitBreakerState,
  providerCircuitBreakerTransitionsTotal,
} from "./metrics";
import { checkMobileMoneyHealth } from "../services/mobilemoney/providers/healthCheck";

export interface CircuitBreakerActionResult<T> {
  success: boolean;
  data?: T;
  error?: unknown;
  provider?: string;
  statusCode?: number;
  failureType?: CircuitBreakerFailureType;
  retryable?: boolean;
}

export type CircuitBreakerFailureType =
  | "timeout"
  | "network"
  | "rate_limit"
  | "server"
  | "authentication"
  | "client"
  | "business"
  | "unknown";

export interface ExecuteWithCircuitBreakerOptions<T> {
  provider: string;
  operation: string;
  execute: () => Promise<CircuitBreakerActionResult<T>>;
  fallback?: (
    error: unknown,
  ) => Promise<CircuitBreakerActionResult<T>> | CircuitBreakerActionResult<T>;
  failureDetector?: (result: CircuitBreakerActionResult<T>) => boolean;
  healthCheck?: () => Promise<boolean>;
}

type BreakerInvocation<T> = () => Promise<CircuitBreakerActionResult<T>>;
type BreakerFallback<T> = (
  error: unknown,
) => Promise<CircuitBreakerActionResult<T>> | CircuitBreakerActionResult<T>;

type ProviderCircuitBreaker<T> = CircuitBreaker<
  [BreakerInvocation<T>, BreakerFallback<T> | undefined],
  CircuitBreakerActionResult<T>
>;

const circuitBreakers = new Map<string, ProviderCircuitBreaker<unknown>>();

const CIRCUIT_STATE_VALUES = {
  closed: 0,
  half_open: 0.5,
  open: 1,
} as const;

function getCircuitKey(provider: string, operation: string): string {
  return `${provider}:${operation}`;
}

import { providerSettingsService } from "../services/providerSettingsService";

async function getBreakerOptions(name: string, provider: string): Promise<CircuitBreakerOptions> {
  const settings = await providerSettingsService.getProviderSettings(provider);

  const timeoutMs = settings ? settings.timeout_ms : Number(process.env.PROVIDER_CIRCUIT_BREAKER_TIMEOUT_MS ?? 5_000);
  const volumeThreshold = settings ? settings.failure_threshold : Number(process.env.PROVIDER_CIRCUIT_BREAKER_VOLUME_THRESHOLD ?? 3);

  return {
    name,
    timeout: timeoutMs,
    resetTimeout: Number(
      process.env.PROVIDER_CIRCUIT_BREAKER_RESET_TIMEOUT_MS ?? 30_000,
    ),
    rollingCountTimeout: Number(
      process.env.PROVIDER_CIRCUIT_BREAKER_ROLLING_WINDOW_MS ?? 300_000, // 5 minutes
    ),
    rollingCountBuckets: Number(
      process.env.PROVIDER_CIRCUIT_BREAKER_ROLLING_BUCKETS ?? 10,
    ),
    volumeThreshold: volumeThreshold,
    errorThresholdPercentage: Number(
      process.env.PROVIDER_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE ?? 50,
    ),
    capacity: Number(process.env.PROVIDER_CIRCUIT_BREAKER_CAPACITY ?? 100),
    enableSnapshots: false,
  };
}

function setCircuitStateMetric(
  provider: string,
  operation: string,
  state: keyof typeof CIRCUIT_STATE_VALUES,
): void {
  providerCircuitBreakerState.set(
    { provider, operation },
    CIRCUIT_STATE_VALUES[state],
  );
}

function emitStateTransitionMetric(
  provider: string,
  operation: string,
  state: keyof typeof CIRCUIT_STATE_VALUES,
): void {
  providerCircuitBreakerTransitionsTotal.inc({ provider, operation, state });
  setCircuitStateMetric(provider, operation, state);
}

function toExecutionError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === "string" ? error : "Provider call failed");
}

export function classifyCircuitBreakerFailure(
  error: unknown,
): CircuitBreakerFailureType {
  const statusCode =
    typeof error === "object" && error !== null && "statusCode" in error
      ? Number((error as { statusCode?: unknown }).statusCode)
      : undefined;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  const message = error instanceof Error ? error.message : String(error ?? "");

  if (/timeout|timed out|ETIMEDOUT|ECONNABORTED/i.test(`${code} ${message}`)) {
    return "timeout";
  }
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|network|socket|fetch failed/i.test(`${code} ${message}`)) {
    return "network";
  }
  if (statusCode === 429) return "rate_limit";
  if (statusCode !== undefined && statusCode >= 500) return "server";
  if (statusCode === 401 || statusCode === 403) return "authentication";
  if (statusCode !== undefined && statusCode >= 400) return "client";
  return "unknown";
}

function shouldCountFailure<T>(
  result: CircuitBreakerActionResult<T>,
  detector?: (result: CircuitBreakerActionResult<T>) => boolean,
): boolean {
  if (detector) return detector(result);
  if (result.success || result.retryable === false) return false;
  return result.failureType !== "business" && result.failureType !== "client" && result.failureType !== "authentication";
}

function normalizeResult<T>(
  result: CircuitBreakerActionResult<T>,
  detector?: (result: CircuitBreakerActionResult<T>) => boolean,
): CircuitBreakerActionResult<T> {
  if (!shouldCountFailure(result, detector)) {
    return result;
  }

  const error = toExecutionError(result.error);
  if (!result.failureType) {
    result.failureType = classifyCircuitBreakerFailure(result.error);
  }
  throw error;
}

async function getOrCreateCircuitBreaker<T>(
  provider: string,
  operation: string,
  failureDetector?: (result: CircuitBreakerActionResult<T>) => boolean,
): Promise<ProviderCircuitBreaker<T>> {
  const key = getCircuitKey(provider, operation);
  const existing = circuitBreakers.get(key);
  if (existing) {
    return existing as ProviderCircuitBreaker<T>;
  }

  const options = await getBreakerOptions(key, provider);

  const breaker = new CircuitBreaker<
    [BreakerInvocation<T>, BreakerFallback<T> | undefined],
    CircuitBreakerActionResult<T>
  >(async (execute) => normalizeResult(await execute(), failureDetector), {
    ...options,
    errorFilter: (error) => {
      const result = error as CircuitBreakerActionResult<T>;
      return result?.failureType === "business" || result?.retryable === false;
    },
  });

  breaker.fallback(async (_execute, fallback, error) => {
    if (!fallback) {
      throw toExecutionError(error);
    }

    return normalizeResult(await fallback(error), failureDetector);
  });

  breaker.on("open", () => {
    console.error(`Circuit breaker opened for ${provider}:${operation} due to high error rate`);
    emitStateTransitionMetric(provider, operation, "open");
  });
  breaker.on("halfOpen", () => {
    console.log(`Circuit breaker half-open for ${provider}:${operation}, testing recovery`);
    emitStateTransitionMetric(provider, operation, "half_open");
  });
  breaker.on("close", () => {
    console.log(`Circuit breaker closed for ${provider}:${operation}, service recovered`);
    emitStateTransitionMetric(provider, operation, "closed");
  });

  setCircuitStateMetric(provider, operation, "closed");
  circuitBreakers.set(key, breaker as ProviderCircuitBreaker<unknown>);
  return breaker;
}

export async function executeWithCircuitBreaker<T>(
  options: ExecuteWithCircuitBreakerOptions<T>,
): Promise<CircuitBreakerActionResult<T>> {
  const breaker = await getOrCreateCircuitBreaker<T>(
    options.provider,
    options.operation,
    options.failureDetector,
  );

  return breaker.fire(options.execute, options.fallback);
}

export function isCircuitBreakerOpenError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "EOPENBREAKER"
  );
}

export function resetCircuitBreakers(): void {
  for (const breaker of circuitBreakers.values()) {
    breaker.shutdown();
  }
  circuitBreakers.clear();
}

export function resetCircuitBreakerForProvider(provider: string): void {
  for (const [key, breaker] of circuitBreakers.entries()) {
    if (key.startsWith(`${provider}:`)) {
      breaker.shutdown();
      circuitBreakers.delete(key);
    }
  }
}

export async function checkAndResetCircuitBreaker(
  provider: string,
  operation: string,
  healthCheck: () => Promise<boolean> = async () => {
    const healthResult = await checkMobileMoneyHealth();
    const providerHealth = healthResult.providers[provider as keyof typeof healthResult.providers];
    return providerHealth?.status === "up";
  },
): Promise<boolean> {
  const key = getCircuitKey(provider, operation);
  const breaker = circuitBreakers.get(key);
  if (!breaker) {
    return false;
  }

  // Only reset if open
  if (breaker.opened) {
    try {
      if (await healthCheck()) {
        breaker.close();
        console.log(`Circuit breaker for ${provider}:${operation} reset due to health check`);
        return true;
      }
    } catch (error) {
      console.error(`Failed to check health for ${provider}: ${error}`);
    }
  }
  return false;
}

export function getCircuitBreakerCount(): number {
  return circuitBreakers.size;
}

export type CircuitBreakerState = "closed" | "half_open" | "open";

export function getCircuitBreakerState(
  provider: string,
  operation: string,
): CircuitBreakerState | "not_found" {
  const breaker = circuitBreakers.get(getCircuitKey(provider, operation));
  if (!breaker) return "not_found";
  if (breaker.opened) return "open";
  if (breaker.halfOpen) return "half_open";
  return "closed";
}

export function resetCircuitBreaker(provider: string, operation: string): boolean {
  const key = getCircuitKey(provider, operation);
  const breaker = circuitBreakers.get(key);
  if (!breaker) return false;
  breaker.shutdown();
  circuitBreakers.delete(key);
  return true;
}
