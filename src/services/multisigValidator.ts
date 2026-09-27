import * as StellarSdk from "stellar-sdk";

export interface SignerConfig {
  publicKey: string;
  weight: number;
}

export interface MultisigThresholdConfig {
  low: number;
  medium: number;
  high: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  totalWeight: number;
  thresholds: MultisigThresholdConfig;
}

export interface PreflightResult {
  canSign: boolean;
  currentWeight: number;
  requiredWeight: number;
  missingWeight: number;
  signerBreakdown: {
    publicKey: string;
    weight: number;
    hasSigned: boolean;
  }[];
}

// ─── Threshold Validation ─────────────────────────────────────────────────────

export function validateMultisigThresholds(
  masterWeight: number,
  signers: SignerConfig[],
  thresholds: MultisigThresholdConfig,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const totalWeight = masterWeight + signers.reduce((sum, s) => sum + s.weight, 0);

  if (totalWeight <= 0) {
    errors.push("Total weight of all signers must be greater than zero");
  }

  if (masterWeight <= 0) {
    warnings.push("Master key weight is zero — the account cannot be controlled by the master key alone");
  }

  const maxThreshold = Math.max(thresholds.low, thresholds.medium, thresholds.high);

  if (maxThreshold > totalWeight) {
    errors.push(
      `Highest threshold (${maxThreshold}) exceeds total available weight (${totalWeight}). ` +
      `Transactions at this level would be impossible to sign.`
    );
  }

  if (thresholds.low > totalWeight) {
    errors.push(`Low threshold (${thresholds.low}) exceeds total weight (${totalWeight})`);
  }

  if (thresholds.medium > totalWeight) {
    errors.push(`Medium threshold (${thresholds.medium}) exceeds total weight (${totalWeight})`);
  }

  if (thresholds.high > totalWeight) {
    errors.push(`High threshold (${thresholds.high}) exceeds total weight (${totalWeight})`);
  }

  if (thresholds.low > thresholds.medium) {
    warnings.push("Low threshold is greater than medium threshold — this is unusual");
  }

  if (thresholds.medium > thresholds.high) {
    warnings.push("Medium threshold is greater than high threshold — this is unusual");
  }

  const duplicateKeys = signers
    .map((s) => s.publicKey)
    .filter((key, idx, arr) => arr.indexOf(key) !== idx);

  if (duplicateKeys.length > 0) {
    errors.push(`Duplicate signer keys found: ${duplicateKeys.join(", ")}`);
  }

  if (signers.length === 0 && masterWeight < thresholds.low) {
    errors.push(
      `No additional signers configured and master weight (${masterWeight}) is below low threshold (${thresholds.low})`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    totalWeight,
    thresholds,
  };
}

// ─── Pre-flight Check ─────────────────────────────────────────────────────────

export async function preflightMultisigCheck(
  accountId: string,
  desiredThresholds: MultisigThresholdConfig,
  desiredSigners?: SignerConfig[],
  serverUrl: string = "https://horizon.stellar.org",
): Promise<PreflightResult> {
  const server = new StellarSdk.Horizon.Server(serverUrl);

  const account = await server.loadAccount(accountId);
  const masterWeight = (account as any).thresholds?.master_weight ?? 1;

  const currentSigners: SignerConfig[] = [];

  if (masterWeight > 0) {
    currentSigners.push({ publicKey: accountId, weight: masterWeight });
  }

  if ((account as any).signers) {
    for (const signer of (account as any).signers) {
      if (signer.type === "ed25519_public_key" && signer.key !== accountId) {
        currentSigners.push({ publicKey: signer.key, weight: signer.weight });
      }
    }
  }

  const signersToUse = desiredSigners || currentSigners;
  const totalWeight = masterWeight + signersToUse
    .filter((s) => s.publicKey !== accountId)
    .reduce((sum, s) => sum + s.weight, 0);

  const currentThresholds: MultisigThresholdConfig = {
    low: (account as any).thresholds?.low_threshold ?? 0,
    medium: (account as any).thresholds?.med_threshold ?? 0,
    high: (account as any).thresholds?.high_threshold ?? 0,
  };

  const requiredWeight = Math.max(
    desiredThresholds.low,
    desiredThresholds.medium,
    desiredThresholds.high,
  );

  return {
    canSign: totalWeight >= requiredWeight,
    currentWeight: totalWeight,
    requiredWeight,
    missingWeight: Math.max(0, requiredWeight - totalWeight),
    signerBreakdown: signersToUse.map((s) => ({
      publicKey: s.publicKey,
      weight: s.weight,
      hasSigned: false,
    })),
  };
}

// ─── Signature Weight Calculator ──────────────────────────────────────────────

export function calculateSignatureWeight(
  signatures: string[],
  signers: SignerConfig[],
  serverPublicKey: string,
): number {
  let weight = 0;
  for (const sig of signatures) {
    const signer = signers.find((s) => s.publicKey === sig);
    if (signer && signer.publicKey !== serverPublicKey) {
      weight += signer.weight;
    }
  }
  return weight;
}

export function meetsThreshold(
  signatureWeight: number,
  operationType: "low" | "medium" | "high",
  thresholds: MultisigThresholdConfig,
): boolean {
  switch (operationType) {
    case "low":
      return signatureWeight >= thresholds.low;
    case "medium":
      return signatureWeight >= thresholds.medium;
    case "high":
      return signatureWeight >= thresholds.high;
    default:
      return false;
  }
}
