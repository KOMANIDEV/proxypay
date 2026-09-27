# PII Encryption Key Rotation

How versioned AES-256-GCM keys are managed for PII fields (`src/crypto/encryption.ts`),
how to re-encrypt existing data, and how the scheduled rotation watcher works.

## Key ring

`getKeyRing()` resolves keys at call time from the environment, which lets a new
key be added without a redeploy:

| Variable                 | Purpose                                       |
| ------------------------ | --------------------------------------------- |
| `PII_ENCRYPTION_KEY`     | Bootstrap / legacy key (version `legacy`).    |
| `PII_ENCRYPTION_KEY_V2`  | One variable per version (`v2`, `v3`, …).     |
| `PII_ENCRYPTION_KEYS`    | JSON map `{"v1":"<secret>","v2":"<secret>"}`. |
| `ACTIVE_PII_KEY_VERSION` | Version used to encrypt **new** data.         |

`DB_ENCRYPTION_KEY`, `DB_ENCRYPTION_KEY_<VERSION>` and `DB_ENCRYPTION_KEYS` are
honoured as fallbacks so the PII key ring can share configuration with
`src/utils/encryption.ts`.

Ciphertext is self-describing:

```
<version>:<iv_hex>:<authTag_hex>:<ciphertext_hex>
```

`decryptVersioned()` tries the declared version first, then every other key in
the ring, so data stays readable while a rotation is still in progress.

## Rotation procedure

1. **Provision the new key** and add both versions to the ring:

   ```env
   PII_ENCRYPTION_KEYS={"v1":"<old>","v2":"<new>"}
   ACTIVE_PII_KEY_VERSION=v2
   ```

   New writes now use `v2`; reads of `v1` data keep working.

2. **Re-encrypt existing rows** with the migration script:

   ```bash
   # Preview what would change
   npx tsx src/scripts/rotate-encryption-keys.ts --dry-run

   # Re-encrypt all configured PII columns
   npx tsx src/scripts/rotate-encryption-keys.ts

   # Or a single table/column
   npx tsx src/scripts/rotate-encryption-keys.ts --table=users --column=email
   ```

   Flags: `--target-version=<v>`, `--table=<name>`, `--column=<name>`,
   `--batch-size=<n>` (default 500), `--limit=<n>`, `--dry-run`.
   Targets default to the `transactions` PII columns and can be overridden with
   the `KEY_ROTATION_TARGETS` JSON array.

   The script is idempotent — rows already on the target version are skipped.

3. **Retire the old key** only once the migration reports zero failures and you
   have verified that no `v1` ciphertext remains.

> Always take a backup before running the migration. The sweep rewrites
> encrypted columns in place and is only reversible with the previous key.

## Scheduled rotation

The `encryption-key-rotation` job (`src/jobs/keyRotationJob.ts`) runs weekly
(`ENCRYPTION_KEY_ROTATION_CRON`, default `0 4 * * 0`) and:

- validates the key ring and logs warnings/errors,
- detects rotation when `ACTIVE_PII_KEY_VERSION` changed since the last run,
- re-runs the migration script so existing rows follow the new key,
- persists the last rotation timestamp (Redis when available).

When the configured interval (`ENCRYPTION_KEY_ROTATION_INTERVAL_DAYS`, default 90) elapses, the job logs that a rotation is due. Set
`ENCRYPTION_KEY_AUTO_MIGRATE=true` to also run the re-encryption sweep on
interval expiry.

## Tests

- `tests/crypto/encryptionKeyRotation.test.ts` — versioning, fallback and rotation primitives.
- `tests/scripts/rotate-encryption-keys.test.ts` — migration tool.
- `tests/jobs/keyRotationJob.test.ts` — scheduling decisions.

## Operational note

`validateKeyRingConfig()` fails fast when `ACTIVE_PII_KEY_VERSION` is not present
in the ring, so a typo cannot silently fall back to the legacy key.
