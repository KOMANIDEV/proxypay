/**
 * SEP-38 (Anchor RFQ / Quotes) router.
 *
 * Endpoints:
 *   GET  /sep38/info      — supported asset pairs
 *   GET  /sep38/prices    — indicative price for a pair
 *   GET  /sep38/price     — singular alias of /prices
 *   POST /sep38/quote     — firm, time-locked quote
 *   GET  /sep38/quote/:id — retrieve a stored quote
 *
 * Rates come from the SEP-38 rate provider; firm quotes are persisted in the
 * layered cache (memory + Redis) for their TTL so they survive across the
 * quote window and across instances.
 */

import crypto from "node:crypto";
import { Router, Request, Response } from "express";
import { rateProvider } from "../services/sep38/rateProvider";
import { layeredCache } from "../services/layeredCache";
import { SUPPORTED_CURRENCIES } from "../services/currency";
import { getConfiguredPaymentAsset } from "../services/stellar/assetService";

const sep38Router = Router();

const AMOUNT_PRECISION = 7;
const DEFAULT_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 300;
/** Expired quotes are kept briefly so lookups can answer 410 instead of 404. */
const EXPIRED_QUOTE_GRACE_SECONDS = 60;

interface Sep38Quote {
  id: string;
  expires_at: string;
  sell_asset: string;
  buy_asset: string;
  sell_amount: string;
  buy_amount: string;
  price: string;
  fee_percent: string;
  fee_fixed: string;
  created_at: string;
}

function quoteCacheKey(id: string): string {
  return `sep38:quote:${id}`;
}

/** SEP-38 identifiers for every Stellar asset this anchor can trade. */
function stellarAssets(): string[] {
  const assets = ["stellar:XLM"];
  try {
    const configured = getConfiguredPaymentAsset();
    if (!configured.isNative()) {
      assets.push(
        `stellar:${configured.getCode()}:${configured.getIssuer()}`,
      );
    }
  } catch {
    // Asset misconfigured — fall back to native only.
  }
  return assets;
}

function supportedPairs(): Array<{ sell_asset: string; buy_asset: string }> {
  const fiat = SUPPORTED_CURRENCIES.map((code) => `iso4217:${code}`);
  const pairs: Array<{ sell_asset: string; buy_asset: string }> = [];

  for (const stellarAsset of stellarAssets()) {
    for (const fiatAsset of fiat) {
      pairs.push({ sell_asset: fiatAsset, buy_asset: stellarAsset });
      pairs.push({ sell_asset: stellarAsset, buy_asset: fiatAsset });
    }
  }

  return pairs;
}

