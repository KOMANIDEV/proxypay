import { Router } from "express";
import { StatsController } from "../controllers/statsController";
import { requireAuth } from "../middleware/auth";

export const statsRoutes = Router();

/**
 * @route   GET /api/stats
 * @desc    Get system statistics and metrics
 * @access  Private (Admin)
 */
statsRoutes.get("/", requireAuth, StatsController.getStats);
