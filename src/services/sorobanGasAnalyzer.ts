import { pool } from "../config/database";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GasBenchmark {
  operation: string;
  contract_id: string;
  method: string;
  iterations: number;
  total_gas: number;
  avg_gas: number;
  min_gas: number;
  max_gas: number;
  p50_gas: number;
  p95_gas: number;
  p99_gas: number;
  timestamp: string;
}

export interface GasOptimization {
  operation: string;
  current_gas: number;
  optimized_gas: number;
  savings_percent: number;
  recommendation: string;
  priority: "low" | "medium" | "high";
}

export interface GasReport {
  benchmarks: GasBenchmark[];
  optimizations: GasOptimization[];
  total_estimated_savings: number;
  generated_at: string;
}

// ─── Benchmark Storage ───────────────────────────────────────────────────────

export async function recordGasBenchmark(params: {
  operation: string;
  contractId: string;
  method: string;
  gasUsed: number;
  iterations?: number;
}): Promise<void> {
  const iterations = params.iterations ?? 1;

  await pool.query(
    `INSERT INTO gas_benchmarks
      (operation, contract_id, method, gas_used, iterations, timestamp)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [params.operation, params.contractId, params.method, params.gasUsed, iterations],
  );
}

export async function getGasBenchmarks(params: {
  operation?: string;
  contractId?: string;
  limit?: number;
}): Promise<GasBenchmark[]> {
  const conditions: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (params.operation) {
    conditions.push(`operation = $${idx++}`);
    values.push(params.operation);
  }
  if (params.contractId) {
    conditions.push(`contract_id = $${idx++}`);
    values.push(params.contractId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = params.limit ?? 100;

  const result = await pool.query(
    `SELECT
       operation,
       contract_id,
       method,
       COUNT(*) AS iterations,
       SUM(gas_used) AS total_gas,
       AVG(gas_used) AS avg_gas,
       MIN(gas_used) AS min_gas,
       MAX(gas_used) AS max_gas,
       PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gas_used) AS p50_gas,
       PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY gas_used) AS p95_gas,
       PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY gas_used) AS p99_gas,
       MAX(timestamp) AS timestamp
     FROM gas_benchmarks
     ${where}
     GROUP BY operation, contract_id, method
     ORDER BY avg_gas DESC
     LIMIT $${idx}`,
    [...values, limit],
  );

  return result.rows.map((row) => ({
    operation: row.operation,
    contract_id: row.contract_id,
    method: row.method,
    iterations: parseInt(row.iterations),
    total_gas: parseFloat(row.total_gas),
    avg_gas: parseFloat(row.avg_gas),
    min_gas: parseFloat(row.min_gas),
    max_gas: parseFloat(row.max_gas),
    p50_gas: parseFloat(row.p50_gas),
    p95_gas: parseFloat(row.p95_gas),
    p99_gas: parseFloat(row.p99_gas),
    timestamp: row.timestamp,
  }));
}

// ─── Optimization Recommendations ────────────────────────────────────────────

export async function analyzeGasOptimizations(): Promise<GasOptimization[]> {
  const benchmarks = await getGasBenchmarks({ limit: 50 });
  const optimizations: GasOptimization[] = [];

  for (const bench of benchmarks) {
    if (bench.avg_gas > 10_000_000) {
      optimizations.push({
        operation: `${bench.operation}/${bench.method}`,
        current_gas: bench.avg_gas,
        optimized_gas: Math.round(bench.avg_gas * 0.7),
        savings_percent: 30,
        recommendation: `High gas usage detected. Consider: (1) reducing storage reads in ${bench.method}, (2) caching frequent lookups, (3) using lazy evaluation for conditional storage access`,
        priority: "high",
      });
    } else if (bench.avg_gas > 5_000_000) {
      optimizations.push({
        operation: `${bench.operation}/${bench.method}`,
        current_gas: bench.avg_gas,
        optimized_gas: Math.round(bench.avg_gas * 0.8),
        savings_percent: 20,
        recommendation: `Moderate gas usage. Consider optimizing ${bench.method} by batching storage reads and reducing intermediate data structures`,
        priority: "medium",
      });
    }

    if (bench.p99_gas > bench.avg_gas * 3) {
      optimizations.push({
        operation: `${bench.operation}/${bench.method}_latency`,
        current_gas: bench.p99_gas,
        optimized_gas: bench.p95_gas,
        savings_percent: Math.round(((bench.p99_gas - bench.p95_gas) / bench.p99_gas) * 100),
        recommendation: `High gas variance in ${bench.method} (p99=${bench.p99_gas} vs avg=${bench.avg_gas}). Investigate conditional code paths causing outliers`,
        priority: "medium",
      });
    }
  }

  return optimizations;
}

export async function generateGasReport(): Promise<GasReport> {
  const benchmarks = await getGasBenchmarks({ limit: 50 });
  const optimizations = await analyzeGasOptimizations();

  const totalSavings = optimizations.reduce(
    (sum, opt) => sum + (opt.current_gas - opt.optimized_gas),
    0,
  );

  return {
    benchmarks,
    optimizations,
    total_estimated_savings: totalSavings,
    generated_at: new Date().toISOString(),
  };
}
