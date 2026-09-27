/**
 * #403 – Transaction Metadata Field Indexing Routes
 *
 * GET /api/transactions/metadata/search   – field-equality or FTS search
 * GET /api/transactions/metadata/facets   – faceted metadata search (#477)
 * GET /api/transactions/metadata/keys     – searchable metadata keys (#477)
 * GET /api/transactions/metadata/stats    – index usage stats (admin)
 * GET /api/transactions/metadata/benchmark – run benchmark (admin)
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { authenticateToken } from "../middleware/auth";
import {
  queryByMetadataField,
  searchMetadataFullText,
  getMetadataIndexStats,
  runMetadataBenchmark,
  getSearchQualityMetrics,
} from "../services/transactionMetadataService";
import {
  DEFAULT_FACET_KEYS,
  searchMetadataFacets,
  discoverMetadataKeys,
} from "../services/metadataFacetsService";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

const router = Router();

// ─── GET /search ──────────────────────────────────────────────────────────────

const SearchQuerySchema = z.object({
  mode: z.enum(["field", "fts"]).default("field"),
  field: z.string().regex(/^[a-z_]+$/, "field must be lowercase letters/underscores").optional(),
  value: z.string().optional(),
  q: z.string().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
  min_relevance: z.coerce.number().min(0).max(1).optional(),
  ranking: z.enum(["bm25", "ts_rank", "ts_rank_cd"]).optional(),
});

router.get("/search", authenticateToken, async (req: Request, res: Response) => {
  const userId = req.jwtUser?.userId;
  if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Not authenticated");

  const parsed = SearchQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Invalid query parameters", {
      errors: parsed.error.errors,
    });
  }

  const { mode, field, value, q, status, limit, offset, min_relevance, ranking } = parsed.data;

  if (mode === "field") {
    if (!field || !value) {
      throw createError(
        ERROR_CODES.INVALID_INPUT,
        "mode=field requires both 'field' and 'value' query parameters",
      );
    }

    const result = await queryByMetadataField({
      field,
      value,
      userId,
      status,
      limit,
      offset,
    });

    return res.json({
      data: result.data,
      meta: {
        total: result.total,
        limit,
        offset,
        queryTimeMs: result.queryTimeMs,
        cached: result.cached,
      },
    });
  }

  // FTS mode
  if (!q) {
    throw createError(
      ERROR_CODES.INVALID_INPUT,
      "mode=fts requires a 'q' query parameter",
    );
  }

  const result = await searchMetadataFullText({
    query: q,
    userId,
    status,
    limit,
    offset,
    minRelevance: min_relevance,
    rankingMethod: ranking,
  });

  res.json({
    data: result.data,
    meta: {
      total: result.total,
      limit,
      offset,
      queryTimeMs: result.queryTimeMs,
      cached: result.cached,
      pagination: result.pagination,
      minRelevanceApplied: result.minRelevanceApplied,
    },
  });
});

// ─── GET /quality ─────────────────────────────────────────────────────────────

router.get("/quality", authenticateToken, async (_req: Request, res: Response) => {
  const metrics = getSearchQualityMetrics();
  res.json({ data: metrics });
});

// ─── GET /stats ───────────────────────────────────────────────────────────────

router.get("/stats", authenticateToken, async (_req: Request, res: Response) => {
  const stats = await getMetadataIndexStats();
  res.json({ data: stats });
});

// ─── GET /benchmark ───────────────────────────────────────────────────────────

router.get("/benchmark", authenticateToken, async (req: Request, res: Response) => {
  const field = (req.query.field as string) || "provider";
  const value = (req.query.value as string) || "mtn";
  const query = (req.query.q as string) || "mobile deposit";

  const result = await runMetadataBenchmark(field, value, query);
  res.json({ data: result });
});

// ─── GET /facets (#477) ───────────────────────────────────────────────────────

const FacetQuerySchema = z.object({
  q: z.string().optional(),
  // Comma-separated metadata keys; defaults to the standard facet set.
  facets: z.string().optional(),
  // Metadata equality filters as key=value pairs, comma separated.
  filters: z.string().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
  facet_limit: z.coerce.number().int().min(1).max(25).default(10),
});

router.get("/facets", authenticateToken, async (req: Request, res: Response) => {
  const userId = req.jwtUser?.userId;
  if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Not authenticated");

  const parsed = FacetQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Invalid facet query");
  }
  const { q, facets, filters, status, limit, offset, facet_limit } = parsed.data;

  const facetKeys = facets
    ? facets.split(",").map((f) => f.trim()).filter(Boolean)
    : undefined;

  // Reject an unknown facet key here rather than letting it produce an empty
  // facet list, which is indistinguishable from "no values for this facet".
  for (const key of facetKeys ?? DEFAULT_FACET_KEYS) {
    if (!/^[a-z0-9_]{1,64}$/.test(key)) {
      throw createError(ERROR_CODES.INVALID_INPUT, `Invalid facet key: ${key}`);
    }
  }

  const metadataFilters: Record<string, string> = {};
  for (const pair of filters?.split(",").filter(Boolean) ?? []) {
    const separator = pair.indexOf("=");
    if (separator < 1) {
      throw createError(
        ERROR_CODES.INVALID_INPUT,
        `Invalid filter "${pair}". Expected key=value`,
      );
    }
    metadataFilters[pair.slice(0, separator).trim()] = pair
      .slice(separator + 1)
      .trim();
  }

  const result = await searchMetadataFacets({
    query: q,
    facets: facetKeys,
    filters: metadataFilters,
    userId,
    status,
    limit,
    offset,
    facetLimit: facet_limit,
  });

  res.json({ data: result });
});

// ─── GET /keys (#477) ─────────────────────────────────────────────────────────

router.get("/keys", authenticateToken, async (req: Request, res: Response) => {
  const userId = req.jwtUser?.userId;
  if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Not authenticated");

  const limit = Math.min(Number(req.query.limit) || 25, 25);
  const keys = await discoverMetadataKeys(userId, limit);
  res.json({ data: keys, meta: { availableFacets: DEFAULT_FACET_KEYS } });
});

export default router;
