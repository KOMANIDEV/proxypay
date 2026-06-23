import { captureSnapshot } from "../services/priceTicker";

/**
 * Price Ticker Job
 * Schedule: Every hour at minute 0 (0 * * * *)
 * Fetches XLM/USD from CoinGecko and USD/XAF from exchangerate-api, then
 * stores a derived XLM/XAF snapshot. Failures on one pair do not prevent
 * the others from being stored.
 */
export async function runPriceTickerJob(): Promise<void> {
  const result = await captureSnapshot();

  console.log(
    `[price-ticker] Stored ${result.snapshots.length} snapshot(s) for hour bucket ${result.recordedAt.toISOString()}`,
  );

  if (result.errors.length > 0) {
    for (const { pair, message } of result.errors) {
      console.warn(`[price-ticker] ${pair} not recorded: ${message}`);
    }
  }
}
