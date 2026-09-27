import { Router, Request, Response } from "express";
import { setApiVersion } from "../../middleware/apiVersion";
import { v4 as uuidv4 } from "uuid";

export const transactionRoutesV2 = Router();

// In-memory store for V2 transactions and webhook subscriptions
interface V2Transaction {
  id: string;
  type: "deposit" | "withdraw";
  state: "pending" | "processing" | "completed" | "failed";
  amount: number;
  currency: string;
  account_id: string;
  destination_account?: string;
  payment_method?: string;
  metadata: Record<string, any>;
  timeline: Array<{ state: string; timestamp: string }>;
  created_at: string;
  updated_at: string;
}

const v2Transactions = new Map<string, V2Transaction>();
const v2WebhookSubscriptions = new Map<string, any>();

/**
 * V2 Transaction Routes
 * 
 * Features:
 * - New response format with nested data
 * - Transaction states (pending, processing, completed, failed)
 * - Webhook events for transaction lifecycle
 * - Advanced filtering and pagination
 */

// Enhanced deposit with metadata
transactionRoutesV2.post(
  "/deposit",
  setApiVersion("v2"),
  (req: Request, res: Response) => {
    const { amount, currency, account_id, payment_method, metadata, idempotency_key } = req.body;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Invalid or missing amount: must be greater than 0",
        version: "v2"
      });
    }

    if (!currency || typeof currency !== "string") {
      return res.status(400).json({
        error: "Validation Error",
        message: "currency is required",
        version: "v2"
      });
    }

    if (!account_id || typeof account_id !== "string") {
      return res.status(400).json({
        error: "Validation Error",
        message: "account_id is required",
        version: "v2"
      });
    }

    const now = new Date().toISOString();
    const txId = `tx_${uuidv4()}`;
    const transaction: V2Transaction = {
      id: txId,
      type: "deposit",
      state: "pending",
      amount: Number(amount),
      currency: currency.toUpperCase(),
      account_id,
      payment_method: payment_method || "bank_transfer",
      metadata: metadata || {},
      timeline: [
        { state: "created", timestamp: now },
        { state: "pending", timestamp: now }
      ],
      created_at: now,
      updated_at: now
    };

    v2Transactions.set(txId, transaction);

    res.status(201).json({
      data: transaction,
      version: "v2"
    });
  }
);

// Enhanced withdrawal with webhooks
transactionRoutesV2.post(
  "/withdraw",
  setApiVersion("v2"),
  (req: Request, res: Response) => {
    const { amount, currency, account_id, destination_account, metadata, webhook_url } = req.body;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Invalid or missing amount: must be greater than 0",
        version: "v2"
      });
    }

    if (!currency || typeof currency !== "string") {
      return res.status(400).json({
        error: "Validation Error",
        message: "currency is required",
        version: "v2"
      });
    }

    if (!account_id || typeof account_id !== "string") {
      return res.status(400).json({
        error: "Validation Error",
        message: "account_id is required",
        version: "v2"
      });
    }

    if (!destination_account || typeof destination_account !== "string") {
      return res.status(400).json({
        error: "Validation Error",
        message: "destination_account is required",
        version: "v2"
      });
    }

    const now = new Date().toISOString();
    const txId = `tx_${uuidv4()}`;
    const transaction: V2Transaction = {
      id: txId,
      type: "withdraw",
      state: "pending",
      amount: Number(amount),
      currency: currency.toUpperCase(),
      account_id,
      destination_account,
      metadata: metadata || {},
      timeline: [
        { state: "created", timestamp: now },
        { state: "pending", timestamp: now }
      ],
      created_at: now,
      updated_at: now
    };

    v2Transactions.set(txId, transaction);

    res.status(201).json({
      data: transaction,
      version: "v2"
    });
  }
);

// Advanced search with filters (defined BEFORE /:id to avoid path collisions)
transactionRoutesV2.get(
  "/search",
  setApiVersion("v2"),
  (req: Request, res: Response) => {
    const {
      state,
      date_from,
      date_to,
      amount_min,
      amount_max,
      sort_by = "created_at",
      sort_order = "desc",
      limit = "20",
      offset = "0"
    } = req.query;

    let results = Array.from(v2Transactions.values());

    if (state && typeof state === "string") {
      results = results.filter((tx) => tx.state === state);
    }

    if (date_from && typeof date_from === "string") {
      const fromTime = new Date(date_from).getTime();
      results = results.filter((tx) => new Date(tx.created_at).getTime() >= fromTime);
    }

    if (date_to && typeof date_to === "string") {
      const toTime = new Date(date_to).getTime();
      results = results.filter((tx) => new Date(tx.created_at).getTime() <= toTime);
    }

    if (amount_min !== undefined) {
      const min = Number(amount_min);
      results = results.filter((tx) => tx.amount >= min);
    }

    if (amount_max !== undefined) {
      const max = Number(amount_max);
      results = results.filter((tx) => tx.amount <= max);
    }

    // Sort results
    results.sort((a: any, b: any) => {
      const fieldA = a[sort_by as string] ?? "";
      const fieldB = b[sort_by as string] ?? "";
      if (sort_order === "asc") {
        return fieldA > fieldB ? 1 : -1;
      }
      return fieldA < fieldB ? 1 : -1;
    });

    const parsedLimit = Math.max(1, parseInt(limit as string, 10) || 20);
    const parsedOffset = Math.max(0, parseInt(offset as string, 10) || 0);
    const paginatedResults = results.slice(parsedOffset, parsedOffset + parsedLimit);

    res.json({
      data: paginatedResults,
      pagination: {
        limit: parsedLimit,
        offset: parsedOffset,
        total: results.length
      },
      version: "v2"
    });
  }
);

// Better transaction details by ID
transactionRoutesV2.get(
  "/:id",
  setApiVersion("v2"),
  (req: Request, res: Response) => {
    const txId = req.params.id;
    const transaction = v2Transactions.get(txId);

    if (!transaction) {
      return res.status(404).json({
        error: "Not Found",
        message: `Transaction ${txId} not found`,
        version: "v2"
      });
    }

    res.json({
      data: transaction,
      version: "v2"
    });
  }
);

// Webhook subscriptions for transactions
transactionRoutesV2.post(
  "/webhooks",
  setApiVersion("v2"),
  (req: Request, res: Response) => {
    const { url, events, secret } = req.body;

    if (!url || typeof url !== "string") {
      return res.status(400).json({
        error: "Validation Error",
        message: "url is required",
        version: "v2"
      });
    }

    const validEvents = ["transaction.created", "transaction.completed", "transaction.failed"];
    const requestedEvents = Array.isArray(events) ? events : validEvents;

    const subId = `sub_${uuidv4()}`;
    const subscription = {
      id: subId,
      url,
      events: requestedEvents,
      status: "active",
      secret: secret || null,
      created_at: new Date().toISOString()
    };

    v2WebhookSubscriptions.set(subId, subscription);

    res.status(201).json({
      data: subscription,
      version: "v2"
    });
  }
);
