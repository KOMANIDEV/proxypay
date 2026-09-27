import { Request, Response, NextFunction } from "express";

/**
 * Middleware that detects mobile clients, enables field selection filtering,
 * and optimizes JSON payload size for mobile bandwidth constraints.
 */
export function mobileOptimizationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const userAgent = req.headers["user-agent"] || "";
  const isMobileClient =
    req.headers["x-client-type"] === "mobile" ||
    req.query.mobile === "true" ||
    /Mobile|Android|iPhone|iPad|iPod|Opera Mini|IEMobile/i.test(userAgent);

  // Expose mobile flag on request
  (req as any).isMobileClient = isMobileClient;

  // Intercept res.json to prune fields if `fields` query parameter is provided or if minimal mode requested
  const originalJson = res.json.bind(res);
  res.json = (body: any): Response => {
    if (body && typeof body === "object") {
      const fieldsParam = (req.query.fields as string) || (req.query.select as string);
      const isMinimal = req.query.minimal === "true" || (isMobileClient && req.query.format === "compact");

      if (fieldsParam) {
        const allowedFields = new Set(fieldsParam.split(",").map((f) => f.trim()));
        body = pruneObjectFields(body, allowedFields);
      } else if (isMinimal && Array.isArray(body.data)) {
        // Automatically prune verbose metadata on lists for minimal mobile mode
        body.data = body.data.map((item: any) => {
          if (item && typeof item === "object") {
            const { metadata, internal_notes, timeline, ...core } = item;
            return core;
          }
          return item;
        });
      }
    }

    if (isMobileClient) {
      res.setHeader("X-Mobile-Optimized", "true");
    }

    return originalJson(body);
  };

  next();
}

function pruneObjectFields(obj: any, allowedFields: Set<string>): any {
  if (Array.isArray(obj)) {
    return obj.map((item) => pruneObjectFields(item, allowedFields));
  }
  if (obj !== null && typeof obj === "object") {
    // If it's a wrapper like { data: [...], pagination: {...} }
    if (obj.data) {
      return {
        ...obj,
        data: pruneObjectFields(obj.data, allowedFields),
      };
    }
    const result: Record<string, any> = {};
    for (const key of Object.keys(obj)) {
      if (allowedFields.has(key)) {
        result[key] = obj[key];
      }
    }
    return Object.keys(result).length > 0 ? result : obj;
  }
  return obj;
}
