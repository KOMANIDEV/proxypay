/**
 * #480 – Advanced Transaction Filtering
 *
 *   GET    /api/transactions/filters            – list saved templates
 *   GET    /api/transactions/filters/fields     – filterable field catalogue
 *   GET    /api/transactions/filters/validate   – dry-run a filter expression
 *   GET    /api/transactions/filters/export     – export templates
 *   POST   /api/transactions/filters            – create a template
 *   POST   /api/transactions/filters/import     – import templates
 *   GET    /api/transactions/filters/:id        – fetch one template
 *   PATCH  /api/transactions/filters/:id        – update a template
 *   DELETE /api/transactions/filters/:id        – delete a template
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { authenticateToken } from "../middleware/auth";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";
import { transactionModel } from "../models/transaction";
import {
  FILTERABLE_FIELDS,
  FilterTemplateExportSchema,
  FilterTemplateSchema,
  FilterValidationError,
  compileFilterExpression,
  createFilterTemplate,
  deleteFilterTemplate,
  exportFilterTemplates,
  getFilterTemplate,
  importFilterTemplates,
  listFilterTemplates,
  parseFilterExpression,
  recordTemplateUsage,
  updateFilterTemplate,
} from "../services/transactionFilterService";

const router = Router();

router.use(authenticateToken);

/** The filterable field catalogue, so clients need not hardcode it. */
router.get("/fields", (_req: Request, res: Response) => {
  return res.json({
    data: Object.entries(FILTERABLE_FIELDS).map(([name, meta]) => ({
      name,
      kind: meta.kind,
    })),
  });
});

/**
 * Dry-run an expression: validates and compiles it without touching the
 * database, returning the SQL and bound parameters. This is how a client
 * finds out that a filter is unsupported before running it.
 */
router.post("/validate", (req: Request, res: Response) => {
  try {
    const expression = parseFilterExpression(req.body?.expression);
    const compiled = compileFilterExpression(expression);
    return res.json({
      data: { valid: true, sql: compiled.sql, parameters: compiled.params },
    });
  } catch (error) {
    if (error instanceof FilterValidationError) {
      return res.status(400).json({
        error: { code: ERROR_CODES.INVALID_INPUT, message: error.message },
      });
    }
    throw error;
  }
});

router.get("/export", async (req: Request, res: Response) => {
  const payload = await exportFilterTemplates(req.user?.id);
  // `attachment` makes the browser download rather than render the JSON.
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="transaction-filters-${new Date()
      .toISOString()
      .slice(0, 10)}.json"`,
  );
  return res.json(payload);
});

router.post("/import", async (req: Request, res: Response) => {
  const parsed = FilterTemplateExportSchema.safeParse(req.body);
  if (!parsed.success) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Invalid import payload");
  }
  const result = await importFilterTemplates(parsed.data, req.user?.id);
  return res.status(201).json({ data: result });
});

router.get("/", async (req: Request, res: Response) => {
  const templates = await listFilterTemplates(req.user?.id);
  return res.json({ data: templates });
});

router.post("/", async (req: Request, res: Response) => {
  const parsed = FilterTemplateSchema.safeParse(req.body);
  if (!parsed.success) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Invalid filter template");
  }
  try {
    const template = await createFilterTemplate(parsed.data, req.user?.id);
    return res.status(201).json({ data: template });
  } catch (error) {
    if (error instanceof FilterValidationError) {
      throw createError(ERROR_CODES.INVALID_INPUT, error.message);
    }
    throw error;
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  const template = await getFilterTemplate(req.params.id, req.user?.id);
  if (!template) {
    throw createError(ERROR_CODES.NOT_FOUND, "Filter template not found");
  }
  return res.json({ data: template });
});

router.patch("/:id", async (req: Request, res: Response) => {
  const parsed = FilterTemplateSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Invalid filter template");
  }
  try {
    const template = await updateFilterTemplate(
      req.params.id,
      parsed.data,
      req.user?.id,
    );
    if (!template) {
      throw createError(ERROR_CODES.NOT_FOUND, "Filter template not found");
    }
    return res.json({ data: template });
  } catch (error) {
    if (error instanceof FilterValidationError) {
      throw createError(ERROR_CODES.INVALID_INPUT, error.message);
    }
    throw error;
  }
});

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const deleted = await deleteFilterTemplate(req.params.id, req.user?.id);
    if (!deleted) {
      throw createError(ERROR_CODES.NOT_FOUND, "Filter template not found");
    }
    return res.json({ success: true });
  } catch (error) {
    if (error instanceof FilterValidationError) {
      throw createError(ERROR_CODES.FORBIDDEN, error.message);
    }
    throw error;
  }
});

/**
 * Apply a saved template. Recorded separately from the list route so that
 * applying a template and browsing transactions are different actions, with
 * usage tracked on the former.
 */
router.post("/:id/apply", async (req: Request, res: Response) => {
  const template = await getFilterTemplate(req.params.id, req.user?.id);
  if (!template) {
    throw createError(ERROR_CODES.NOT_FOUND, "Filter template not found");
  }

  const limit = Math.min(Number(req.body?.limit ?? 50) || 50, 200);
  const transactions = await transactionModel.list(
    limit,
    0,
    undefined,
    undefined,
    { filter: template.expression },
  );
  await recordTemplateUsage(template.id, req.user?.id, transactions.length);

  return res.json({ data: transactions, meta: { template: template.name } });
});

export default router;
