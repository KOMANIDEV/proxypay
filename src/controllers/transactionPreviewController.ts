import { NextFunction, Request, Response } from "express";
import { z } from "zod";
import {
  transactionPreviewService,
  PreviewValidationError,
} from "../services/transactionPreviewService";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

/**
 * Transaction preview endpoint.
 *
 * `POST /api/transactions/preview` simulates a deposit/withdrawal and returns
 * estimated fees, limits and validation results WITHOUT creating any records.
 */

export const transactionPreviewSchema = z.object({
  type: z.enum(["deposit", "withdraw"], {
    message: "type must be deposit or withdraw",
  }),
  amount: z
    .number()
    .positive({ message: "Amount must be a positive number" }),
  phoneNumber: z
    .string()
    .regex(/^\+?\d{10,15}$/, { message: "Invalid phone number format" }),
  provider: z.enum(["mtn", "airtel", "orange"], {
    message: "Provider must be mtn, airtel, or orange",
  }),
  stellarAddress: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, { message: "Invalid Stellar address format" }),
  userId: z.string().nonempty({ message: "userId is required" }).optional(),
  notes: z
    .string()
    .max(256, { message: "Note cannot exceed 256 characters" })
    .optional(),
});

function zodMessage(err: unknown): string {
  if (
    err &&
    typeof err === "object" &&
    "errors" in err &&
    Array.isArray((err as any).errors)
  ) {
    const messages = (err as any).errors
      .map((e: any) => e.message)
      .filter(Boolean);
    if (messages.length) return messages.join(", ");
  }
  return "Invalid input";
}

export const validateTransactionPreview = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    transactionPreviewSchema.parse(req.body);
    next();
  } catch (err: any) {
    throw createError(ERROR_CODES.MISSING_FIELD, zodMessage(err), {
      error: zodMessage(err),
    });
  }
};

export const previewTransactionHandler = async (
  req: Request,
  res: Response,
) => {
  try {
    const body = transactionPreviewSchema.parse(req.body);
    const userId = body.userId || (req as any).jwtUser?.userId;

    if (!userId) {
      throw createError(
        ERROR_CODES.MISSING_FIELD,
        "userId is required",
        { error: "userId is required" },
      );
    }

    const preview = await transactionPreviewService.previewTransaction({
      type: body.type,
      amount: body.amount,
      phoneNumber: body.phoneNumber,
      provider: body.provider,
      stellarAddress: body.stellarAddress,
      userId,
    });

    // A preview is advisory — return 200 with the full validation breakdown
    // even when `valid` is false so the client can surface every reason.
    return res.status(200).json(preview);
  } catch (err) {
    if (err instanceof PreviewValidationError) {
      throw createError(ERROR_CODES.INVALID_AMOUNT, err.message, {
        error: err.message,
      });
    }
    if (
      err &&
      typeof err === "object" &&
      "errors" in err &&
      Array.isArray((err as any).errors)
    ) {
      const message = zodMessage(err);
      throw createError(ERROR_CODES.MISSING_FIELD, message, {
        error: message,
      });
    }
    throw err;
  }
};
