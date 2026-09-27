import { Router, Request, Response } from "express";
import { z } from "zod";
import { compareProviderFees } from "../services/feeRoutingService";

const router = Router();

const compareSchema = z.object({
  amount: z.number().positive("amount must be a positive number"),
  userId: z.string().uuid().optional(),
  evaluationTime: z.string().datetime().optional(),
});

/**
 * POST /api/fee-routing/compare
 *
 * Compares the active fee strategy for every eligible mobile-money provider
 * and recommends the lowest-cost route.
 */
router.post("/compare", async (req: Request, res: Response) => {
  const payload = compareSchema.safeParse(req.body);
  if (!payload.success) {
    res.status(400).json({
      success: false,
      error: "Validation error",
      details: payload.error.issues,
    });
    return;
  }

  try {
    const result = await compareProviderFees(
      payload.data.amount,
      payload.data.userId,
      payload.data.evaluationTime
        ? new Date(payload.data.evaluationTime)
        : undefined,
    );
    res.json({ success: true, data: result });
  } catch (error) {
    console.error("[FeeRouting] comparison error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to compare provider fees",
    });
  }
});

export default router;
