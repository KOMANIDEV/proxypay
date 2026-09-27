import request from 'supertest';
import express, { Request, Response } from 'express';
import {
  requireScope,
  requireAllScopes,
  logScopeViolation,
  ApiKeyScope,
} from '../../src/middleware/scopeEnforcement';
import { describeScopes } from '../../src/auth/apikeys';

// ─── Test app factory ─────────────────────────────────────────────────────────

/**
 * Build a minimal Express app with one protected route.
 * `apiKeyPermissions` is injected directly onto `req` to simulate what
 * src/middleware/auth.ts does after a DB api_key lookup.
 */
function makeApp(
  middleware: ReturnType<typeof requireScope | typeof requireAllScopes>,
  permissions?: number,
) {
  const app = express();
  app.use(express.json());

  // Simulate auth middleware attaching permissions (or nothing for JWT auth)
  app.use((req: Request, _res: Response, next) => {
    if (permissions !== undefined) {
      (req as any).apiKeyPermissions = permissions;
    }
    next();
  });

  app.get('/protected', middleware, (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.post('/protected', middleware, (_req, res) => {
    res.status(200).json({ ok: true });
  });

  return app;
}

// ─── requireScope tests ───────────────────────────────────────────────────────

describe('requireScope middleware', () => {
  describe('when JWT auth (no apiKeyPermissions)', () => {
    it('passes through GET requests without permissions set', async () => {
      const app = makeApp(requireScope(ApiKeyScope.TRANSACTIONS_READ));
      // no permissions injected → JWT-authenticated path
      const res = await request(app).get('/protected');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('passes through POST requests without permissions set', async () => {
      const app = makeApp(requireScope(ApiKeyScope.DEPOSITS_INITIATE));
      const res = await request(app).post('/protected').send({});
      expect(res.status).toBe(200);
    });
  });

  describe('TRANSACTIONS_READ scope', () => {
    it('allows access when key has TRANSACTIONS_READ', async () => {
      const app = makeApp(
        requireScope(ApiKeyScope.TRANSACTIONS_READ),
        ApiKeyScope.TRANSACTIONS_READ,
      );
      const res = await request(app).get('/protected');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('blocks access when key lacks TRANSACTIONS_READ', async () => {
      const app = makeApp(
        requireScope(ApiKeyScope.TRANSACTIONS_READ),
        ApiKeyScope.DEPOSITS_INITIATE, // unrelated scope
      );
      const res = await request(app).get('/protected');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Forbidden');
      expect(res.body.message).toContain('TRANSACTIONS_READ');
      expect(res.body.requiredScopes).toContain('TRANSACTIONS_READ');
    });

    it('includes grantedScopes in 403 response', async () => {
      const permissions = ApiKeyScope.DEPOSITS_INITIATE | ApiKeyScope.WITHDRAWALS_READ;
      const app = makeApp(requireScope(ApiKeyScope.TRANSACTIONS_READ), permissions);
      const res = await request(app).get('/protected');
      expect(res.status).toBe(403);
      expect(res.body.grantedScopes).toEqual(
        expect.arrayContaining(['DEPOSITS_INITIATE', 'WITHDRAWALS_READ']),
      );
    });
  });

  describe('DEPOSITS_INITIATE scope', () => {
    it('allows access when key has DEPOSITS_INITIATE', async () => {
      const app = makeApp(
        requireScope(ApiKeyScope.DEPOSITS_INITIATE),
        ApiKeyScope.DEPOSITS_INITIATE,
      );
      const res = await request(app).post('/protected').send({});
      expect(res.status).toBe(200);
    });

    it('blocks access when key lacks DEPOSITS_INITIATE', async () => {
      const app = makeApp(
        requireScope(ApiKeyScope.DEPOSITS_INITIATE),
        ApiKeyScope.WITHDRAWALS_INITIATE,
      );
      const res = await request(app).post('/protected').send({});
      expect(res.status).toBe(403);
      expect(res.body.message).toContain('DEPOSITS_INITIATE');
    });
  });

  describe('WITHDRAWALS_INITIATE scope', () => {
    it('allows access when key has WITHDRAWALS_INITIATE', async () => {
      const app = makeApp(
        requireScope(ApiKeyScope.WITHDRAWALS_INITIATE),
        ApiKeyScope.WITHDRAWALS_INITIATE,
      );
      const res = await request(app).post('/protected').send({});
      expect(res.status).toBe(200);
    });

    it('blocks access when key has only WITHDRAWALS_READ (not INITIATE)', async () => {
      const app = makeApp(
        requireScope(ApiKeyScope.WITHDRAWALS_INITIATE),
        ApiKeyScope.WITHDRAWALS_READ,
      );
      const res = await request(app).post('/protected').send({});
      expect(res.status).toBe(403);
      expect(res.body.message).toContain('WITHDRAWALS_INITIATE');
    });
  });

  describe('WEBHOOKS_READ scope', () => {
    it('allows access when key has WEBHOOKS_READ', async () => {
      const app = makeApp(
        requireScope(ApiKeyScope.WEBHOOKS_READ),
        ApiKeyScope.WEBHOOKS_READ,
      );
      const res = await request(app).get('/protected');
      expect(res.status).toBe(200);
    });

    it('blocks access when key has only WEBHOOKS_WRITE (not READ)', async () => {
      const app = makeApp(
        requireScope(ApiKeyScope.WEBHOOKS_READ),
        ApiKeyScope.WEBHOOKS_WRITE,
      );
      const res = await request(app).get('/protected');
      expect(res.status).toBe(403);
    });
  });

  describe('ADMIN scope', () => {
    it('allows access when key has ADMIN', async () => {
      const app = makeApp(
        requireScope(ApiKeyScope.ADMIN),
        ApiKeyScope.ADMIN,
      );
      const res = await request(app).get('/protected');
      expect(res.status).toBe(200);
    });

    it('blocks access when key lacks ADMIN', async () => {
      const app = makeApp(
        requireScope(ApiKeyScope.ADMIN),
        ApiKeyScope.TRANSACTIONS_READ | ApiKeyScope.BALANCE_READ,
      );
      const res = await request(app).get('/protected');
      expect(res.status).toBe(403);
      expect(res.body.message).toContain('ADMIN');
    });
  });

  describe('OR semantics (multiple scopes passed)', () => {
    it('allows access when key has only the first of multiple accepted scopes', async () => {
      const app = makeApp(
        requireScope(ApiKeyScope.TRANSACTIONS_READ, ApiKeyScope.ADMIN),
        ApiKeyScope.TRANSACTIONS_READ,
      );
      const res = await request(app).get('/protected');
      expect(res.status).toBe(200);
    });

    it('allows access when key has only the second of multiple accepted scopes', async () => {
      const app = makeApp(
        requireScope(ApiKeyScope.TRANSACTIONS_READ, ApiKeyScope.ADMIN),
        ApiKeyScope.ADMIN,
      );
      const res = await request(app).get('/protected');
      expect(res.status).toBe(200);
    });

    it('blocks access when key has none of the accepted scopes', async () => {
      const app = makeApp(
        requireScope(ApiKeyScope.TRANSACTIONS_READ, ApiKeyScope.ADMIN),
        ApiKeyScope.DEPOSITS_INITIATE,
      );
      const res = await request(app).get('/protected');
      expect(res.status).toBe(403);
      expect(res.body.requiredScopes).toContain('TRANSACTIONS_READ');
      expect(res.body.requiredScopes).toContain('ADMIN');
    });

    it('error message uses OR to describe alternatives', async () => {
      const app = makeApp(
        requireScope(ApiKeyScope.DEPOSITS_INITIATE, ApiKeyScope.ADMIN),
        ApiKeyScope.TRANSACTIONS_READ,
      );
      const res = await request(app).get('/protected');
      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/DEPOSITS_INITIATE OR ADMIN/);
    });
  });

  describe('key with zero permissions (permissions = 0)', () => {
    it('blocks all scoped endpoints', async () => {
      const app = makeApp(requireScope(ApiKeyScope.TRANSACTIONS_READ), 0);
      const res = await request(app).get('/protected');
      expect(res.status).toBe(403);
    });
  });

  describe('full access key', () => {
    it('passes all scope checks', async () => {
      // FULL_ACCESS = all bits OR'd together
      const fullAccess = Object.values(ApiKeyScope).reduce((a, b) => a | b, 0);
      for (const [name, bit] of Object.entries(ApiKeyScope) as Array<[string, number]>) {
        const app = makeApp(requireScope(bit), fullAccess);
        const res = await request(app).get('/protected');
        expect(res.status).toBe(200); // every scope should pass
      }
    });
  });
});

// ─── requireAllScopes tests ───────────────────────────────────────────────────

describe('requireAllScopes middleware', () => {
  describe('when JWT auth (no apiKeyPermissions)', () => {
    it('passes through without permissions set', async () => {
      const app = makeApp(
        requireAllScopes(ApiKeyScope.TRANSACTIONS_READ, ApiKeyScope.DEPOSITS_INITIATE),
      );
      const res = await request(app).get('/protected');
      expect(res.status).toBe(200);
    });
  });

  describe('AND semantics', () => {
    it('allows access when key has all required scopes', async () => {
      const permissions =
        ApiKeyScope.TRANSACTIONS_READ |
        ApiKeyScope.DEPOSITS_INITIATE |
        ApiKeyScope.BALANCE_READ;
      const app = makeApp(
        requireAllScopes(ApiKeyScope.TRANSACTIONS_READ, ApiKeyScope.DEPOSITS_INITIATE),
        permissions,
      );
      const res = await request(app).get('/protected');
      expect(res.status).toBe(200);
    });

    it('blocks access when one required scope is missing', async () => {
      const permissions = ApiKeyScope.TRANSACTIONS_READ; // DEPOSITS_INITIATE missing
      const app = makeApp(
        requireAllScopes(ApiKeyScope.TRANSACTIONS_READ, ApiKeyScope.DEPOSITS_INITIATE),
        permissions,
      );
      const res = await request(app).get('/protected');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Forbidden');
      expect(res.body.missingScopes).toContain('DEPOSITS_INITIATE');
      expect(res.body.missingScopes).not.toContain('TRANSACTIONS_READ');
    });

    it('blocks access when all required scopes are missing', async () => {
      const app = makeApp(
        requireAllScopes(ApiKeyScope.TRANSACTIONS_READ, ApiKeyScope.DEPOSITS_INITIATE),
        ApiKeyScope.BALANCE_READ,
      );
      const res = await request(app).get('/protected');
      expect(res.status).toBe(403);
      expect(res.body.missingScopes).toContain('TRANSACTIONS_READ');
      expect(res.body.missingScopes).toContain('DEPOSITS_INITIATE');
    });

    it('includes grantedScopes in the 403 response', async () => {
      const permissions = ApiKeyScope.BALANCE_READ;
      const app = makeApp(
        requireAllScopes(ApiKeyScope.TRANSACTIONS_READ, ApiKeyScope.ADMIN),
        permissions,
      );
      const res = await request(app).get('/protected');
      expect(res.status).toBe(403);
      expect(res.body.grantedScopes).toContain('BALANCE_READ');
    });

    it('error message lists missing scope names', async () => {
      const app = makeApp(
        requireAllScopes(ApiKeyScope.WITHDRAWALS_INITIATE, ApiKeyScope.ADMIN),
        ApiKeyScope.TRANSACTIONS_READ,
      );
      const res = await request(app).get('/protected');
      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/WITHDRAWALS_INITIATE/);
      expect(res.body.message).toMatch(/ADMIN/);
    });
  });

  describe('single scope requirement', () => {
    it('allows access when single required scope is present', async () => {
      const app = makeApp(
        requireAllScopes(ApiKeyScope.WEBHOOKS_WRITE),
        ApiKeyScope.WEBHOOKS_WRITE,
      );
      const res = await request(app).get('/protected');
      expect(res.status).toBe(200);
    });

    it('blocks when single required scope is absent', async () => {
      const app = makeApp(
        requireAllScopes(ApiKeyScope.WITHDRAWALS_INITIATE),
        ApiKeyScope.DEPOSITS_INITIATE,
      );
      const res = await request(app).post('/protected').send({});
      expect(res.status).toBe(403);
    });
  });
});

// ─── logScopeViolation utility tests ─────────────────────────────────────────

describe('logScopeViolation utility', () => {
  it('calls console.warn with structured violation data', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const req = {
      method: 'POST',
      originalUrl: '/api/transactions/withdraw',
      ip: '127.0.0.1',
    } as Request;

    logScopeViolation(req, 'WITHDRAWALS_INITIATE', ['TRANSACTIONS_READ']);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [label, payload] = warnSpy.mock.calls[0];
    expect(label).toBe('[SCOPE_VIOLATION]');
    expect(payload).toMatchObject({
      method: 'POST',
      path: '/api/transactions/withdraw',
      ip: '127.0.0.1',
      requiredScope: 'WITHDRAWALS_INITIATE',
      grantedScopes: ['TRANSACTIONS_READ'],
    });
    expect(typeof payload.timestamp).toBe('string');

    warnSpy.mockRestore();
  });
});

// ─── ApiKeyScope re-export ────────────────────────────────────────────────────

describe('ApiKeyScope re-export', () => {
  it('re-exports the correct scope bitmask values', () => {
    expect(ApiKeyScope.TRANSACTIONS_READ).toBe(0x00000001);
    expect(ApiKeyScope.DEPOSITS_INITIATE).toBe(0x00000080);
    expect(ApiKeyScope.WITHDRAWALS_INITIATE).toBe(0x00000200);
    expect(ApiKeyScope.WEBHOOKS_READ).toBe(0x00002000);
    expect(ApiKeyScope.ADMIN).toBe(0x00040000);
  });
});
