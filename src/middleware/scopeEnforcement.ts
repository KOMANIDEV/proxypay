import { Request, Response, NextFunction } from 'express';
import { ApiKeyScope, ApiKeyScopeValue, ApiKeyScopeName, describeScopes } from '../auth/apikeys';

// re-export for convenience
export { ApiKeyScope };

/**
 * Middleware factory: require at least one of the listed scopes.
 * If the request was authenticated via JWT (not API key), it passes through.
 */
export function requireScope(...scopes: ApiKeyScopeValue[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const permissions = (req as any).apiKeyPermissions;

    // If no API key permissions on request (JWT auth), allow through
    if (permissions === undefined) {
      return next();
    }

    const granted = scopes.some((scope) => (permissions & scope) === scope);
    if (!granted) {
      const required = scopes.map((s) => {
        const entry = Object.entries(ApiKeyScope).find(([, v]) => v === s);
        return entry ? entry[0] : `0x${s.toString(16)}`;
      });
      res.status(403).json({
        error: 'Forbidden',
        message: `Insufficient API key scope. Required: ${required.join(' OR ')}`,
        requiredScopes: required,
        grantedScopes: describeScopes(permissions),
      });
      return;
    }
    next();
  };
}

/**
 * Middleware factory: require ALL of the listed scopes.
 */
export function requireAllScopes(...scopes: ApiKeyScopeValue[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const permissions = (req as any).apiKeyPermissions;

    if (permissions === undefined) {
      return next();
    }

    const missing = scopes.filter((scope) => (permissions & scope) !== scope);
    if (missing.length > 0) {
      const missingNames = missing.map((s) => {
        const entry = Object.entries(ApiKeyScope).find(([, v]) => v === s);
        return entry ? entry[0] : `0x${s.toString(16)}`;
      });
      res.status(403).json({
        error: 'Forbidden',
        message: `Insufficient API key scope. Missing: ${missingNames.join(', ')}`,
        missingScopes: missingNames,
        grantedScopes: describeScopes(permissions),
      });
      return;
    }
    next();
  };
}

/**
 * Audit logger for scope violations — logs to console (replace with structured logger if needed)
 */
export function logScopeViolation(req: Request, requiredScope: string, grantedScopes: string[]): void {
  console.warn('[SCOPE_VIOLATION]', {
    method: req.method,
    path: req.originalUrl,
    ip: req.ip,
    requiredScope,
    grantedScopes,
    timestamp: new Date().toISOString(),
  });
}
