/**
 * SEP-30 key recovery edge cases (#572)
 *
 * The recovery flow is the one path in the product where the normal rules do
 * not apply: it exists to take a key away from its current signers, so at every
 * step the code is defending against a legitimate signer acting against the
 * interest of the key. That makes the boundary conditions the interesting part
 * rather than the happy path — one active session, the signer floor, a signer
 * removed mid-ceremony, a threshold changed under a live session.
 *
 * Not executed in this change and not wired into CI. Included as executable
 * specification.
 */

import * as StellarSdk from "stellar-sdk";
import { sep30Service } from "../../src/services/sep30/sep30Service";
import { pool } from "../../src/config/database";

jest.mock("../../src/config/database");

const mockPool = pool as jest.Mocked<typeof pool>;

const KEY_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "user-1";
const SESSION_ID = "22222222-2222-2222-2222-222222222222";

/** A registered signer, as `mapRecoverySigner` expects to receive it. */
const signerRow = (publicKey: string) => ({
  id: `signer-${publicKey.slice(0, 8)}`,
  managed_key_id: KEY_ID,
  signer_public_key: publicKey,
  signer_label: "Signer",
  created_at: new Date(),
});

const managedKeyRow = (overrides: Record<string, any> = {}) => ({
  id: KEY_ID,
  user_id: USER_ID,
  public_key: StellarSdk.Keypair.random().publicKey(),
  recovery_threshold: 2,
  is_active: true,
  created_at: new Date(),
  updated_at: new Date(),
  ...overrides,
});

const sessionRow = (overrides: Record<string, any> = {}) => ({
  id: SESSION_ID,
  managed_key_id: KEY_ID,
  state: "pending",
  required_approvals: 2,
  approved_by: [],
  requested_new_address: null,
  initiated_by_ip: null,
  expires_at: new Date(Date.now() + 30 * 60 * 1000),
  old_public_key: "GOLD",
  rejected_reason: null,
  created_at: new Date(),
  updated_at: new Date(),
  completed_at: null,
  ...overrides,
});

const future = () => new Date(Date.now() + 30 * 60 * 1000);
const past = () => new Date(Date.now() - 60 * 1000);

/**
 * Route each SQL statement to a canned result.
 *
 * The service issues many small queries in a fixed order, so matching on a
 * distinctive fragment of each statement is more robust than counting calls.
 */
