import { Router, Request, Response } from "express";
import { receiptTemplateService } from "../services/receiptTemplateService";
import { authenticateToken } from "../middleware/auth";
import { TimeoutPresets, haltOnTimedout } from "../middleware/timeout";
import { createError } from "../middleware/errorHandler";
import { ERROR_CODES } from "../constants/errorCodes";
import { z } from "zod";

export const receiptTemplateRoutes = Router();

const brandingSchema = z
  .object({
    businessName: z.string().max(200).optional().nullable(),
    logoUrl: z.string().url().max(1000).optional().nullable(),
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().nullable(),
    accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().nullable(),
    footerText: z.string().max(500).optional().nullable(),
    address: z.string().max(500).optional().nullable(),
    phoneNumber: z.string().max(50).optional().nullable(),
    website: z.string().url().max(500).optional().nullable(),
  })
  .passthrough();

const upsertTemplateSchema = z.object({
  merchantId: z.string().uuid().optional().nullable(),
  name: z.string().max(100).optional(),
  htmlBody: z.string().min(1).max(200000),
  plainBody: z.string().max(100000).optional().nullable(),
  branding: brandingSchema.optional(),
  activate: z.boolean().optional(),
});

const activateSchema = z.object({
  name: z.string().min(1).max(100),
  version: z.number().int().min(1),
});

function getMerchantId(req: Request): string | null {
  const body = req.body as any;
  return body?.merchantId ?? (req as any).user?.merchantId ?? null;
}

// Create or update (new version) of a receipt template
receiptTemplateRoutes.post(
  "/",
  TimeoutPresets.quick,
  haltOnTimedout,
  authenticateToken,
  async (req: Request, res: Response) => {
    const parsed = upsertTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid template payload", details: parsed.error.flatten() });
    }
    const input = parsed.data;
    const template = await receiptTemplateService.saveTemplate({
      merchantId: input.merchantId ?? null,
      name: input.name,
      htmlBody: input.htmlBody,
      plainBody: input.plainBody ?? null,
      branding: input.branding,
      createdBy: (req as any).user?.id ?? null,
      activate: input.activate,
    });
    res.status(201).json(template);
  },
);

// List active templates for a merchant
receiptTemplateRoutes.get(
  "/",
  TimeoutPresets.quick,
  haltOnTimedout,
  authenticateToken,
  async (req: Request, res: Response) => {
    const merchantId = (req.query.merchantId as string) ?? getMerchantId(req);
    const templates = await receiptTemplateService.listTemplates(merchantId ?? null);
    res.json({ templates });
  },
);

// List versions for a template name
receiptTemplateRoutes.get(
  "/versions",
  TimeoutPresets.quick,
  haltOnTimedout,
  authenticateToken,
  async (req: Request, res: Response) => {
    const merchantId = (req.query.merchantId as string) ?? getMerchantId(req);
    const name = req.query.name as string;
    if (!name) {
      return res.status(400).json({ error: "Missing required query param: name" });
    }
    const versions = await receiptTemplateService.listTemplateVersions(merchantId ?? null, name);
    res.json({ versions });
  },
);

// Activate a specific version of a template
receiptTemplateRoutes.post(
  "/activate",
  TimeoutPresets.quick,
  haltOnTimedout,
  authenticateToken,
  async (req: Request, res: Response) => {
    const parsed = activateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid activation payload", details: parsed.error.flatten() });
    }
    const merchantId = req.body?.merchantId ?? getMerchantId(req);
    const template = await receiptTemplateService.activateTemplate(
      merchantId ?? null,
      parsed.data.name,
      parsed.data.version,
    );
    if (!template) {
      throw createError(ERROR_CODES.NOT_FOUND, "Template version not found", { error: "Template version not found" });
    }
    res.json(template);
  },
);

// Delete a template version
receiptTemplateRoutes.delete(
  "/:id",
  TimeoutPresets.quick,
  haltOnTimedout,
  authenticateToken,
  async (req: Request, res: Response) => {
    const deleted = await receiptTemplateService.deleteTemplate(req.params.id);
    if (!deleted) {
      throw createError(ERROR_CODES.NOT_FOUND, "Template not found", { error: "Template not found" });
    }
    res.status(204).end();
  },
);
