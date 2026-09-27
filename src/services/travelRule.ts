/**
 * Travel Rule Compliance Service — Persistence & FATF Audit Retrieval
 * Captures, encrypts, and persists travel rule compliance records into `travel_rule_records` table.
 */

import { pool } from "../config/database";
import { encrypt, decrypt } from "../utils/encryption";
import logger from "../utils/logger";

export const TRAVEL_RULE_THRESHOLD_USD = Number(
  process.env.TRAVEL_RULE_THRESHOLD_USD ?? 1000,
);

export interface TravelRuleParty {
  name: string;
  account: string;
  address?: string;
  dob?: string;
  idNumber?: string;
}

export interface TravelRuleInput {
  transactionId: string;
  amount: number;
  currency?: string;
  sender: TravelRuleParty;
  receiver: TravelRuleParty;
  originatingVasp?: string;
  beneficiaryVasp?: string;
}

export interface TravelRuleRecord {
  id: string;
  transactionId: string;
  amount: number;
  currency: string;
  sender: TravelRuleParty;
  receiver: TravelRuleParty;
  originatingVasp?: string;
  beneficiaryVasp?: string;
  createdAt: Date;
  exportedAt?: Date;
  exportedBy?: string;
}

export class TravelRulePersistenceService {
  /**
   * Check if transaction amount meets FATF Travel Rule threshold.
   */
  public applies(amountUsd: number): boolean {
    return amountUsd >= TRAVEL_RULE_THRESHOLD_USD;
  }

  /**
   * Encrypt and persist travel rule data to travel_rule_records database table.
   */
  public async capture(input: TravelRuleInput): Promise<TravelRuleRecord> {
    const encSenderName = encrypt(input.sender.name);
    const encSenderAccount = encrypt(input.sender.account);
    const encSenderAddress = input.sender.address ? encrypt(input.sender.address) : null;
    const encSenderDob = input.sender.dob ? encrypt(input.sender.dob) : null;
    const encSenderIdNumber = input.sender.idNumber ? encrypt(input.sender.idNumber) : null;

    const encReceiverName = encrypt(input.receiver.name);
    const encReceiverAccount = encrypt(input.receiver.account);
    const encReceiverAddress = input.receiver.address ? encrypt(input.receiver.address) : null;

    const query = `
      INSERT INTO travel_rule_records (
        transaction_id,
        amount,
        currency,
        sender_name,
        sender_account,
        sender_address,
        sender_dob,
        sender_id_number,
        receiver_name,
        receiver_account,
        receiver_address,
        originating_vasp,
        beneficiary_vasp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id, created_at;
    `;

    const values = [
      input.transactionId,
      input.amount,
      input.currency || "USD",
      encSenderName,
      encSenderAccount,
      encSenderAddress,
      encSenderDob,
      encSenderIdNumber,
      encReceiverName,
      encReceiverAccount,
      encReceiverAddress,
      input.originatingVasp || null,
      input.beneficiaryVasp || null,
    ];

    try {
      const result = await pool.query(query, values);
      const row = result.rows[0];

      logger.info(`[TravelRule] Persisted travel rule record for transaction ${input.transactionId} with ID ${row.id}`);

      return {
        id: row.id,
        transactionId: input.transactionId,
        amount: input.amount,
        currency: input.currency || "USD",
        sender: input.sender,
        receiver: input.receiver,
        originatingVasp: input.originatingVasp,
        beneficiaryVasp: input.beneficiaryVasp,
        createdAt: row.created_at,
      };
    } catch (err: any) {
      logger.error(`[TravelRule] Database persistence failed for transaction ${input.transactionId}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Retrieve and decrypt travel rule record by transaction ID.
   */
  public async findByTransactionId(transactionId: string): Promise<TravelRuleRecord | null> {
    const result = await pool.query(
      `SELECT * FROM travel_rule_records WHERE transaction_id = $1`,
      [transactionId]
    );

    if (result.rows.length === 0) return null;
    const row = result.rows[0];

    return {
      id: row.id,
      transactionId: row.transaction_id,
      amount: Number(row.amount),
      currency: row.currency,
      sender: {
        name: (decrypt(row.sender_name) as string) || row.sender_name,
        account: (decrypt(row.sender_account) as string) || row.sender_account,
        address: row.sender_address ? ((decrypt(row.sender_address) as string) || undefined) : undefined,
        dob: row.sender_dob ? ((decrypt(row.sender_dob) as string) || undefined) : undefined,
        idNumber: row.sender_id_number ? ((decrypt(row.sender_id_number) as string) || undefined) : undefined,
      },
      receiver: {
        name: (decrypt(row.receiver_name) as string) || row.receiver_name,
        account: (decrypt(row.receiver_account) as string) || row.receiver_account,
        address: row.receiver_address ? ((decrypt(row.receiver_address) as string) || undefined) : undefined,
      },
      originatingVasp: row.originating_vasp || undefined,
      beneficiaryVasp: row.beneficiary_vasp || undefined,
      createdAt: row.created_at,
      exportedAt: row.exported_at || undefined,
      exportedBy: row.exported_by || undefined,
    };
  }
}

export const travelRulePersistenceService = new TravelRulePersistenceService();
export const travelRuleService = travelRulePersistenceService;
