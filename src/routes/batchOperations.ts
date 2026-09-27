import { Router } from "express";
import {
  listBatchOperations,
  getBatchOperation,
  listBatchItems,
  getBatchItem,
  getBatchOperationByReference,
  retryBatchOperation,
  retryBatchItem,
  getBatchOperationSummary,
} from "../controllers/batchOperationController";

export const batchOperationRoutes = Router();

/**
 * Batch Operations Routes
 * 
 * These endpoints provide detailed status tracking for batch operations,
 * including per-item status, error messages, and retry capabilities.
 */

// List all batch operations with optional filters
batchOperationRoutes.get("/", listBatchOperations);

// Get batch operation by ID
batchOperationRoutes.get("/:id", getBatchOperation);

// Get batch operation by reference
batchOperationRoutes.get("/reference/:batchReference", getBatchOperationByReference);

// Get detailed summary of batch operation
batchOperationRoutes.get("/:id/summary", getBatchOperationSummary);

// List items in a batch operation
batchOperationRoutes.get("/:id/items", listBatchItems);

// Get specific batch item
batchOperationRoutes.get("/:id/items/:itemId", getBatchItem);

// Retry failed items in a batch operation
batchOperationRoutes.post("/:id/retry", retryBatchOperation);

// Retry a single failed batch item
batchOperationRoutes.post("/items/:id/retry", retryBatchItem);