function parsePositiveAmount(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = typeof value === "number" ? value : parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function normalizeTtl(value: unknown): number {
  const parsed = typeof value === "number" ? value : parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_SECONDS;
  return Math.min(Math.trunc(parsed), MAX_TTL_SECONDS);
}

// ─── GET /info ────────────────────────────────────────────────────────────────

sep38Router.get("/info", (_req: Request, res: Response) => {
  return res.json({ assets: supportedPairs() });
});

// ─── GET /prices, GET /price ──────────────────────────────────────────────────

async function handlePrice(req: Request, res: Response): Promise<Response> {
  const sellAsset = req.query.sell_asset;
  const buyAsset = req.query.buy_asset;

  if (typeof sellAsset !== "string" || typeof buyAsset !== "string") {
    return res.status(400).json({
      error: "Missing required parameters: sell_asset and buy_asset",
    });
  }

  const rate = await rateProvider.getIndicativePrice(sellAsset, buyAsset);
  if (!rate) {
    return res
      .status(400)
      .json({ error: `Unsupported asset pair: ${sellAsset} -> ${buyAsset}` });
  }

  return res.json({
    sell_asset: sellAsset,
    buy_asset: buyAsset,
    price: rate.price,
    fee_percent: rate.fee_percent,
    fee_fixed: rate.fee_fixed,
  });
}

sep38Router.get("/prices", handlePrice);
sep38Router.get("/price", handlePrice);

// ─── POST /quote ──────────────────────────────────────────────────────────────

sep38Router.post("/quote", async (req: Request, res: Response) => {
  const {
    sell_asset: sellAsset,
    buy_asset: buyAsset,
    sell_amount: sellAmountRaw,
    buy_amount: buyAmountRaw,
    ttl,
  } = req.body ?? {};

  if (
    typeof sellAsset !== "string" ||
    typeof buyAsset !== "string" ||
    (sellAmountRaw === undefined && buyAmountRaw === undefined)
  ) {
    return res.status(400).json({
      error:
        "Missing required parameters: sell_asset, buy_asset and one of sell_amount or buy_amount",
    });
  }

  const sellAmount =
    sellAmountRaw === undefined ? null : parsePositiveAmount(sellAmountRaw);
  if (sellAmountRaw !== undefined && sellAmount === null) {
    return res
      .status(400)
      .json({ error: "sell_amount must be a positive number" });
  }

  const buyAmount =
    buyAmountRaw === undefined ? null : parsePositiveAmount(buyAmountRaw);
  if (buyAmountRaw !== undefined && buyAmount === null) {
    return res
      .status(400)
      .json({ error: "buy_amount must be a positive number" });
  }

  const rate = await rateProvider.getFirmPrice(sellAsset, buyAsset);
  if (!rate) {
    return res
      .status(400)
      .json({ error: `Unsupported asset pair: ${sellAsset} -> ${buyAsset}` });
  }

  const price = parseFloat(rate.price);
  const feePercent = parseFloat(rate.fee_percent);
  const feeFixed = parseFloat(rate.fee_fixed);
  const feeMultiplier = 1 - feePercent / 100;

  if (!Number.isFinite(price) || price <= 0 || feeMultiplier <= 0) {
    return res.status(500).json({ error: "Unable to generate quote" });
  }

  // Fees are charged on the sell side; the remainder converts at `price`.
  let sellValue: number;
  let buyValue: number;
  if (sellAmount !== null) {
    sellValue = sellAmount;
    buyValue = (sellAmount - feeFixed) * feeMultiplier * price;
  } else {
    buyValue = buyAmount as number;
    sellValue = buyValue / price / feeMultiplier + feeFixed;
  }

  if (!Number.isFinite(buyValue) || buyValue <= 0 || sellValue <= 0) {
    return res
      .status(400)
      .json({ error: "Amount is too small to cover the quote fees" });
  }

  const ttlSeconds = normalizeTtl(ttl);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + ttlSeconds * 1000);

  const quote: Sep38Quote = {
    id: crypto.randomUUID(),
    expires_at: expiresAt.toISOString(),
    sell_asset: sellAsset,
    buy_asset: buyAsset,
    // Echo the client-supplied amount verbatim; derive the other side.
    sell_amount:
      sellAmount !== null
        ? String(sellAmountRaw)
        : sellValue.toFixed(AMOUNT_PRECISION),
    buy_amount:
      buyAmount !== null
        ? String(buyAmountRaw)
        : buyValue.toFixed(AMOUNT_PRECISION),
    price: rate.price,
    fee_percent: rate.fee_percent,
    fee_fixed: rate.fee_fixed,
    created_at: createdAt.toISOString(),
  };

  await layeredCache.set(
    quoteCacheKey(quote.id),
    quote,
    ttlSeconds + EXPIRED_QUOTE_GRACE_SECONDS,
  );

  return res.json(quote);
});

// ─── GET /quote/:id ───────────────────────────────────────────────────────────

sep38Router.get("/quote/:id", async (req: Request, res: Response) => {
  const quote = await layeredCache.get<Sep38Quote>(
    quoteCacheKey(req.params.id),
  );

  if (!quote) {
    return res.status(404).json({ error: "Quote not found" });
  }

  if (new Date(quote.expires_at).getTime() <= Date.now()) {
    return res.status(410).json({ error: "Quote has expired" });
  }

  return res.json(quote);
});

export default sep38Router;
