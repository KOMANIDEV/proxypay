#!/usr/bin/env tsx
/**
 * Translation Validation & Management Script
 *
 * Ensures every locale file (fr, es, pt, sw) stays in sync with the English
 * source of truth (en.json). Run as part of CI or the translation workflow so
 * new error codes / messages are never left untranslated silently.
 *
 * Usage:
 *   tsx src/scripts/validate-translations.ts          # check (exit 1 on drift)
 *   tsx src/scripts/validate-translations.ts --list   # print key differences
 *
 * Exit codes:
 *   0 - all locales in sync
 *   1 - at least one locale is missing or has extra keys
 */

import {
  compareTranslations,
  summarizeTranslationDifferences,
} from "../locales/translationManager";

const args = process.argv.slice(2);
const listOnly = args.includes("--list");

const results = compareTranslations();

const hasDrift = results.some(
  (result) => result.missingKeys.length > 0 || result.extraKeys.length > 0,
);

console.log(summarizeTranslationDifferences());

if (listOnly) {
  if (!hasDrift) {
    console.log("\nAll locales are in sync with en.json.");
  }
  process.exit(hasDrift ? 1 : 0);
}

if (hasDrift) {
  console.error(
    "\nTranslation drift detected. Update src/locales/*.json so every locale " +
      "matches the keys in en.json (see missing keys above).",
  );
  process.exit(1);
}

console.log("\nAll locales are in sync with en.json.");
