import { Router } from "express";
import {
  analyticsActiveUsersHandler,
  analyticsCohortsHandler,
  analyticsOverviewHandler,
  analyticsTrendsHandler,
} from "../controllers/analyticsController";

/**
 * User activity analytics dashboard (admin).
 *
 * Aggregates the `user_events` activity stream into product analytics:
 *
 *   GET /api/admin/analytics/overview        — headline numbers (events, DAU, logins)
 *   GET /api/admin/analytics/trends          — usage trend (day/week/month)
 *   GET /api/admin/analytics/active-users    — daily active user series
 *   GET /api/admin/analytics/cohorts         — behavioral cohort retention
 *
 * Mounted behind `requireAuth` in `src/index.ts`.
 */
const router = Router();

router.get("/overview", analyticsOverviewHandler);
router.get("/trends", analyticsTrendsHandler);
router.get("/active-users", analyticsActiveUsersHandler);
router.get("/cohorts", analyticsCohortsHandler);

export default router;
