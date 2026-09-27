import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { StrKey } from "stellar-sdk";
import { Pool } from "pg";
import { Sep12Service, Sep12CustomerStatus } from "./sep12";
import logger from "../utils/logger";

const getSep6FallbackConfig = () => ({
  transferServer: process.env.STELLAR_TRANSFER_SERVER || "https://api.proxypay.com",
  anchorStellarAccount: process.env.STELLAR_ISSUER_ACCOUNT || "G_YOUR_ANCHOR_ACCOUNT",
  assets: {
    XLM: {
      asset_code: "XLM",
      deposits_enabled: true,
      withdrawals_enabled: true,
      min_amount: 1,
      max_amount: 1000000,
      fee_fixed: 0.5,
      fee_percent: 1,
    },
  },
});

export const createSep6Router = (db: Pool): Router => {
  const sep6Router = Router();
  const sep12Service = new Sep12Service(db);

  // In-memory fallback if database table is not provisioned
  const memoryTransactions = new Map<string, any>();

  // Fetch asset config from database (anchored_assets) or fallback
  const getAssetConfig = async () => {
    try {
      const res = await db.query(
        "SELECT asset_code, deposits_enabled, withdrawals_enabled, min_amount, max_amount, fee_fixed, fee_percent FROM anchored_assets WHERE enabled = true"
      );
      if (res.rows && res.rows.length > 0) {
        const assets: Record<string, any> = {};
        for (const row of res.rows) {
          assets[row.asset_code] = {
            asset_code: row.asset_code,
            deposits_enabled: Boolean(row.deposits_enabled),
            withdrawals_enabled: Boolean(row.withdrawals_enabled),
            min_amount: Number(row.min_amount) || 1,
            max_amount: Number(row.max_amount) || 1000000,
            fee_fixed: Number(row.fee_fixed) || 0.5,
            fee_percent: Number(row.fee_percent) || 1,
          };
        }
        return {
          transferServer: process.env.STELLAR_TRANSFER_SERVER || "https://api.proxypay.com",
          anchorStellarAccount: process.env.STELLAR_ISSUER_ACCOUNT || "G_YOUR_ANCHOR_ACCOUNT",
          assets,
        };
      }
    } catch (err: any) {
      logger.debug({ error: err.message }, "Using fallback in-memory asset configuration for SEP-6");
    }
    return getSep6FallbackConfig();
  };

  const persistTransaction = async (record: any) => {
    memoryTransactions.set(record.id, record);
    try {
      await db.query(
        `INSERT INTO transactions (id, reference_number, type, amount, status, user_id, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, updated_at = NOW()`,
        [
          record.id,
          record.memo || record.id.substring(0, 16),
          record.kind,
          String(record.amount || 0),
          record.status,
          record.account || "system",
          JSON.stringify(record),
        ]
      );
    } catch (e: any) {
      logger.debug({ error: e.message }, "Persisted SEP-6 transaction to memory store");
    }
  };

  /**
   * GET /info
   * Returns supported assets and required SEP-9 KYC fields for deposit/withdrawal
   */
  sep6Router.get("/info", async (req: Request, res: Response) => {
    const config = await getAssetConfig();
    const deposit: any = {};
    const withdraw: any = {};

    for (const [code, asset] of Object.entries(config.assets)) {
      if (asset.deposits_enabled) {
        deposit[code] = {
          enabled: true,
          fee_fixed: asset.fee_fixed,
          fee_percent: asset.fee_percent,
          min_amount: asset.min_amount,
          max_amount: asset.max_amount,
          fields: {
            email_address: { description: "Email address for receipt", optional: true },
            first_name: { description: "SEP-9 Customer first name", optional: true },
            last_name: { description: "SEP-9 Customer last name", optional: true },
            id_number: { description: "SEP-9 National ID or Passport Number", optional: true },
            photo_id_front: { description: "SEP-9 ID document image (Base64)", optional: true },
          },
        };
      }
      if (asset.withdrawals_enabled) {
        withdraw[code] = {
          enabled: true,
          fee_fixed: asset.fee_fixed,
          fee_percent: asset.fee_percent,
          min_amount: asset.min_amount,
          max_amount: asset.max_amount,
          types: {
            bank_account: {
              fields: {
                dest: { description: "Bank account number", optional: false },
                dest_extra: { description: "Routing number / Sort code", optional: false },
                bank_name: { description: "SEP-9 Bank Name", optional: true },
                bank_account_number: { description: "SEP-9 Bank Account Number", optional: true },
              },
            },
          },
        };
      }
    }

    res.json({
      deposit,
      withdraw,
      fee: { enabled: true },
      features: { account_creation: true, claimable_balances: true },
    });
  });

  /**
   * GET /deposit
   * Returns instructions for depositing fiat and tracks the transaction.
   */
  sep6Router.get("/deposit", async (req: Request, res: Response) => {
    try {
      const { asset_code, account, memo, memo_type, email_address, amount } = req.query;

      if (!asset_code || !account) {
        return res.status(400).json({ error: "asset_code and account are required" });
      }

      if (!StrKey.isValidEd25519PublicKey(account as string)) {
        return res.status(400).json({ error: "invalid 'account'" });
      }

      const customer = await sep12Service.getCustomer(
        account as string,
        memo as string,
        memo_type as string
      );

      if (customer.status === Sep12CustomerStatus.NEEDS_INFO) {
        return res.status(403).json({ type: "non_interactive_customer_info_needed" });
      } else if (customer.status === Sep12CustomerStatus.PROCESSING) {
        return res.status(403).json({ type: "customer_info_status", status: "pending" });
      } else if (customer.status === Sep12CustomerStatus.REJECTED) {
        return res.status(403).json({ type: "customer_info_status", status: "denied" });
      }

      const transactionId = uuidv4();
      const fee_fixed = 0.5;

      const record = {
        id: transactionId,
        kind: "deposit",
        status: "pending_user_transfer_start",
        account,
        asset_code,
        amount: amount || "0",
        fee_fixed,
        email_address,
        created_at: new Date().toISOString(),
      };

      await persistTransaction(record);

      res.json({
        how: "Please wire funds to Bank XYZ, Account 123456789, Routing 987654321. Include the transaction ID in the memo.",
        id: transactionId,
        fee_fixed,
        extra_info: {
          message: "Transfers typically take 1-2 business days.",
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message }, "[SEP-6 Deposit Error]");
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  /**
   * GET /withdraw
   * Returns the anchor's Stellar account where the user should send the asset.
   */
  sep6Router.get("/withdraw", async (req: Request, res: Response) => {
    try {
      const { asset_code, type, dest, dest_extra, account, amount } = req.query;
      const config = await getAssetConfig();

      if (!asset_code || !type || !dest) {
        return res.status(400).json({ error: "asset_code, type, and dest are required" });
      }

      if (account && !StrKey.isValidEd25519PublicKey(account as string)) {
        return res.status(400).json({ error: "invalid 'account'" });
      }

      if (account) {
        const customer = await sep12Service.getCustomer(
          account as string,
          req.query.memo as string,
          req.query.memo_type as string
        );

        if (customer.status === Sep12CustomerStatus.NEEDS_INFO) {
          return res.status(403).json({ type: "non_interactive_customer_info_needed" });
        } else if (customer.status === Sep12CustomerStatus.PROCESSING) {
          return res.status(403).json({ type: "customer_info_status", status: "pending" });
        } else if (customer.status === Sep12CustomerStatus.REJECTED) {
          return res.status(403).json({ type: "customer_info_status", status: "denied" });
        }
      } else {
        return res.status(403).json({ type: "non_interactive_customer_info_needed" });
      }

      const transactionId = uuidv4();
      const memo = transactionId.replace(/-/g, "").substring(0, 32);

      const record = {
        id: transactionId,
        kind: "withdrawal",
        status: "pending_user_transfer_start",
        dest,
        dest_extra,
        asset_code,
        account,
        amount: amount || "0",
        memo,
        created_at: new Date().toISOString(),
      };

      await persistTransaction(record);

      res.json({
        account: config.anchorStellarAccount,
        memo,
        memo_type: "text",
        id: transactionId,
        fee_fixed: 0.5,
      });
    } catch (error: any) {
      logger.error({ error: error.message }, "[SEP-6 Withdraw Error]");
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  /**
   * GET /transaction
   * SEP-6 Transaction status polling endpoint
   */
  sep6Router.get("/transaction", async (req: Request, res: Response) => {
    const { id, stellar_transaction_id, external_transaction_id } = req.query;

    if (!id && !stellar_transaction_id && !external_transaction_id) {
      return res.status(400).json({ error: "One of id, stellar_transaction_id, or external_transaction_id is required" });
    }

    const txId = (id || external_transaction_id) as string;
    let tx = memoryTransactions.get(txId);

    if (!tx) {
      try {
        const queryRes = await db.query(
          "SELECT metadata FROM transactions WHERE id = $1 OR reference_number = $1",
          [txId]
        );
        if (queryRes.rows.length > 0) {
          tx = typeof queryRes.rows[0].metadata === "string"
            ? JSON.parse(queryRes.rows[0].metadata)
            : queryRes.rows[0].metadata;
        }
      } catch (err: any) {
        logger.debug({ error: err.message }, "Error querying transaction status from db");
      }
    }

    if (!tx) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    res.json({ transaction: tx });
  });

  /**
   * GET /transactions/:id
   * Enhanced status endpoint
   */
  sep6Router.get("/transactions/:id", async (req: Request, res: Response) => {
    const txId = req.params.id;
    let tx = memoryTransactions.get(txId);

    if (!tx) {
      try {
        const queryRes = await db.query(
          "SELECT metadata FROM transactions WHERE id = $1",
          [txId]
        );
        if (queryRes.rows.length > 0) {
          tx = typeof queryRes.rows[0].metadata === "string"
            ? JSON.parse(queryRes.rows[0].metadata)
            : queryRes.rows[0].metadata;
        }
      } catch (err: any) {
        logger.debug({ error: err.message }, "Error querying transaction by id from db");
      }
    }

    if (!tx) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    res.json({ transaction: tx });
  });

  return sep6Router;
};

export default createSep6Router;