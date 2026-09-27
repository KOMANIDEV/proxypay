/**
 * Translation Gap Detection Job
 *
 * Schedule: daily (configurable via TRANSLATION_GAP_DETECTION_CRON)
 *
 * Provider error messages fall back to English when a locale translation is
 * missing. That keeps users from seeing raw provider codes, but it hides the
 * gap. This job scans the provider error catalog for codes that exist in the
 * English source of truth but are missing from any other locale, merges in
 * gaps observed live at runtime, and logs the result so translators can close
 * them.
 */

import {
  providerErrorMapService,
  TranslationGap,
} from "../services/providerErrorMap";
import logger from "../utils/logger";

export interface TranslationGapReport {
  generatedAt: string;
  /** Codes missing from a locale catalog, independent of runtime traffic. */
  staticGaps: TranslationGap[];
  /** Gaps observed while serving live requests since the last job run. */
  runtimeGaps: TranslationGap[];
  /** Deduplicated list of every gap that still needs a translation. */
  gaps: TranslationGap[];
}

function gapKey(gap: TranslationGap): string {
  return `${gap.locale}:${gap.code}`;
}

/**
 * Static gap detection: codes present in English but missing from other locales.
 */
export function detectTranslationGaps(): TranslationGap[] {
  return providerErrorMapService.detectTranslationGaps();
}

/**
 * Combines the static catalog scan with live runtime gaps, deduplicated.
 */
export function buildTranslationGapReport(): TranslationGapReport {
  const staticGaps = providerErrorMapService.detectTranslationGaps();
  const runtimeGaps = providerErrorMapService.getTranslationGaps();

  const seen = new Set(staticGaps.map(gapKey));
  const gaps = [...staticGaps];

  for (const gap of runtimeGaps) {
    const key = gapKey(gap);
    if (!seen.has(key)) {
      seen.add(key);
      gaps.push(gap);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    staticGaps,
    runtimeGaps,
    gaps,
  };
}

/**
 * Job entry point. Safe to run on a schedule; never throws for gaps — it only
 * reports them so the scheduler does not treat translations as an outage.
 */
export async function runTranslationGapDetectionJob(): Promise<TranslationGapReport> {
  const report = buildTranslationGapReport();

  if (report.gaps.length === 0) {
    logger.info("Provider error translation gap detection: no gaps detected");
  } else {
    logger.warn(
      { totalGaps: report.gaps.length, gaps: report.gaps },
      "Provider error translation gaps detected",
    );
  }

  console.log(
    `[translation-gaps] Detected ${report.gaps.length} missing provider error translation(s)`,
  );

  return report;
}
