import { TransactionModel, TransactionStatus } from "../models/transaction";
import { pool } from "../config/database";

export const MIN_WITHDRAWAL_AMOUNT = 1;

export class TransactionService {
  constructor(private txModel: TransactionModel) {}

  async findByUserId(userId: string) {
    return await this.txModel.findByUserId(userId);
  }

  // ============================================================================
  // WITHDRAWAL LOGIC
  // ============================================================================
  async withdraw(payload: {
    userId: string;
    amount: number;
    currency: string;
    provider?: string;
    destinationAccount?: string;
    [key: string]: any;
  }) {
    if (payload.amount < MIN_WITHDRAWAL_AMOUNT) {
      throw new Error("Amount too small");
    }

    // Validate user exists and has sufficient balance
    const user = await pool.query(
      `SELECT id, balance FROM users WHERE id = $1`,
      [payload.userId],
    );

    if (user.rows.length === 0) {
      throw new Error("User not found");
    }

    const currentBalance = parseFloat(user.rows[0].balance || "0");
    if (currentBalance < payload.amount) {
      throw new Error("Insufficient balance");
    }

    // Calculate fee
    const fee = await this.calculateWithdrawalFee(payload.amount, payload.currency);

    const totalDeduction = payload.amount + fee;
    if (currentBalance < totalDeduction) {
      throw new Error(`Insufficient balance. Required: ${totalDeduction} (amount: ${payload.amount} + fee: ${fee}), available: ${currentBalance}`);
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Deduct from user balance
      await client.query(
        `UPDATE users SET balance = balance - $1 WHERE id = $2`,
        [totalDeduction, payload.userId],
      );

      // Create withdrawal transaction
      const transaction = await this.txModel.createTransaction({
        userId: payload.userId,
        amount: payload.amount,
        currency: payload.currency,
        type: "WITHDRAWAL",
        status: TransactionStatus.Pending,
        fee,
        metadata: {
          provider: payload.provider || "mtn",
          destination_account: payload.destinationAccount,
          currency: payload.currency,
          fee_breakdown: {
            amount: payload.amount,
            fee,
            total: totalDeduction,
          },
          ...payload,
        },
      });

      // Log to withdrawal ledger
      await client.query(
        `INSERT INTO withdrawal_ledger
          (transaction_id, user_id, amount, fee, currency, provider, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
          transaction.id,
          payload.userId,
          payload.amount,
          fee,
          payload.currency,
          payload.provider || "mtn",
          "pending",
        ],
      );

      await client.query("COMMIT");

      return {
        success: true,
        transaction,
        fee,
        totalDeduction,
        newBalance: currentBalance - totalDeduction,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async calculateWithdrawalFee(amount: number, currency: string): Promise<number> {
    const result = await pool.query(
      `SELECT fee_fixed, fee_percent FROM fee_configurations
       WHERE type = 'withdrawal' AND (currency = $1 OR currency = 'ALL')
       ORDER BY updated_at DESC LIMIT 1`,
      [currency],
    );

    if (result.rows.length === 0) {
      // Default fee: 1% with $0.50 minimum
      return Math.max(0.5, amount * 0.01);
    }

    const config = result.rows[0];
    const fixedFee = parseFloat(config.fee_fixed || "0");
    const percentFee = amount * parseFloat(config.fee_percent || "0.01");

    return Math.max(fixedFee, percentFee);
  }
}