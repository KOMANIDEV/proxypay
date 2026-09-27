/**
 * Multi-signature threshold enforcement tests (Issue #624).
 *
 * `StellarService.signTransactionWithThreshold` must compute the signing weight
 * from the source account's signers and refuse to sign when the account
 * threshold is not met.
 */
import * as StellarSdk from "stellar-sdk";

jest.mock("../../../src/config/stellar", () => ({
  getStellarServer: () => ({ loadAccount: jest.fn() }),
  getNetworkPassphrase: () => "Test SDF Network ; September 2015",
}));

jest.mock("../../../src/services/sanctionService", () => ({
  sanctionService: { checkParties: jest.fn(), checkPartiesByAddress: jest.fn() },
}));

import {
  StellarService,
  MultisigThresholdError,
} from "../../../src/services/stellar/stellarService";

const NETWORK = "Test SDF Network ; September 2015";
const MASTER = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const SIGNER_1 = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
const SIGNER_2 = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3));
const UNKNOWN = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4));
const DESTINATION = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));

function buildTransaction(): StellarSdk.Transaction {
  const account = new StellarSdk.Account(MASTER.publicKey(), "1");
  return new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: NETWORK,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination: DESTINATION.publicKey(),
        asset: StellarSdk.Asset.native(),
        amount: "1",
      }),
    )
    .setTimeout(30)
    .build();
}

function accountFixture(overrides: Record<string, unknown> = {}) {
  return {
    thresholds: {
      master_weight: 1,
      low_threshold: 1,
      med_threshold: 2,
      high_threshold: 3,
    },
    signers: [
      { type: "ed25519_public_key", key: SIGNER_1.publicKey(), weight: 1 },
      { type: "ed25519_public_key", key: SIGNER_2.publicKey(), weight: 1 },
    ],
    ...overrides,
  };
}

function makeService(account: Record<string, unknown>) {
  delete process.env.STELLAR_ISSUER_SECRET;
  const service = new StellarService();
  (service as any).server = { loadAccount: jest.fn().mockResolvedValue(account) };
  return service;
}

describe("StellarService.signTransactionWithThreshold (#624)", () => {
  it("rejects when the combined signature weight is below the medium threshold", async () => {
    const service = makeService(accountFixture());
    const tx = buildTransaction();

    await expect(
      service.signTransactionWithThreshold(tx, [SIGNER_1]),
    ).rejects.toBeInstanceOf(MultisigThresholdError);

    expect(tx.signatures).toHaveLength(0);
  });

  it("exposes the weight breakdown on the thrown error", async () => {
    const service = makeService(accountFixture());
    const tx = buildTransaction();

    await expect(
      service.signTransactionWithThreshold(tx, [SIGNER_1], "high"),
    ).rejects.toMatchObject({
      requiredWeight: 3,
      signatureWeight: 1,
      thresholdLevel: "high",
    });
  });

  it("signs when the combined weight meets the threshold", async () => {
    const service = makeService(accountFixture());
    const tx = buildTransaction();

    const result = await service.signTransactionWithThreshold(tx, [
      SIGNER_1,
      SIGNER_2,
    ]);

    expect(result.signed).toBe(true);
    expect(result.signatureWeight).toBe(2);
    expect(result.requiredWeight).toBe(2);
    expect(tx.signatures).toHaveLength(2);
  });

  it("counts the master key weight when master_weight is positive", async () => {
    const service = makeService(accountFixture());
    const tx = buildTransaction();

    // low threshold = 1, satisfied by the master key alone
    const result = await service.signTransactionWithThreshold(tx, [MASTER], "low");

    expect(result.masterWeight).toBe(1);
    expect(result.signatureWeight).toBe(1);
    expect(result.requiredWeight).toBe(1);
    expect(result.signed).toBe(true);
  });

  it("ignores the master key when master_weight is zero", async () => {
    const service = makeService(
      accountFixture({
        thresholds: {
          master_weight: 0,
          low_threshold: 1,
          med_threshold: 2,
          high_threshold: 2,
        },
        signers: [
          { type: "ed25519_public_key", key: SIGNER_1.publicKey(), weight: 2 },
        ],
      }),
    );
    const tx = buildTransaction();

    await expect(
      service.signTransactionWithThreshold(tx, [MASTER]),
    ).rejects.toMatchObject({ signatureWeight: 0 });

    const okTx = buildTransaction();
    const result = await service.signTransactionWithThreshold(okTx, [SIGNER_1]);
    expect(result.signed).toBe(true);
    expect(result.signatureWeight).toBe(2);
  });

  it("does not double count duplicate signatures", async () => {
    const service = makeService(accountFixture());
    const tx = buildTransaction();

    await expect(
      service.signTransactionWithThreshold(tx, [SIGNER_1, SIGNER_1]),
    ).rejects.toMatchObject({ signatureWeight: 1 });
  });

  it("does not count unknown signers", async () => {
    const service = makeService(accountFixture());
    const tx = buildTransaction();

    await expect(
      service.signTransactionWithThreshold(tx, [UNKNOWN]),
    ).rejects.toMatchObject({ signatureWeight: 0 });
  });

  it("allows signing when the account requires no weight", async () => {
    const service = makeService(
      accountFixture({
        thresholds: {
          master_weight: 1,
          low_threshold: 0,
          med_threshold: 0,
          high_threshold: 0,
        },
      }),
    );
    const tx = buildTransaction();

    const result = await service.signTransactionWithThreshold(tx, []);

    expect(result.signed).toBe(true);
    expect(result.signatureWeight).toBe(0);
    expect(tx.signatures).toHaveLength(0);
  });
});
