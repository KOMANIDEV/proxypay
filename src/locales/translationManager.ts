/**
 * Translation management helpers.
 *
 * Provides the tooling needed to keep locale files in sync with the
 * English source of truth (en.json). Used by the `validate:translations`
 * script and testable in isolation.
 *
 * Responsibilities:
 * - Detect missing / extra / stale keys per locale (the translation process)
 * - Scaffold missing keys from the English source (for translators)
 */

import en from "./en.json";
import fr from "./fr.json";
import sw from "./sw.json";
import es from "./es.json";
import pt from "./pt.json";

const SOURCE_LOCALE = "en";

// The namespace this manager validates. Issue scope is error messages;
// future namespaces (validation, notifications, sms, email, whatsapp) can be
// added here as their translations are completed.
const MANAGED_NAMESPACE = "errors";

export interface LocaleCatalog {
  [key: string]: string | LocaleCatalog;
}

export interface TranslationComparison {
  locale: string;
  missingKeys: string[];
  extraKeys: string[];
  path: string;
}

export const LOCALE_FILES = {
  en: { catalog: en as LocaleCatalog, path: "./en.json" },
  fr: { catalog: fr as LocaleCatalog, path: "./fr.json" },
  sw: { catalog: sw as LocaleCatalog, path: "./sw.json" },
  es: { catalog: es as LocaleCatalog, path: "./es.json" },
  pt: { catalog: pt as LocaleCatalog, path: "./pt.json" },
} as const;

export type LocaleKey = keyof typeof LOCALE_FILES;

export const SUPPORTED_TRANSLATION_LOCALES = Object.keys(
  LOCALE_FILES,
) as LocaleKey[];

/**
 * Returns the managed namespace of a catalog (e.g. the `errors` subtree).
 * Falls back to the whole catalog if the namespace is absent so that a missing
 * namespace is still reported as drift rather than crashing.
 */
function managedSubtree(catalog: LocaleCatalog): LocaleCatalog {
  const value = catalog[MANAGED_NAMESPACE];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as LocaleCatalog;
  }
  return {};
}

/**
 * Flattens a nested catalog into dot-separated keys (e.g. `errors.INVALID_INPUT`).
 */
export function flattenCatalog(
  catalog: LocaleCatalog,
  prefix = "",
): Record<string, string> {
  const flattened: Record<string, string> = {};

  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(flattened, flattenCatalog(value as LocaleCatalog, path));
    } else if (typeof value === "string") {
      flattened[path] = value;
    }
  }

  return flattened;
}

/**
 * Compares the managed namespace (errors) of every non-English locale against
 * the English source of truth and reports missing / extra keys per locale.
 */
export function compareTranslations(): TranslationComparison[] {
  const source = flattenCatalog(
    managedSubtree(LOCALE_FILES[SOURCE_LOCALE].catalog),
  );
  const sourceKeys = new Set(Object.keys(source));

  return SUPPORTED_TRANSLATION_LOCALES.filter(
    (locale) => locale !== SOURCE_LOCALE,
  ).map((locale) => {
    const target = flattenCatalog(managedSubtree(LOCALE_FILES[locale].catalog));
    const targetKeys = new Set(Object.keys(target));

    const missingKeys = [...sourceKeys].filter((key) => !targetKeys.has(key));
    const extraKeys = Object.keys(target).filter((key) => !sourceKeys.has(key));

    return {
      locale,
      missingKeys,
      extraKeys,
      path: LOCALE_FILES[locale].path,
    };
  });
}

/**
 * True when every locale has identical keys to the English source of truth.
 */
export function areTranslationsInSync(): boolean {
  return compareTranslations().every(
    (result) =>
      result.missingKeys.length === 0 && result.extraKeys.length === 0,
  );
}

/**
 * Concise human-readable summary of translation drift, ready to print.
 */
export function summarizeTranslationDifferences(): string {
  const results = compareTranslations();
  const lines: string[] = [];

  for (const result of results) {
    const total = result.missingKeys.length + result.extraKeys.length;
    lines.push(`[${result.locale}] ${result.path}`);
    lines.push(`  missing: ${result.missingKeys.join(", ") || "(none)"}`);
    lines.push(`  extra:   ${result.extraKeys.join(", ") || "(none)"}`);
    lines.push(`  total drift: ${total}`);
  }

  return lines.join("\n");
}