function mockQueries(handlers: Array<[RegExp, any]>) {
  mockPool.query.mockImplementation((sql: string, params?: any[]) => {
    for (const [pattern, rows] of handlers) {
      if (pattern.test(sql)) {
        return Promise.resolve({ rows: Array.isArray(rows) ? rows : [rows], rowCount: 1 });
      }
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

describe("SEP-30 recovery signer management (#572)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("signer set bounds (1..15)", () => {
    it("accepts the first signer on a key that has none", async () => {
      // A key with no signers has no recovery path. Refusing the first signer
      // would leave the operator with no way to ever add one.
      const key = StellarSdk.Keypair.random();
      mockQueries([
        [/SELECT[\s\S]*FROM managed_keys/, managedKeyRow()],
        [/SELECT[\s\S]*FROM recovery_signers/, []],
        [/INSERT INTO recovery_signers/, signerRow(key.publicKey())],
      ]);

      const signer = await sep30Service.addRecoverySigner(
        KEY_ID,
        USER_ID,
        key.publicKey(),
        "First",
      );

      expect(signer.signerPublicKey).toBe(key.publicKey());
    });

    it("rejects a 16th signer", async () => {
      const full = Array.from({ length: 15 }, () => signerRow(StellarSdk.Keypair.random().publicKey()));
      mockQueries([
        [/SELECT[\s\S]*FROM managed_keys/, managedKeyRow()],
        [/SELECT[\s\S]*FROM recovery_signers/, full],
      ]);

      await expect(
        sep30Service.addRecoverySigner(
          KEY_ID,
          USER_ID,
          StellarSdk.Keypair.random().publicKey(),
          "Sixteenth",
        ),
      ).rejects.toThrow(/maximum of 15 recovery signers/);
    });

    it("accepts the 15th signer", async () => {
      const nearly = Array.from({ length: 14 }, () => signerRow(StellarSdk.Keypair.random().publicKey()));
      const key = StellarSdk.Keypair.random();
      mockQueries([
        [/SELECT[\s\S]*FROM managed_keys/, managedKeyRow()],
        [/SELECT[\s\S]*FROM recovery_signers/, nearly],
        [/INSERT INTO recovery_signers/, signerRow(key.publicKey())],
      ]);

      await expect(
        sep30Service.addRecoverySigner(KEY_ID, USER_ID, key.publicKey(), "Fifteenth"),
      ).resolves.toBeDefined();
    });

    it("rejects a duplicate signer rather than storing the key twice", async () => {
      const existing = StellarSdk.Keypair.random().publicKey();
      mockQueries([
        [/SELECT[\s\S]*FROM managed_keys/, managedKeyRow()],
        [/SELECT[\s\S]*FROM recovery_signers/, [signerRow(existing)]],
      ]);

      await expect(
        sep30Service.addRecoverySigner(KEY_ID, USER_ID, existing, "Duplicate"),
      ).rejects.toThrow(/already a recovery signer/);
    });

    it("rejects a malformed signer key before touching the database", async () => {
      mockQueries([[/SELECT[\s\S]*FROM managed_keys/, managedKeyRow()]]);

      await expect(
        sep30Service.addRecoverySigner(KEY_ID, USER_ID, "not-a-key", "Bad"),
      ).rejects.toThrow(/Invalid Stellar public key/);

      expect(mockPool.query).not.toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO recovery_signers"),
        expect.anything(),
      );
    });
  });

  describe("signer removal", () => {
    it("refuses to remove a signer during an active session", async () => {
      // Removing a signer mid-ceremony can leave a session that can no longer
      // reach its threshold while still holding the one-active-session slot, so
      // the recovery cannot be restarted either.
      const signers = [
        signerRow(StellarSdk.Keypair.random().publicKey()),
        signerRow(StellarSdk.Keypair.random().publicKey()),
        signerRow(StellarSdk.Keypair.random().publicKey()),
      ];
      mockQueries([
        [/SELECT[\s\S]*FROM managed_keys/, managedKeyRow({ recovery_threshold: 2 })],
        [/SELECT[\s\S]*FROM recovery_signers/, signers],
        [/SELECT id FROM key_recovery_sessions/, [{ id: SESSION_ID }]],
      ]);

      await expect(
        sep30Service.removeRecoverySigner(
          KEY_ID,
          USER_ID,
          signers[0].signer_public_key,
        ),
      ).rejects.toThrow(/recovery session .* is in progress/);
    });

    it("refuses to remove the signer that would break the threshold", async () => {
      const signers = [
        signerRow(StellarSdk.Keypair.random().publicKey()),
        signerRow(StellarSdk.Keypair.random().publicKey()),
      ];
      mockQueries([
        [/SELECT[\s\S]*FROM managed_keys/, managedKeyRow({ recovery_threshold: 2 })],
        [/SELECT[\s\S]*FROM recovery_signers/, signers],
        [/SELECT id FROM key_recovery_sessions/, []],
      ]);

      await expect(
        sep30Service.removeRecoverySigner(
          KEY_ID,
          USER_ID,
          signers[0].signer_public_key,
        ),
      ).rejects.toThrow(/threshold is 2/);
    });

    it("refuses to remove the last signer, enforcing the floor of one", async () => {
      // Threshold 1 with a single signer: removing it would leave a key with no
      // recovery path at all.
      const signers = [signerRow(StellarSdk.Keypair.random().publicKey())];
      mockQueries([
        [/SELECT[\s\S]*FROM managed_keys/, managedKeyRow({ recovery_threshold: 1 })],
        [/SELECT[\s\S]*FROM recovery_signers/, signers],
        [/SELECT id FROM key_recovery_sessions/, []],
      ]);

      await expect(
        sep30Service.removeRecoverySigner(
          KEY_ID,
          USER_ID,
          signers[0].signer_public_key,
        ),
      ).rejects.toThrow(/threshold is 1/);
    });

    it("allows a removal that leaves the threshold satisfiable", async () => {
      const signers = [
        signerRow(StellarSdk.Keypair.random().publicKey()),
        signerRow(StellarSdk.Keypair.random().publicKey()),
        signerRow(StellarSdk.Keypair.random().publicKey()),
      ];
      mockQueries([
        [/SELECT[\s\S]*FROM managed_keys/, managedKeyRow({ recovery_threshold: 2 })],
        [/SELECT[\s\S]*FROM recovery_signers/, signers],
        [/SELECT id FROM key_recovery_sessions/, []],
        [/DELETE FROM recovery_signers/, { rowCount: 1 }],
      ]);

      await expect(
        sep30Service.removeRecoverySigner(
          KEY_ID,
          USER_ID,
          signers[0].signer_public_key,
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe("threshold changes", () => {
    it("refuses a threshold above the signer count", async () => {
      // A threshold nobody can reach is a key that cannot be recovered, set up
      // deliberately by the operator.
      mockQueries([
        [/SELECT[\s\S]*FROM managed_keys/, managedKeyRow()],
        [/SELECT[\s\S]*FROM recovery_signers/, [signerRow(StellarSdk.Keypair.random().publicKey())]],
      ]);

      await expect(
        sep30Service.updateRecoveryThreshold(KEY_ID, USER_ID, 3),
      ).rejects.toThrow(/exceeds registered signer count 1/);
    });

    it("refuses a threshold below one", async () => {
      mockQueries([
        [/SELECT[\s\S]*FROM managed_keys/, managedKeyRow()],
        [/SELECT[\s\S]*FROM recovery_signers/, []],
      ]);

      await expect(sep30Service.updateRecoveryThreshold(KEY_ID, USER_ID, 0)).rejects.toThrow(
        /at least 1/,
      );
    });

    it("accepts raising the threshold to the signer count", async () => {
      const signers = [
        signerRow(StellarSdk.Keypair.random().publicKey()),
        signerRow(StellarSdk.Keypair.random().publicKey()),
      ];
      mockQueries([
        [/SELECT[\s\S]*FROM managed_keys/, managedKeyRow()],
        [/SELECT[\s\S]*FROM recovery_signers/, signers],
        [/UPDATE managed_keys/, { rowCount: 1 }],
      ]);

      await expect(sep30Service.updateRecoveryThreshold(KEY_ID, USER_ID, 2)).resolves.toBeUndefined();
    });
  });

  describe("session lifecycle", () => {
    it("refuses a second concurrent session for the same key", async () => {
      // The most important test in this file. Two open sessions means two
      // independent ceremonies against one key, each of which can rotate it.
      mockQueries([
        [/SELECT[\s\S]*FROM managed_keys[\s\S]*is_active/, managedKeyRow()],
        [/SELECT id FROM key_recovery_sessions/, [{ id: SESSION_ID }]],
      ]);

      await expect(sep30Service.openRecoverySession(KEY_ID)).rejects.toThrow(
        /active recovery session already exists/,
      );
    });

    it("allows a new session once the previous one has been decided", async () => {
      mockQueries([
        [/SELECT[\s\S]*FROM managed_keys[\s\S]*is_active/, managedKeyRow()],
        [/SELECT id FROM key_recovery_sessions/, []],
        [/INSERT INTO key_recovery_sessions/, sessionRow()],
        [/INSERT INTO key_recovery_audit/, { rowCount: 1 }],
      ]);

      const session = await sep30Service.openRecoverySession(KEY_ID);
      expect(session.id).toBe(SESSION_ID);
      expect(session.requiredApprovals).toBe(2);
    });

    it("rejects a malformed requested new address", async () => {
      mockQueries([[/SELECT[\s\S]*FROM managed_keys[\s\S]*is_active/, managedKeyRow()]]);

      await expect(
        sep30Service.openRecoverySession(KEY_ID, "not-a-stellar-key"),
      ).rejects.toThrow(/Invalid Stellar public key/);
    });

    it("refuses any action on an expired session", async () => {
      mockQueries([[/SELECT[\s\S]*FROM key_recovery_sessions[\s\S]*WHERE id/, sessionRow({ expires_at: past() })]]);

      await expect(
        sep30Service.approveRecovery(
          KEY_ID,
          SESSION_ID,
          "token",
          "c2ln",
          StellarSdk.Keypair.random().publicKey(),
        ),
      ).rejects.toThrow(/has expired/);
    });

    it("refuses any action on a completed session", async () => {
      mockQueries([
        [
          /SELECT[\s\S]*FROM key_recovery_sessions[\s\S]*WHERE id/,
          sessionRow({ state: "completed", expires_at: future() }),
        ],
      ]);

      await expect(
        sep30Service.approveRecovery(
          KEY_ID,
          SESSION_ID,
          "token",
          "c2ln",
          StellarSdk.Keypair.random().publicKey(),
        ),
      ).rejects.toThrow(/terminal state 'completed'/);
    });

    it("refuses an approval for a session belonging to another key", async () => {
      mockQueries([
        [
          /SELECT[\s\S]*FROM key_recovery_sessions[\s\S]*WHERE id/,
          sessionRow({ managed_key_id: "other-key", expires_at: future() }),
        ],
      ]);

      await expect(
        sep30Service.approveRecovery(
          KEY_ID,
          SESSION_ID,
          "token",
          "c2ln",
          StellarSdk.Keypair.random().publicKey(),
        ),
      ).rejects.toThrow(/does not belong to this managed key/);
    });

    it("refuses a second approval from the same signer", async () => {
      const signer = StellarSdk.Keypair.random().publicKey();
      mockQueries([
        [
          /SELECT[\s\S]*FROM key_recovery_sessions[\s\S]*WHERE id/,
          sessionRow({ approved_by: [signer], expires_at: future() }),
        ],
      ]);

      await expect(
        sep30Service.approveRecovery(KEY_ID, SESSION_ID, "token", "c2ln", signer),
      ).rejects.toThrow(/has already approved/);
    });

    it("refuses an approval from an unregistered signer", async () => {
      mockQueries([
        [
          /SELECT[\s\S]*FROM key_recovery_sessions[\s\S]*WHERE id/,
          sessionRow({ approved_by: [], expires_at: future() }),
        ],
        [/SELECT[\s\S]*FROM recovery_signers/, []],
      ]);

      await expect(
        sep30Service.approveRecovery(
          KEY_ID,
          SESSION_ID,
          "token",
          "c2ln",
          StellarSdk.Keypair.random().publicKey(),
        ),
      ).rejects.toThrow(/not a registered recovery signer/);
    });

    it("refuses an approval with a reused or expired token", async () => {
      mockQueries([
        [
          /SELECT[\s\S]*FROM key_recovery_sessions[\s\S]*WHERE id/,
          sessionRow({ approved_by: [], expires_at: future() }),
        ],
        [/SELECT[\s\S]*FROM recovery_signers/, [signerRow(StellarSdk.Keypair.random().publicKey())]],
        [/SELECT[\s\S]*FROM recovery_tokens/, []],
      ]);

      await expect(
        sep30Service.approveRecovery(
          KEY_ID,
          SESSION_ID,
          "token",
          "c2ln",
          StellarSdk.Keypair.random().publicKey(),
        ),
      ).rejects.toThrow(/not found, already used, or expired/);
    });

    it("refuses an approval whose signature does not verify", async () => {
      const signer = StellarSdk.Keypair.random();
      const token = "a".repeat(64);
      mockQueries([
        [
          /SELECT[\s\S]*FROM key_recovery_sessions[\s\S]*WHERE id/,
          sessionRow({ approved_by: [], expires_at: future() }),
        ],
        [/SELECT[\s\S]*FROM recovery_signers/, [signerRow(signer.publicKey())]],
        [/SELECT[\s\S]*FROM recovery_tokens/, [{ id: "t1", token_hash: "x" }]],
      ]);

      await expect(
        sep30Service.approveRecovery(
          KEY_ID,
          SESSION_ID,
          token,
          Buffer.from("not a valid signature").toString("base64"),
          signer.publicKey(),
        ),
      ).rejects.toThrow(/Invalid Stellar signature/);
    });

    it("refuses completion before the threshold is reached", async () => {
      mockQueries([
        [
          /SELECT[\s\S]*FROM key_recovery_sessions[\s\S]*WHERE id/,
          sessionRow({ state: "collecting_approvals", expires_at: future() }),
        ],
      ]);

      await expect(sep30Service.completeRecovery(KEY_ID, SESSION_ID)).rejects.toThrow(
        /Cannot complete recovery: session is in state 'collecting_approvals'/,
      );
    });

    it("refuses completion of an expired session", async () => {
      mockQueries([
        [
          /SELECT[\s\S]*FROM key_recovery_sessions[\s\S]*WHERE id/,
          sessionRow({ state: "awaiting_completion", expires_at: past() }),
        ],
      ]);

      await expect(sep30Service.completeRecovery(KEY_ID, SESSION_ID)).rejects.toThrow(
        /has expired/,
      );
    });
  });
});
