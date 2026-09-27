import { queryRead, queryWrite } from "../config/database";
import { v4 as uuidv4 } from "uuid";

export enum BatchOperationStatus {
  Pending = "pending",
  Processing = "processing",
  Completed = "completed",
  Failed = "failed",
  Partial = "partial",
}

export enum BatchItemStatus {
  Pending = "pending",
  Processing = "processing",
  Completed = "completed",
  Failed = "failed",
  Retrying = "retrying",
}

export enum WebhookStatus {
  Pending = "pending",
  Sent = "sent",
  Failed = "failed",
}

export interface BatchOperation {
  id: string;
  batchReference: string;
  provider: string;
  operationType: string;
  status: BatchOperationStatus;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  startedAt: Date;
  completedAt: Date | null;
  webhookUrl: string | null;
  webhookStatus: WebhookStatus;
  webhookLastAttemptAt: Date | null;
  webhookLastError: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface BatchItem {
  id: string;
  batchId: string;
  transactionId: string | null;
  referenceId: string;
  phoneNumber: string | null;
  amount: string | null;
  status: BatchItemStatus;
  errorMessage: string | null;
  retryCount: number;
  maxRetries: number;
  providerReference: string | null;
  processedAt: Date | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateBatchOperationData {
  batchReference: string;
  provider: string;
  operationType?: string;
  webhookUrl?: string;
  totalItems?: number;
  metadata?: Record<string, unknown>;
}

export interface CreateBatchItemData {
  batchId: string;
  transactionId?: string;
  referenceId: string;
  phoneNumber?: string;
  amount?: string;
  maxRetries?: number;
  metadata?: Record<string, unknown>;
}

export interface BatchOperationFilters {
  provider?: string;
  status?: BatchOperationStatus;
  operationType?: string;
  startDate?: Date;
  endDate?: Date;
}

export interface BatchItemFilters {
  status?: BatchItemStatus;
  batchId?: string;
  transactionId?: string;
}

const BATCH_OPERATION_SELECT_COLUMNS = `
  id,
  batch_reference AS "batchReference",
  provider,
  operation_type AS "operationType",
  status,
  total_items AS "totalItems",
  completed_items AS "completedItems",
  failed_items AS "failedItems",
  started_at AS "startedAt",
  completed_at AS "completedAt",
  webhook_url AS "webhookUrl",
  webhook_status AS "webhookStatus",
  webhook_last_attempt_at AS "webhookLastAttemptAt",
  webhook_last_error AS "webhookLastError",
  COALESCE(metadata, '{}') AS metadata,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const BATCH_ITEM_SELECT_COLUMNS = `
  id,
  batch_id AS "batchId",
  transaction_id AS "transactionId",
  reference_id AS "referenceId",
  phone_number AS "phoneNumber",
  amount::text AS amount,
  status,
  error_message AS "errorMessage",
  retry_count AS "retryCount",
  max_retries AS "maxRetries",
  provider_reference AS "providerReference",
  processed_at AS "processedAt",
  COALESCE(metadata, '{}') AS metadata,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapBatchOperationRow(row: any): BatchOperation | null {
  if (!row) return null;

  return {
    id: String(row.id),
    batchReference: row.batchReference,
    provider: row.provider,
    operationType: row.operationType,
    status: row.status,
    totalItems: row.totalItems,
    completedItems: row.completedItems,
    failedItems: row.failedItems,
    startedAt: new Date(row.startedAt),
    completedAt: row.completedAt ? new Date(row.completedAt) : null,
    webhookUrl: row.webhookUrl,
    webhookStatus: row.webhookStatus,
    webhookLastAttemptAt: row.webhookLastAttemptAt ? new Date(row.webhookLastAttemptAt) : null,
    webhookLastError: row.webhookLastError,
    metadata: row.metadata,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function mapBatchItemRow(row: any): BatchItem | null {
  if (!row) return null;

  return {
    id: String(row.id),
    batchId: String(row.batchId),
    transactionId: row.transactionId ? String(row.transactionId) : null,
    referenceId: row.referenceId,
    phoneNumber: row.phoneNumber,
    amount: row.amount,
    status: row.status,
    errorMessage: row.errorMessage,
    retryCount: row.retryCount,
    maxRetries: row.maxRetries,
    providerReference: row.providerReference,
    processedAt: row.processedAt ? new Date(row.processedAt) : null,
    metadata: row.metadata,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

export class BatchOperationModel {
  async create(data: CreateBatchOperationData): Promise<BatchOperation> {
    const batchReference = data.batchReference || `BATCH-${uuidv4().slice(0, 8).toUpperCase()}`;

    const result = await queryWrite(
      `INSERT INTO batch_operations (
        batch_reference, provider, operation_type, status,
        total_items, webhook_url, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING ${BATCH_OPERATION_SELECT_COLUMNS}`,
      [
        batchReference,
        data.provider,
        data.operationType || "payout",
        BatchOperationStatus.Pending,
        data.totalItems || 0,
        data.webhookUrl || null,
        JSON.stringify(data.metadata || {}),
      ],
    );

    const operation = mapBatchOperationRow(result.rows[0]);
    if (!operation) {
      throw new Error("Failed to create batch operation");
    }

    return operation;
  }

  async findById(id: string): Promise<BatchOperation | null> {
    const result = await queryRead(
      `SELECT ${BATCH_OPERATION_SELECT_COLUMNS}
       FROM batch_operations
       WHERE id = $1`,
      [id],
    );

    return mapBatchOperationRow(result.rows[0]);
  }

  async findByBatchReference(batchReference: string): Promise<BatchOperation | null> {
    const result = await queryRead(
      `SELECT ${BATCH_OPERATION_SELECT_COLUMNS}
       FROM batch_operations
       WHERE batch_reference = $1`,
      [batchReference],
    );

    return mapBatchOperationRow(result.rows[0]);
  }

  async updateStatus(
    id: string,
    status: BatchOperationStatus,
  ): Promise<BatchOperation | null> {
    const result = await queryWrite(
      `UPDATE batch_operations
       SET status = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING ${BATCH_OPERATION_SELECT_COLUMNS}`,
      [status, id],
    );

    return mapBatchOperationRow(result.rows[0]);
  }

  async updateWebhookStatus(
    id: string,
    webhookStatus: WebhookStatus,
    error?: string,
  ): Promise<BatchOperation | null> {
    const result = await queryWrite(
      `UPDATE batch_operations
       SET webhook_status = $1,
           webhook_last_attempt_at = CURRENT_TIMESTAMP,
           webhook_last_error = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING ${BATCH_OPERATION_SELECT_COLUMNS}`,
      [webhookStatus, error || null, id],
    );

    return mapBatchOperationRow(result.rows[0]);
  }

  async list(
    limit = 50,
    offset = 0,
    filters: BatchOperationFilters = {},
  ): Promise<BatchOperation[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (filters.provider) {
      conditions.push(`provider = $${paramIndex++}`);
      params.push(filters.provider);
    }

    if (filters.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(filters.status);
    }

    if (filters.operationType) {
      conditions.push(`operation_type = $${paramIndex++}`);
      params.push(filters.operationType);
    }

    if (filters.startDate) {
      conditions.push(`created_at >= $${paramIndex++}`);
      params.push(filters.startDate);
    }

    if (filters.endDate) {
      conditions.push(`created_at <= $${paramIndex++}`);
      params.push(filters.endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitParam = paramIndex++;
    const offsetParam = paramIndex++;

    const result = await queryRead(
      `SELECT ${BATCH_OPERATION_SELECT_COLUMNS}
       FROM batch_operations
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      [...params, limit, offset],
    );

    return result.rows.map(mapBatchOperationRow).filter((op): op is BatchOperation => op !== null);
  }

  async count(filters: BatchOperationFilters = {}): Promise<number> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (filters.provider) {
      conditions.push(`provider = $${paramIndex++}`);
      params.push(filters.provider);
    }

    if (filters.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(filters.status);
    }

    if (filters.operationType) {
      conditions.push(`operation_type = $${paramIndex++}`);
      params.push(filters.operationType);
    }

    if (filters.startDate) {
      conditions.push(`created_at >= $${paramIndex++}`);
      params.push(filters.startDate);
    }

    if (filters.endDate) {
      conditions.push(`created_at <= $${paramIndex++}`);
      params.push(filters.endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await queryRead(
      `SELECT COUNT(*)::int AS total FROM batch_operations ${whereClause}`,
      params,
    );

    return result.rows[0]?.total ?? 0;
  }
}

export class BatchItemModel {
  async create(data: CreateBatchItemData): Promise<BatchItem> {
    const result = await queryWrite(
      `INSERT INTO batch_items (
        batch_id, transaction_id, reference_id, phone_number,
        amount, status, max_retries, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING ${BATCH_ITEM_SELECT_COLUMNS}`,
      [
        data.batchId,
        data.transactionId || null,
        data.referenceId,
        data.phoneNumber || null,
        data.amount || null,
        BatchItemStatus.Pending,
        data.maxRetries || 3,
        JSON.stringify(data.metadata || {}),
      ],
    );

    const item = mapBatchItemRow(result.rows[0]);
    if (!item) {
      throw new Error("Failed to create batch item");
    }

    return item;
  }

  async findById(id: string): Promise<BatchItem | null> {
    const result = await queryRead(
      `SELECT ${BATCH_ITEM_SELECT_COLUMNS}
       FROM batch_items
       WHERE id = $1`,
      [id],
    );

    return mapBatchItemRow(result.rows[0]);
  }

  async findByBatchId(batchId: string): Promise<BatchItem[]> {
    const result = await queryRead(
      `SELECT ${BATCH_ITEM_SELECT_COLUMNS}
       FROM batch_items
       WHERE batch_id = $1
       ORDER BY created_at ASC`,
      [batchId],
    );

    return result.rows.map(mapBatchItemRow).filter((item): item is BatchItem => item !== null);
  }

  async findByReferenceId(batchId: string, referenceId: string): Promise<BatchItem | null> {
    const result = await queryRead(
      `SELECT ${BATCH_ITEM_SELECT_COLUMNS}
       FROM batch_items
       WHERE batch_id = $1 AND reference_id = $2`,
      [batchId, referenceId],
    );

    return mapBatchItemRow(result.rows[0]);
  }

  async findByTransactionId(transactionId: string): Promise<BatchItem[]> {
    const result = await queryRead(
      `SELECT ${BATCH_ITEM_SELECT_COLUMNS}
       FROM batch_items
       WHERE transaction_id = $1
       ORDER BY created_at DESC`,
      [transactionId],
    );

    return result.rows.map(mapBatchItemRow).filter((item): item is BatchItem => item !== null);
  }

  async updateStatus(
    id: string,
    status: BatchItemStatus,
    errorMessage?: string,
    providerReference?: string,
  ): Promise<BatchItem | null> {
    const result = await queryWrite(
      `UPDATE batch_items
       SET status = $1,
           error_message = $2,
           provider_reference = $3,
           processed_at = CASE WHEN $4 IN ('completed', 'failed') THEN CURRENT_TIMESTAMP ELSE processed_at END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5
       RETURNING ${BATCH_ITEM_SELECT_COLUMNS}`,
      [status, errorMessage || null, providerReference || null, status, id],
    );

    return mapBatchItemRow(result.rows[0]);
  }

  async incrementRetryCount(id: string): Promise<BatchItem | null> {
    const result = await queryWrite(
      `UPDATE batch_items
       SET retry_count = retry_count + 1,
           status = 'retrying',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING ${BATCH_ITEM_SELECT_COLUMNS}`,
      [id],
    );

    return mapBatchItemRow(result.rows[0]);
  }

  async list(
    limit = 50,
    offset = 0,
    filters: BatchItemFilters = {},
  ): Promise<BatchItem[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (filters.batchId) {
      conditions.push(`batch_id = $${paramIndex++}`);
      params.push(filters.batchId);
    }

    if (filters.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(filters.status);
    }

    if (filters.transactionId) {
      conditions.push(`transaction_id = $${paramIndex++}`);
      params.push(filters.transactionId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitParam = paramIndex++;
    const offsetParam = paramIndex++;

    const result = await queryRead(
      `SELECT ${BATCH_ITEM_SELECT_COLUMNS}
       FROM batch_items
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      [...params, limit, offset],
    );

    return result.rows.map(mapBatchItemRow).filter((item): item is BatchItem => item !== null);
  }

  async getFailedItemsForRetry(batchId: string): Promise<BatchItem[]> {
    const result = await queryRead(
      `SELECT ${BATCH_ITEM_SELECT_COLUMNS}
       FROM batch_items
       WHERE batch_id = $1
         AND status = 'failed'
         AND retry_count < max_retries
       ORDER BY created_at ASC`,
      [batchId],
    );

    return result.rows.map(mapBatchItemRow).filter((item): item is BatchItem => item !== null);
  }

  async count(filters: BatchItemFilters = {}): Promise<number> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (filters.batchId) {
      conditions.push(`batch_id = $${paramIndex++}`);
      params.push(filters.batchId);
    }

    if (filters.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(filters.status);
    }

    if (filters.transactionId) {
      conditions.push(`transaction_id = $${paramIndex++}`);
      params.push(filters.transactionId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await queryRead(
      `SELECT COUNT(*)::int AS total FROM batch_items ${whereClause}`,
      params,
    );

    return result.rows[0]?.total ?? 0;
  }

  async getBatchSummary(batchId: string): Promise<{
    total: number;
    completed: number;
    failed: number;
    pending: number;
    retrying: number;
  }> {
    const result = await queryRead(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
         COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
         COUNT(*) FILTER (WHERE status = 'retrying')::int AS retrying
       FROM batch_items
       WHERE batch_id = $1`,
      [batchId],
    );

    return result.rows[0] || { total: 0, completed: 0, failed: 0, pending: 0, retrying: 0 };
  }
}
