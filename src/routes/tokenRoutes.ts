import express from "express";
import { tokenController } from "../controllers/tokenController";
import { authenticateToken } from "../middleware/auth";

const tokenRoutes = express.Router();

tokenRoutes.get("/", authenticateToken, tokenController.findAll);
tokenRoutes.delete("/:tokenId", authenticateToken, tokenController.revoke);
tokenRoutes.post("/revoke-all", authenticateToken, tokenController.revokeAll);
tokenRoutes.post(
  "/purge-expired",
  authenticateToken,
  tokenController.purgeExpired,
);

export { tokenRoutes };
