import { CorsOptions } from "cors";

export const DEFAULT_CORS_MAX_AGE = 86400;

export function getCorsMaxAge(rawValue = process.env.CORS_MAX_AGE): number {
  const parsed = Number.parseInt(rawValue ?? "", 10);

  if (Number.isNaN(parsed) || parsed < 0) {
    return DEFAULT_CORS_MAX_AGE;
  }

  return parsed;
}

export function createCorsOptions(): CorsOptions {
  return {
    maxAge: getCorsMaxAge(),
  };
}
