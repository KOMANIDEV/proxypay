import { Router, Response } from "express";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { CrossChainMonitorService } from "../services/crossChainMonitorService";

const router = Router();

router.get(
  "/balances",
  requireAuth,
  (_req: AuthRequest, res: Response) => {
    const snapshots = CrossChainMonitorService.getInstance().getLastSnapshot();
    res.json(snapshots);
  },
);

router.get(
  "/health",
  requireAuth,
  (_req: AuthRequest, res: Response) => {
    const health = CrossChainMonitorService.getInstance().getSystemHealthSummary();
    res.json(health);
  },
);

router.get(
  "/health/:chain",
  requireAuth,
  (req: AuthRequest, res: Response) => {
    const chainHealth = CrossChainMonitorService.getInstance().getChainHealth(req.params.chain);
    if (!chainHealth) {
      return res.status(404).json({ error: `Chain '${req.params.chain}' not found` });
    }
    res.json(chainHealth);
  },
);

export default router;
