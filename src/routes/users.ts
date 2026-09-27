import { Request, Response, Router, NextFunction } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { optimizeProfileImage, upload } from "../middleware/upload";
import { uploadToS3 } from "../services/s3Upload";
import { gateUpload, linkStoredKey } from "../services/fileSecurityService";
import { pool } from "../config/database";
import { UserModel } from "../models/users";
import {
  getWithdrawal2FASettings,
  updateMandatory2FAWithdrawals,
  verifyWithdrawal2FA,
} from "../controllers/twoFactorWithdrawalController";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

const router = Router();
const userModel = new UserModel();

const updateDisplayNameSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(1, "displayName is required")
    .max(120, "displayName must be 120 characters or fewer"),
});

router.post(
  "/profile-picture",
  requireAuth,
  upload.single("avatar"),
  // Scan the original upload before sharp re-encodes it, so embedded malware
  // can't slip through into storage.
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.file) return next();

    const security = await gateUpload(req.file, {
      userId: req.user?.id ?? null,
    });
    if (security.outcome === "infected") {
      throw createError(
        ERROR_CODES.INVALID_INPUT,
        "Upload rejected: file failed the security scan",
        { error: security.reason },
      );
    }
    if (security.outcome === "quarantined") {
      throw createError(
        ERROR_CODES.INVALID_INPUT,
        "Upload quarantined: scan engine unavailable, please retry later",
        { error: security.reason },
      );
    }
    if (security.outcome === "error" || !security.record) {
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Upload security scan failed",
        { error: security.reason },
      );
    }

    res.locals.securityRecord = security.record;
    next();
  },
  optimizeProfileImage,
  async (req: Request, res: Response) => {
    try {
      const file = req.file;
      const userId = req.user?.id ?? "";

      if (!file) {
         throw createError(ERROR_CODES.INVALID_INPUT, "No image provided" , {
          error: "No image provided" ,
        });
      }

      const uploadResult = await uploadToS3({
        userId,
        file,
        metadata: { type: "profile_picture" },
      });

      if (!uploadResult.success) {
        throw createError(ERROR_CODES.INTERNAL_ERROR, uploadResult.error, {
          error: uploadResult.error,
        });
      }

      // Attach the stored key to the security record for integrity audits.
      if (uploadResult.success && uploadResult.key && res.locals.securityRecord) {
        await linkStoredKey(
          res.locals.securityRecord.id,
          uploadResult.key,
        ).catch((err: unknown) => {
          console.error("Failed to link security record to S3 key:", err);
        });
      }

      const avatarUrl = uploadResult.fileUrl;

      const updateQuery = `
        UPDATE users
        SET profile_url = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING id, profile_url;
      `;
      await pool.query(updateQuery, [avatarUrl, userId]);

      res.status(200).json({
        message: "Profile picture uploaded successfully",
        data: { url: avatarUrl },
      });
    } catch (error) {
      console.error("Controller upload error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Internal server error during upload",
        {
          error: "Internal server error during upload",
        },
      );
    }
  },
);

router.put(
  "/profile/display-name",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user || user.role !== "merchant") {
        throw createError(ERROR_CODES.FORBIDDEN, "Only merchants can set a display name", {
          error: "Only merchants can set a display name",
        });
      }

      const parsed = updateDisplayNameSchema.safeParse(req.body);
      if (!parsed.success) {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation failed", {
          error: "Validation failed",
          details: parsed.error.issues,
        });
      }

      const userId = user.id;
      await userModel.updateDisplayName(userId, parsed.data.displayName);

      return res.status(200).json({
        message: "Merchant display name updated successfully",
        data: { displayName: parsed.data.displayName },
      });
    } catch (error) {
      console.error("Controller display-name update error:", error);
      throw error;
    }
  },
);

// 2FA Withdrawal Settings Routes
router.get("/2fa/withdrawals", requireAuth, getWithdrawal2FASettings);
router.put("/2fa/withdrawals", requireAuth, updateMandatory2FAWithdrawals);
router.post("/2fa/withdrawals/verify", requireAuth, verifyWithdrawal2FA);

export { router as userRoutes };
