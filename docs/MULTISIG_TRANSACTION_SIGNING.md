# Multi-Signature Transaction Signing (Issue #624)

## Problem

`StellarService` attached signatures to transactions (`transaction.sign(...)`)
without verifying that the combined signing weight met the source account's
threshold. An under-signed transaction was only rejected by the network with an
opaque `tx_bad_auth` result, and it was impossible to tell _which_ signer weight
was missing. When the account's master key weight had been zeroed out, its
signature was silently counted as valid.

## API

```ts
import {
  StellarService,
  MultisigThresholdError,
} from "./services/stellar/stellarService";

const service = new StellarService();

const result = await service.signTransactionWithThreshold(
  transaction, // built, unsigned StellarSdk.Transaction
  [keypairA, keypairB], // signers to attach
  "medium", // "low" | "medium" | "high" (default "medium")
);
```

Returns:

```ts
{
  signed: true,
  signatureWeight: 2,
  requiredWeight: 2,
  thresholdLevel: "medium",
  masterWeight: 1,
  signerBreakdown: [
    { publicKey: "G...", weight: 1, hasSigned: true },
    { publicKey: "G...", weight: 1, hasSigned: true }
  ]
}
```

## Behaviour

1. Loads the source account and reads `thresholds` (`master_weight`,
   `low_threshold`, `med_threshold`, `high_threshold`) plus the account signers.
2. Builds a weight table: the master key (only when `master_weight > 0`) and
   every `ed25519_public_key` signer.
3. Sums the weight of the supplied keypairs. Duplicate keypairs are counted
   once — Stellar ignores duplicate signatures. Unknown keypairs contribute `0`.
4. Compares the total against the requested threshold level.
5. Throws `MultisigThresholdError` (with `requiredWeight`, `signatureWeight`,
   `thresholdLevel` and `signerBreakdown`) when the weight is insufficient —
   **no signature is attached** in that case.
6. Otherwise signs the transaction with every supplied keypair.

## Tests

`tests/services/stellar/stellarService.multisigThreshold.test.ts` covers
insufficient weight, threshold levels, master-key weight handling (including
`master_weight = 0`), duplicate signatures, unknown signers and zero-threshold
accounts.
