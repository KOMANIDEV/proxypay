import { Request, Response } from "express";
import { z } from "zod";
import {
  BatchOperationModel,
  BatchItemModel,
  BatchOperationStatus,
  BatchItemStatus,
  WebhookStatus,
} from "../models/batchOperation";
import { TransactionModel } from "../models/transaction";

const batchOperationModel = new BatchOperationModel();
const batchItemModel = new BatchItemModel();
const transactionModel = new TransactionModel();

// Validation schemas
const batchOperationQuerySchema = z.object({
  provider: z.string().optional(),
  status: z.enum(["pending", "processing", "completed", "failed", "partial"]).optional(),
  operationType: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
});

const batchItemQuerySchema = z.object({
  status: z.enum(["pending", "processing", "completed", "failed", "retrying"]).optional(),
  transactionId: z.string().optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
});

const retryBatchSchema = z.object({
  batchId: z.string().uuid(),
});

const retryItemSchema = z.object({
  itemId: z.string().uuid(),
});

/**
 * GET /api/batch-operations
 * List batch operations with optional filters
 */
export async function listBatchOperations(req: Request, res: Response): Promise<void> {
  try {
    const validationResult = batchOperationQuerySchema.safeParse(req.query);
    if (!validationResult.success) {
      res.status(400).json({
        error: "Invalid query parameters",
        details: validationResult.error.errors,
      });
      return;
    }

    const { provider, status, operationType, startDate, endDate, limit, offset } = validationResult.data;
    const limitNum = limit ? parseInt(limit, 10) : 50;
    const offsetNum = offset ? parseInt(offset, 10) : 0;

    const filters: any = {};
    if (provider) filters.provider = provider;
    if (status) filters.status = status as BatchOperationStatus;
    if (operationType) filters.operationType = operationType;
    if (startDate) filters.startDate = new Date(startDate);
    if (endDate) filters.endDate = new Date(endDate);

    const operations = await batchOperationModel.list(limitNum, offsetNum, filters);
    const total = await batchOperationModel.count(filters);

    res.json({
      data: operations,
      pagination: {
        limit: limitNum,
        offset: offsetNum,
        total,
      },
    });
  } catch (error) {
    console.error("Error listing batch operations:", error);
    res.status(500).json({
      error: "Failed to list batch operations",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * GET /api/batch-operations/:id
 * Get detailed batch operation by ID
 */
export async function getBatchOperation(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const operation = await batchOperationModel.findById(id);
    if (!operation) {
      res.status(404).json({
        error: "Batch operation not found",
      });
      return;
    }

    // Get batch items summary
    const summary = await batchItemModel.getBatchSummary(id);

    res.json({
      data: {
        ...operation,
        summary,
      },
    });
  } catch (error) {
    console.error("Error getting batch operation:", error);
    res.status(500).json({
      error: "Failed to get batch operation",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * GET /api/batch-operations/:id/items
 * List items in a batch operation
 */
export async function listBatchItems(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const validationResult = batchItemQuerySchema.safeParse(req.query);
    if (!validationResult.success) {
      res.status(400).json({
        error: "Invalid query parameters",
        details: validationResult.error.errors,
      });
      return;
    }

    const { status, transactionId, limit, offset } = validationResult.data;
    const limitNum = limit ? parseInt(limit, 10) : 50;
    const offsetNum = offset ? parseInt(offset, 10) : 0;

    const filters: any = { batchId: id };
    if (status) filters.status = status as BatchItemStatus;
    if (transactionId) filters.transactionId = transactionId;

    const items = await batchItemModel.list(limitNum, offsetNum, filters);
    const total = await batchItemModel.count(filters);

    res.json({
      data: items,
      pagination: {
        limit: limitNum,
        offset: offsetNum,
        total,
      },
    });
  } catch (error) {
    console.error("Error listing batch items:", error);
    res.status(500).json({
      error: "Failed to list batch items",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * GET /api/batch-operations/:id/items/:itemId
 * Get detailed batch item
 */
export async function getBatchItem(req: Request, res: Response): Promise<void> {
  try {
    const { itemId } = req.params;

    const item = await batchItemModel.findById(itemId);
    if (!item) {
      res.status(404).json({
        error: "Batch item not found",
      });
      return;
    }

    // Get transaction details if available
    let transaction = null;
    if (item.transactionId) {
      transaction = await transactionModel.findById(item.transactionId);
    }

    res.json({
      data: {
        ...item,
        transaction,
      },
    });
  } catch (error) {
    console.error("Error getting batch item:", error);
    res.status(500).json({
      error: "Failed to get batch item",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * GET /api/batch-operations/reference/:batchReference
 * Get batch operation by reference
 */
export async function getBatchOperationByReference(req: Request, res: Response): Promise<void> {
  try {
    const { batchReference } = req.params;

    const operation = await batchOperationModel.findByBatchReference(batchReference);
    if (!operation) {
      res.status(404).json({
        error: "Batch operation not found",
      });
      return;
    }

    const summary = await batchItemModel.getBatchSummary(operation.id);

    res.json({
      data: {
        ...operation,
        summary,
      },
    });
  } catch (error) {
    console.error("Error getting batch operation by reference:", error);
    res.status(500).json({
      error: "Failed to get batch operation",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * POST /api/batch-operations/:id/retry
 * Retry failed items in a batch operation
 */
export async function retryBatchOperation(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const operation = await batchOperationModel.findById(id);
    if (!operation) {
      res.status(404).json({
        error: "Batch operation not found",
      });
      return;
    }

    if (operation.status !== BatchOperationStatus.Failed && operation.status !== BatchOperationStatus.Partial) {
      res.status(400).json({
        error: "Can only retry failed or partially completed batches",
      });
      return;
    }

    const failedItems = await batchItemModel.getFailedItemsForRetry(id);

    if (failedItems.length === 0) {
      res.json({
        message: "No failed items available for retry",
        data: {
          retriedCount: 0,
        },
      });
      return;
    }

    // Update batch operation status to processing
    await batchOperationModel.updateStatus(id, BatchOperationStatus.Processing);

    // Increment retry count and set status to retrying for each item
    for (const item of failedItems) {
      await batchItemModel.incrementRetryCount(item.id);
    }

    res.json({
      message: "Batch retry initiated",
      data: {
        batchId: id,
        retriedCount: failedItems.length,
        items: failedItems.map(item => ({
          id: item.id,
          referenceId: item.referenceId,
          retryCount: item.retryCount + 1,
        })),
      },
    });
  } catch (error) {
    console.error("Error retrying batch operation:", error);
    res.status(500).json({
      error: "Failed to retry batch operation",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * POST /api/batch-items/:id/retry
 * Retry a single failed batch item
 */
export async function retryBatchItem(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const item = await batchItemModel.findById(id);
    if (!item) {
      res.status(404).json({
        error: "Batch item not found",
      });
      return;
    }

    if (item.status !== BatchItemStatus.Failed) {
      res.status(400).json({
        error: "Can only retry failed items",
      });
      return;
    }

    if (item.retryCount >= item.maxRetries) {
      res.status(400).json({
        error: "Maximum retry limit reached",
        data: {
          retryCount: item.retryCount,
          maxRetries: item.maxRetries,
        },
      });
      return;
    }

    const updatedItem = await batchItemModel.incrementRetryCount(id);

    res.json({
      message: "Batch item retry initiated",
      data: updatedItem,
    });
  } catch (error) {
    console.error("Error retrying batch item:", error);
    res.status(500).json({
      error: "Failed to retry batch item",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * GET /api/batch-operations/:id/summary
 * Get detailed summary of batch operation
 */
export async function getBatchOperationSummary(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const operation = await batchOperationModel.findById(id);
    if (!operation) {
      res.status(404).json({
        error: "Batch operation not found",
      });
      return;
    }

    const summary = await batchItemModel.getBatchSummary(id);
    const items = await batchItemModel.list(1000, 0, { batchId: id });

    // Group items by status
    const itemsByStatus = items.reduce((acc: any, item) => {
      if (!acc[item.status]) {
        acc[item.status] = [];
      }
      acc[item.status].push(item);
      return acc;
    }, {});

    res.json({
      data: {
        operation,
        summary,
        itemsByStatus,
      },
    });
  } catch (error) {
    console.error("Error getting batch operation summary:", error);
    res.status(500).json({
      error: "Failed to get batch operation summary",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
