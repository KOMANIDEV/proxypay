import {
  compareTranslations,
  areTranslationsInSync,
  flattenCatalog,
} from "../locales/translationManager";

describe("translationManager", () => {
  it("flattens nested catalogs into dot-separated keys", () => {
    const catalog = {
      errors: {
        INVALID_INPUT: "Invalid input",
        nested: { DEEP: "deep value" },
      },
    };

    expect(flattenCatalog(catalog)).toEqual({
      "errors.INVALID_INPUT": "Invalid input",
      "errors.nested.DEEP": "deep value",
    });
  });

  it("reports no drift when all error catalogs match the English source", () => {
    expect(areTranslationsInSync()).toBe(true);
  });

  it("reports no missing or extra error keys for every supported locale", () => {
    const results = compareTranslations();

    expect(results).toHaveLength(4);

    for (const result of results) {
      expect(result.missingKeys).toEqual([]);
      expect(result.extraKeys).toEqual([]);
    }
  });
});
